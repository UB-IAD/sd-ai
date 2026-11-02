import { setMaxListeners } from 'events';
import { encode } from 'gpt-tokenizer';
import { marked } from 'marked';
import { countTokens } from '@anthropic-ai/tokenizer';

// Provider SDKs are lazy-loaded — each session uses exactly one provider, but
// eagerly importing all of them at module load cost ~990ms (dominated by
// @google/adk at ~500ms and @openrouter/sdk at ~250ms). Module-level memoization
// means the import is paid once per worker process per provider on first call.
let _anthropicSdk;
const loadAnthropicSdk = async () => _anthropicSdk ??= (await import('@anthropic-ai/sdk')).default;
let _claudeAgentSdk;
const loadClaudeAgentSdk = async () => _claudeAgentSdk ??= await import('@anthropic-ai/claude-agent-sdk');
let _googleGenai;
const loadGoogleGenai = async () => _googleGenai ??= await import('@google/genai');
let _googleAdk;
// @google/adk logs every outbound request at INFO, and it cannot be turned off with
// config: its winston levels are numbered the other way round from winston's own
// convention (info=1, error=3), so the `level: 'error'` it configures admits INFO
// rather than filtering it. Hand it the library's no-op logger when we are meant to be
// quiet — done here, at the one place the module is loaded, so it is silenced before
// the first request goes out. Failures still reach the eval through the thrown error.
const loadGoogleAdk = async () => {
  if (_googleAdk) return _googleAdk;
  _googleAdk = await import('@google/adk');
  if (logger.isTestMode) _googleAdk.setLogger(null);
  return _googleAdk;
};
let _openRouterSdk;
const loadOpenRouterSdk = async () => _openRouterSdk ??= await import('@openrouter/sdk');
let _openRouterAgent;
const loadOpenRouterAgent = async () => _openRouterAgent ??= await import('@openrouter/agent');
let _openAiSdk;
const loadOpenAiSdk = async () => _openAiSdk ??= (await import('openai')).OpenAI;

import { AgentConfigurationManager } from './utilities/AgentConfigurationManager.js';
import { MediaStore } from './utilities/MediaStore.js';
import {
  toolResultToText,
  toolResultToBlocks,
  toOpenRouterAgentOutput,
  mediaBlocksOf,
  MediaBudget,
  hydrateMessagesForAnthropic,
  hydrateContentsForGemini,
  hydrateMessagesForOpenRouter,
  hydrateMessagesForOpenAi
} from './utilities/ToolResultFormatter.js';
import { BuiltInToolProvider, SDK_FILE_TOOL_TWINS } from './tools/BuiltInToolProvider.js';
import { DynamicToolProvider } from './tools/DynamicToolProvider.js';
import {
  createAgentTextMessage,
  createAgentProgressMessage,
  createToolCallNotificationMessage,
  createToolCallCompletedMessage,
  createAgentCompleteMessage,
  createErrorMessage
} from './utilities/MessageProtocol.js';
import logger from '../utilities/logger.js';
import config from '../config.js';
import { resolveLevel, supportsIntelligence } from './utilities/intelligenceLevels.js';
import TokenUsageReporter, { Provider } from '../utilities/TokenUsageReporter.js';
import { sanitizeSchemaForGemini } from './tools/builtin/toolHelpers.js';
import {
  OPENAI_COMPATIBLE_PROVIDERS,
  openAiCompatibleClientOptions,
  maxOutputTokensParam,
  reasoningParams,
  usageProviderFor
} from './utilities/nativeProviders.js';
import { isToolActive, isToolAvailable, createAdkLiveToolset } from './tools/toolAvailability.js';
import { APP_ROOT, createSdkFilesystemGuard } from './tools/pathConfinement.js';
import { createSdkNetworkGuard } from './tools/networkConfinement.js';
import { join } from 'path';

// External provider ids that name the upstream LLM brand but resolve to the same
// OpenRouter-routed code paths. The OpenRouter gateway is an implementation detail —
// users pick the brand they want and the orchestrator routes through the OR SDK.
// Derived from the shared config registry so adding/removing a brand is a single
// config.js edit (see config.openRouterAgentProviders).
const OPENROUTER_PROVIDERS = new Set(Object.keys(config.openRouterAgentProviders));

// Every event that terminates one turn of the OpenRouter SDK's tool loop. All three
// carry the same materialized response object, and therefore that turn's `usage`:
// `response.completed` for a turn that ran to the end, `response.incomplete` for one
// the provider cut short (max_output_tokens, a filtered generation, a truncated
// stream), and `response.failed` for one that errored after the model had already
// generated. Incomplete and failed responses are billed exactly like completed ones —
// @openrouter/agent notes that an incomplete response "is materialized, has a
// generation id, and consumed tokens" — so all three feed the usage accumulator.
const OPENROUTER_TERMINAL_RESPONSE_EVENTS = new Set([
  'response.completed',
  'response.failed',
  'response.incomplete',
]);

// The Agent SDK's write half, withheld from any agent that has not opted in via
// can_write_to_local_sandbox.
//
// Withheld through disallowedTools, not by omission from allowedTools. That list
// reads like a whitelist and is not one — the SDK's own docs call it "tool names
// that are auto-allowed without prompting" and say outright that restricting
// availability is what the `tools` option is for. Nothing sets `tools`, so the query
// gets the default claude_code preset with Write, Edit and Bash in it, and
// permissionMode 'bypassPermissions' then waives the approval that allowedTools
// exists to pre-answer. Leaving a name out of allowedTools therefore withholds
// nothing, which is how these tools stayed live behind a `/*'Edit', 'Write',*/`
// that looked like it had taken them away.
//
// Bash is here because a shell is a write tool: withdrawing Write and Edit while
// leaving `bash -c 'echo ... > f'` in reach would restrict nothing.
const SDK_WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit', 'Bash'];

// The preset's web half, which every agent gets — read-only ones included, since
// neither name is in SDK_WRITE_TOOLS above. Listed here rather than left implicit
// because that availability was previously a side effect of what the deny list
// happened to omit, and something reachable by accident is something that gets
// removed by accident too. Naming them in allowedTools does not grant anything
// (the preset already did) but it puts the decision in the file.
//
// What bounds them is createSdkNetworkGuard, not this list: the sandbox shares
// the host's network namespace, so an unrestricted fetch is a request aimed at
// the host's own loopback and at the cloud metadata service. See
// tools/networkConfinement.js.
const SDK_WEB_TOOLS = ['WebFetch', 'WebSearch'];

// Preset tools that cannot do anything in this headless, settings-free query, withheld
// from every agent so their schemas stop riding on each request and the model stops
// reaching for them. Chosen as a deny list rather than by setting `tools`, which would
// also drop whatever the preset adds next — and among those kept are TodoWrite/Task*
// and Agent, which an agent can genuinely use on a long build.
//
// - AskUserQuestion: nothing can answer it headless. It used to be intercepted by
//   aborting the query, which told the client the user had pressed stop; without it
//   the agent asks in text and ends its turn normally.
// - Skill: settingSources is [] so there are no skills to load.
// - EnterPlanMode / ExitPlanMode: plan mode is an approval flow with no approver
//   under bypassPermissions.
// - NotebookEdit: there are no notebooks.
// - EnterWorktree / ExitWorktree, CronCreate / CronDelete / CronList, RemoteTrigger,
//   PushNotification: CLI-session features with no meaning inside a worker.
const SDK_UNUSABLE_TOOLS = [
  'AskUserQuestion', 'Skill', 'EnterPlanMode', 'ExitPlanMode', 'NotebookEdit',
  'EnterWorktree', 'ExitWorktree', 'CronCreate', 'CronDelete', 'CronList',
  'RemoteTrigger', 'PushNotification',
];

// The environment the Agent SDK gives the `claude` CLI subprocess it spawns.
//
// Without this the subprocess inherits the worker's process.env, which is how
// `Bash` running `env` — and `Read` on /proc/self/environ, which needs no write
// capability at all — returned every provider key the worker held. An explicit
// allowlist is the only thing that narrows it; the SDK documents the option as
// "when omitted, the subprocess inherits process.env".
//
// ANTHROPIC_API_KEY is on the list and is safe to be: WorkerSpawner replaces it
// with a per-session sentinel that only the loopback CredentialProxy will
// exchange for the real credential. The rest are transport and locale settings a
// proxied or custom-CA deployment needs; none is a secret.
const SDK_SUBPROCESS_ENV = [
  'PATH', 'HOME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
];

export function anthropicSdkSubprocessEnv() {
  const env = {};
  for (const name of SDK_SUBPROCESS_ENV) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

// Neutralize regex metacharacters in text that is about to become a pattern. Used on
// tool names, which are client-supplied on the dynamic side and so are not guaranteed
// to be the plain [a-z0-9_] identifiers the convention implies.
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Normalize a single message to Gemini format {role:'user'|'model', parts:[{text}]}.
// Handles Anthropic-format messages ({role, content}) that arrive when switching
// from an Anthropic-mode agent or from client-provided historical messages.
function toGeminiMessage(msg) {
  if (Array.isArray(msg.parts)) {
    const role = msg.role === 'assistant' ? 'model' : msg.role;
    return role === msg.role ? msg : { ...msg, role };
  }
  const role = msg.role === 'assistant' ? 'model' : msg.role;
  let text = '';
  if (typeof msg.content === 'string') {
    text = msg.content;
  } else if (Array.isArray(msg.content)) {
    text = msg.content.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
  }
  return { role, parts: [{ text }] };
}

// Normalize a single message to Anthropic format {role:'user'|'assistant', content}.
// Handles Gemini-format messages ({role:'user'|'model', parts}) that arrive when
// switching from a Gemini-mode agent.
function toAnthropicMessage(msg) {
  if (!Array.isArray(msg.parts)) {
    const role = msg.role === 'model' ? 'assistant' : msg.role;
    return role === msg.role ? msg : { ...msg, role };
  }
  const role = msg.role === 'model' ? 'assistant' : msg.role;
  const text = msg.parts.filter(p => p.text).map(p => p.text).join('\n');
  return { role, content: text };
}

/**
 * AgentOrchestrator
 * Manages the Claude Agent SDK lifecycle and message translation
 *
 * Responsibilities:
 * - Load and apply agent configuration
 * - Integrate built-in and dynamic tools
 * - Start conversations with Claude Agent SDK
 * - Translate SDK messages to WebSocket messages
 * - Handle tool execution (built-in vs client tools)
 * - Send messages to client via WebSocket
 */
export class AgentOrchestrator {
  // Drops this orchestrator's model-change subscription. Held so destroy() can run it
  // — an agent switch replaces the orchestrator while the session lives on, and a
  // stale listener would keep syncing a tool server nobody is talking to.
  #unsubscribeModelChange = null;
  #geminiManualCacheName = null;
  #geminiManualCacheKey = null;
  #geminiManualCacheExpiry = null;
  #pendingMessages = [];
  // ADK can emit multiple events per LLM call that share the same usageMetadata
  // object reference (e.g. a streamed partial yield plus the aggregated close()
  // yield). No LLM-call id is exposed on the event, so reference equality is the
  // only available dedup key.
  #geminiAdkReportedUsageMetadata = new WeakSet();
  // Running usage total for the OpenRouter conversation currently in flight, shared
  // by both loops (a session runs one of them, never both). OpenRouter bills one HTTP
  // request at a time — the SDK loop sees a terminal response event per turn, the
  // manual loop a usage block per chat.send — so no single usage object is the run's total
  // and they are summed as they arrive. Flushed and cleared at every exit from either
  // loop: normal completion, user stop, abort and error alike, so a run that ends
  // early still reports every token it spent up to that point.
  #openRouterPendingUsage = null;
  // The model the pending usage was spent on, captured as it accumulates so a flush
  // needs nothing from the call site. stopIteration() is the reason: it can report
  // what a run has spent without being inside the run, or knowing which one it is.
  #openRouterPendingUsageModel = null;
  // Upstream error block from a `response.failed` event on the OpenRouter SDK
  // stream. The SDK's own handler for that event reads `event.message`, which
  // does not exist — the detail lives at `event.response.error` — so it throws a
  // bare "Response failed" with nothing attached (@openrouter/sdk
  // esm/lib/model-result.js). We consume the same broadcaster, and buffered
  // events are always drained before the completion error surfaces, so we can
  // stash the real reason here and attach it when that error reaches the catch.
  #openRouterSdkFailureDetail = null;
  // Per-assistant usage accumulator for the anthropic SDK route. The SDKResultMessage
  // carries the authoritative aggregate and supersedes this on normal completion;
  // we only flush the accumulator as a fallback when a query aborts before its
  // result message arrives.
  #anthropicSdkAccumulatorUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    cache_read_input_tokens: 0,
  };

  constructor(sessionManager, sessionId, sendToClient, agentConfig, provider = config.agentDefaultProvider, intelligence = null, toolModels) {
    this.sessionManager = sessionManager;
    this.sessionId = sessionId;
    this.sendToClient = sendToClient;
    this.stopRequested = false;
    this.provider = provider;
    // Resolved against this provider's ladder, so it is always a level the provider
    // actually offers (or null when the provider doesn't participate at all).
    this.intelligence = resolveLevel(provider, intelligence)?.id ?? null;

    // The engine tools pick their underlyingModel from this. It is a stable OBJECT
    // that setIntelligence() mutates in place rather than a copied string, because
    // the tools capture it in a closure at registration time but read it inside the
    // handler — which is what lets a mid-conversation change reach the next tool
    // call without re-registering every tool.
    //
    // `toolModels`, when a caller supplies one, pins the engine-tool lane for the
    // whole session and outranks every config lookup (see selectEngineModel). No
    // product path passes it; it is how the eval runner holds the engine models
    // fixed across an experiment. The key is omitted when unset so a normal
    // session's profile keeps exactly the shape it had before.
    this.agentProfile = {
      provider: this.provider,
      intelligence: this.intelligence,
      ...(toolModels ? { toolModels } : {})
    };

    // SDK-specific properties (for SDK mode)
    this.abortController = null;
    this.anthropicSdkSessionId = null; // SDK session ID for conversation continuity
    this.anthropicSdkPendingToolCalls = new Map(); // Track tool_use_id -> tool_name mapping
    // tool_use ids for AskUserQuestion calls we intercepted. The SDK can't execute
    // AskUserQuestion in headless mode and emits an error tool_result for it; we
    // surface the question as text and abort, then swallow that error result so it
    // doesn't surface as a spurious "Tool error for unknown" log / client message.
    this.anthropicSdkAskUserQuestionToolUseIds = new Set();

    // Load configuration
    this.configManager = new AgentConfigurationManager(agentConfig);

    // Who every token spent from here on is billed to. Published to the session as
    // well as kept here, because the spenders are scattered: this class's own turns,
    // the SessionManager's summarizer, the tools, the engines those tools call, and
    // the RAG embedder all report usage, and all of them can reach the session. Set
    // before the tool providers are built so nothing can read it half-initialized;
    // an agent switch builds a new orchestrator and overwrites it.
    this.agentName = this.configManager.getAgentName();
    sessionManager.setAgentName(sessionId, this.agentName);

    // One media store for the whole worker, injected rather than made per consumer.
    // Four things inside this process need it -- both tool providers, the built-in
    // generate_image and view_media tools, and this class's own hydration of image
    // blocks when it builds a provider call -- so it belongs to the thing that owns
    // all of them. (The main process cannot share this instance: it lives on the
    // other side of the worker boundary and makes its own. That is safe rather than
    // a duplication, because the store caches nothing -- the bind-mounted directory
    // is the authority, which is exactly why it was built that way.)
    this.mediaStore = new MediaStore(sessionManager, sessionId);

    // Create tool providers
    this.builtInToolProvider = new BuiltInToolProvider(sessionManager, sessionId, sendToClient, this.agentProfile, this.mediaStore, this.configManager.canWriteToLocalSandbox());
    this.dynamicToolProvider = new DynamicToolProvider(sessionManager, sessionId, sendToClient, this.mediaStore);

    // Keep the SDK route's tool list tracking the model. Subscribed here rather than
    // at each editing site because the change that matters most is the one no site on
    // this server makes: the user's application inserting an assembly through a client
    // tool, which reaches us only as a new model. Every other route rebuilds its
    // declarations from isToolActive and needs no subscription, so this is a no-op for
    // them. Released in destroy().
    this.#unsubscribeModelChange = sessionManager.onModelChange(
      sessionId,
      () => this.builtInToolProvider?.syncModelStateGates()
    );

    // Provider SDK clients are lazy-instantiated via #getX() — see top-of-file
    // loaders. A single session uses exactly one provider, so eager
    // instantiation of all four wastes ~500ms of @google/adk module load and
    // hundreds of ms in OpenRouter SDK setup on every session start.
    this.anthropic = null;
    this.gemini = null;
    this.geminiAdkSessionId = null;
    this.geminiAdkSessionService = null;
    this.openRouterClient = null;
    this.openRouterConversationState = null;
    this.openAiCompatibleClient = null;

    const clientId = sessionManager.getSession(sessionId)?.clientId ?? null;
    this.tokenReporter = new TokenUsageReporter(config.tokenReporterURL, clientId);

    // Kick off the provider SDK import in the background. Users typically take
    // multiple seconds to type their first chat, so this hides the import cost.
    // startConversationX awaits the same loaders before using their symbols.
    this.#providerPreload = this.#preloadProviderSDK().catch(err =>
      logger.warn(`Provider SDK preload failed: ${err.message}`)
    );

    logger.log(`AgentOrchestrator initialized for session ${sessionId} (loop: ${this.configManager.getAgentMode()}, provider: ${this.provider})`);
  }

  #providerPreload = null;

  async #preloadProviderSDK() {
    const loop = this.configManager.getAgentMode();
    if (this.provider === 'anthropic') {
      await (loop === 'sdk' ? loadClaudeAgentSdk() : loadAnthropicSdk());
    } else if (this.provider === 'google') {
      await loadGoogleGenai();
      if (loop === 'sdk') await loadGoogleAdk();
    } else if (OPENROUTER_PROVIDERS.has(this.provider)) {
      await loadOpenRouterSdk();
      if (loop === 'sdk') await loadOpenRouterAgent();
    } else if (OPENAI_COMPATIBLE_PROVIDERS.has(this.provider)) {
      await loadOpenAiSdk();
    }
  }

  async #getAnthropic() {
    if (this.anthropic) return this.anthropic;
    const Anthropic = await loadAnthropicSdk();
    this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return this.anthropic;
  }

  async #getGemini() {
    if (this.gemini) return this.gemini;
    const { GoogleGenAI } = await loadGoogleGenai();
    this.gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    return this.gemini;
  }

  async #getOpenRouter() {
    if (this.openRouterClient) return this.openRouterClient;
    const { OpenRouter } = await loadOpenRouterSdk();
    this.openRouterClient = new OpenRouter({ apiKey: process.env.OPEN_ROUTER_API_KEY });
    return this.openRouterClient;
  }

  /**
   * Lazy client for the OpenAI-compatible native providers. The key and host come from
   * the provider id (see openAiCompatibleClientOptions) — one client per session, and a
   * session has exactly one provider, so caching it needs no provider key.
   */
  async #getOpenAiCompatibleClient() {
    if (this.openAiCompatibleClient) return this.openAiCompatibleClient;
    const OpenAI = await loadOpenAiSdk();
    this.openAiCompatibleClient = new OpenAI({
      ...openAiCompatibleClientOptions(this.provider),
      timeout: 5 * 60 * 1000,
    });
    return this.openAiCompatibleClient;
  }

  /**
   * Start a conversation with the agent
   */
  async startConversation(userMessage, previousAgentContext = null) {
    try {
      const session = this.sessionManager.getSession(this.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${this.sessionId}`);
      }

      const loopStyle = this.configManager.getAgentMode(); // 'sdk' | 'manual'
      logger.log(`Starting conversation for session ${this.sessionId} (loop: ${loopStyle}, provider: ${this.provider})`);

      // Every route clears stopRequested when its run ends, but a stop that
      // arrives while no run is in flight has nothing to clear it — and a stale
      // flag makes the next run skip its queued messages and report itself as
      // stopped. Starting a run is the one moment the flag is unambiguously
      // stale, so clear it here for all routes rather than in each of them.
      this.stopRequested = false;

      // The turn-start fetch's result travels with the message, so the agent starts
      // the turn already holding what get_current_model would tell it and does not
      // spend a client round trip and an LLM iteration asking again. It is the tool's
      // own answer — the path the model was written to plus its errors and unit
      // verdict — never the model itself, which stays on disk.
      // An empty message means "continue"; the note would make it non-empty and hide
      // that from the routes' empty-message fallbacks, so spell the request out first.
      const modelSync = await this.#fetchCurrentModel();
      if (modelSync) {
        const request = userMessage?.trim() ? userMessage : 'Please continue.';
        userMessage = `${request}\n\n${modelSync}`;
      }

      const isManual = loopStyle === 'manual';
      if (isManual && previousAgentContext?.length > 0) {
        // previousAgentContext is a reference to the live session context.
        // If it ends with a user message (e.g. agent-switch handoff where the
        // prior agent's turn was interrupted), pop it so the incoming
        // userMessage replaces it instead of duplicating. Other trailing roles
        // (assistant, etc.) are preserved. A trailing user message carrying
        // tool results must NOT be popped — doing so orphans the preceding
        // assistant's tool_use blocks and the API rejects the next request.
        const last = previousAgentContext[previousAgentContext.length - 1];
        const isToolResult =
          (Array.isArray(last?.content) && last.content.some(b => b?.type === 'tool_result')) ||
          (Array.isArray(last?.parts) && last.parts.some(p => p?.functionResponse));
        if (last?.role === 'user' && !isToolResult) {
          previousAgentContext.pop();
          logger.debug(`[Prior context → manual] Popped trailing user message; ${previousAgentContext.length} messages remain`);
        }
      }

      // OpenRouter-routed brands (config.openRouterAgentProviders) all dispatch through
      // the shared OpenRouter-SDK/manual methods — the brand selects the model slug, the
      // gateway is the same. Brand-specific cases keep the dispatch table explicit.
      const isOpenRouterBrand = OPENROUTER_PROVIDERS.has(this.provider);
      // OpenAI-compatible native-API providers have no agent SDK, so they always run
      // the manual (chat-completions) loop regardless of the 'sdk' default.
      if (OPENAI_COMPATIBLE_PROVIDERS.has(this.provider)) {
        await this.startConversationOpenAiCompatibleManual(userMessage);
        return;
      }
      switch (`${this.provider}-${loopStyle}`) {
        case 'anthropic-sdk':
          await this.startConversationWithAnthropicSdk(userMessage, previousAgentContext);
          break;
        case 'anthropic-manual':
          await this.startConversationAnthropicManual(userMessage);
          break;
        case 'google-sdk':
          await this.startConversationWithGeminiAdk(userMessage, previousAgentContext);
          break;
        case 'google-manual':
          await this.startConversationGeminiManual(userMessage);
          break;
        default:
          if (isOpenRouterBrand && loopStyle === 'sdk') {
            await this.startConversationOpenRouterSDK(userMessage, previousAgentContext);
            break;
          }
          if (isOpenRouterBrand && loopStyle === 'manual') {
            await this.startConversationOpenRouterManual(userMessage);
            break;
          }
          throw new Error(`Unknown combination: provider=${this.provider}, loop=${loopStyle}`);
      }

    } catch (error) {
      logger.error(`Error in agent conversation for session ${this.sessionId}:`, error);

      await this.sendToClient(createErrorMessage(
        this.sessionId,
        error.message,
        'CONVERSATION_ERROR'
      ));
      await this.sendToClient(createAgentCompleteMessage(
        this.sessionId,
        'awaiting_user',
        `Agent error: ${error.message}`
      ));
    }
  }

  /**
   * Start conversation using manual agent loop (original implementation)
   */
  async startConversationAnthropicManual(userMessage) {
    const session = this.sessionManager.getSession(this.sessionId);
    const anthropic = await this.#getAnthropic();

    // Add user message to conversation history
    this.sessionManager.addToConversationHistory(this.sessionId, {
      role: 'user',
      content: userMessage
    });

    // Build system prompt from config
    const mode = session.mode;
    const systemPrompt = this.#buildRouteSystemPrompt(mode, 'prefixed');

    // Get tool collections
    const builtInTools = this.builtInToolProvider.getTools();
    const dynamicTools = this.dynamicToolProvider.getTools();

    // Start agent conversation loop
    // Clean up context (remove stale models, summarize if over limit) before first API call
    await this.sessionManager.cleanupContext(this.sessionId, config.agentMaxContextTokens, this.provider);

    // Use the live session context as the messages array — no local copy
    const messages = this.sessionManager.getConversationContext(this.sessionId);

    // Normalize in-place: Gemini-format messages ({role:'user'|'model', parts}) from
    // historical session load or a prior Gemini-mode agent switch must become
    // Anthropic-format ({role:'user'|'assistant', content}) before the API call.
    for (let i = 0; i < messages.length; i++) {
      messages[i] = toAnthropicMessage(messages[i]);
    }
    // Drop any messages that converted to empty content (e.g. Gemini tool call/response
    // parts that have no text), which Anthropic rejects.
    for (let i = messages.length - 1; i >= 0; i--) {
      const content = messages[i].content;
      if (!content || (typeof content === 'string' && content.trim() === '') || (Array.isArray(content) && content.length === 0)) {
        messages.splice(i, 1);
      }
    }

    // The configured Anthropic model (4.6+ family) rejects assistant-message prefill:
    // the conversation MUST end with a user turn or the API 400s with
    // "This model does not support assistant message prefill". The array can end on an
    // assistant turn here if the incoming userMessage was empty/whitespace (dropped by the
    // filter above) or an agent-switch handoff left the history ending on an assistant turn.
    // Re-append a user turn so the request is valid. An empty message historically meant
    // "continue" (it worked via prefill on older models); preserve that intent explicitly.
    if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
      const text = (typeof userMessage === 'string' && userMessage.trim()) ? userMessage : 'Please continue.';
      messages.push({ role: 'user', content: text });
      logger.debug(`Anthropic Manual: appended trailing user turn to satisfy no-prefill requirement (userMessage was ${userMessage?.trim() ? 'non-empty' : 'empty'})`);
    }

    // Check model token count and update session state
    const currentModel = session?.clientModel;
    let modelTokenCount = 0;

    if (currentModel) {
      const modelJson = JSON.stringify(currentModel, null, 2);
      modelTokenCount = countTokens(modelJson);
      this.sessionManager.updateModelTokenCount(this.sessionId, modelTokenCount);
    }

    const systemBlocks = [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral', ttl: '5m' } }
    ];

    const maxIterations = this.configManager.getMaxIterations();

    // Pinned for the whole turn, not re-read per iteration. setIntelligence() can land
    // between any two awaits below (it arrives as a worker IPC message), and a turn that
    // swapped models mid tool-use loop would bill half its iterations to one model and
    // half to another while the client was told nothing changed. Resolving once here is
    // what makes the documented contract true: the turn finishes on the model it started
    // with, and the new level applies from the next turn.
    const model = this.#resolveNativeModel();
    // Adaptive thinking controls depth via `effort` (output_config) rather than a token
    // budget — budget_tokens is removed on Opus 4.7+/Sonnet 4.6 and would 400.
    const resolvedThinking = this.#resolveAnthropicThinking();
    const thinkingEnabled = resolvedThinking?.type !== 'disabled';
    // Thinking blocks are replayed with the history (see processAgentResponseAnthropicManual),
    // and on preserved-thinking models each one is bound to the exact prefix it was
    // produced under. This history is not append-only — cleanupContext summarizes it
    // and the tool list follows model state — so a replayed block can find its prefix
    // changed. drop_block makes the API discard such a block and proceed instead of
    // answering 400 (the default for accounts created on or after 2026-08-31). Models
    // that do not enforce the check accept the same body.
    const thinking = thinkingEnabled
      ? { ...resolvedThinking, block_binding: { prefix_mismatch_behavior: 'drop_block' } }
      : resolvedThinking;
    const requestOptions = thinkingEnabled
      ? { headers: { 'anthropic-beta': 'thinking-binding-controls-2026-08-01' } }
      : undefined;
    const effort = this.#resolveEffort();

    while (true) {
      let continueLoop = true;
      let completedNaturally = false;
      let iteration = 0;
      let overloadedRetries = 0;

      while (continueLoop && iteration < maxIterations && !this.stopRequested) {
        iteration++;

        // Summarize context in-place if it has grown over the token limit
        await this.sessionManager.cleanupContext(this.sessionId, config.agentMaxContextTokens, this.provider);

        // Rebuilt every iteration, not once per turn: the previous iteration may have
        // been the tool call that gave this model its first variable, or pushed it
        // past what the engines can take. Filtering is a pass over a fixed map, so
        // this costs nothing next to the request it precedes.
        const tools = this.#anthropicManualConvertTools(builtInTools, dynamicTools, mode);

        try {
          const response = await anthropic.messages.create({
            model,
            // Thinking draws on the same budget as the answer, so 8192 could be spent
            // before the reply was done and cost an iteration on "continue". 16000 is
            // the ceiling that keeps a non-streaming request clear of SDK timeouts.
            max_tokens: 16000,
            // Automatic caching: a breakpoint on the last message, so each iteration of
            // a tool loop reads the whole prior conversation from cache instead of just
            // the system prompt and tools (their own breakpoints make 3 of the 4 allowed).
            cache_control: { type: 'ephemeral' },
            system: systemBlocks,
            // Image bytes are attached to a copy here and thrown away with the
            // request. `messages` is the live session context, so hydrating it in
            // place would put base64 into stored history and into every later
            // token count.
            messages: hydrateMessagesForAnthropic(messages, this.mediaStore),
            thinking,
            // A level may omit effort on purpose; omit the whole key rather than
            // sending `{effort: undefined}` so the API applies its own default.
            ...(thinkingEnabled && effort ? { output_config: { effort } } : {}),
            tools: tools.length > 0 ? tools : undefined
          }, requestOptions);

          const dropped = response.input_transformations?.filter(t => t.type === 'thinking_dropped') ?? [];
          if (dropped.length > 0) {
            logger.debug(`Anthropic Manual: API dropped ${dropped.length} replayed thinking block(s): ${dropped.map(t => `${t.path} (${t.reason})`).join(', ')}`);
          }

          // Reported against the pinned model rather than whatever the session resolves
          // to now, so a level change mid-turn can't misattribute this call's cost.
          this.#logApiUsage(Provider.ANTHROPIC, response.usage, model);

          // A safety classifier can decline the request: HTTP 200, stop_reason
          // "refusal", and `content` empty or holding only a partial answer. Checked
          // before the content is read because the processing path below assumes usable
          // blocks — without this the turn ends as an opaque stall rather than a reason.
          // Reachable on any Claude model; the top intelligence rung makes it likelier,
          // which is why it is handled here rather than left to chance.
          if (response.stop_reason === 'refusal') {
            const category = response.stop_details?.category;
            logger.warn(`Anthropic declined the request (model=${model}${category ? `, category=${category}` : ''})`);
            await this.sendToClient(createAgentTextMessage(
              this.sessionId,
              `I wasn't able to answer that — the safety system for the model I'm using declined the request${category ? ` (${category})` : ''}. Rephrasing it, or switching to a lower intelligence level, will usually get past it.`,
              false
            ));
            continueLoop = false;
            break;
          }

          // Check if stop was requested during the API call
          if (this.stopRequested) {
            break;
          }

          // Process response
          continueLoop = await this.processAgentResponseAnthropicManual(response, messages, builtInTools, dynamicTools);
          if (!continueLoop && !this.stopRequested) completedNaturally = true;

          // Check if stop was requested during response processing
          if (this.stopRequested) {
            break;
          }

        } catch (error) {
          const isOverloaded = error?.status === 529 || error?.error?.type === 'overloaded_error';
          const isNetworkError = error?.cause?.code === 'UND_ERR_SOCKET' || error?.code === 'UND_ERR_SOCKET' ||
            error?.code === 'ECONNRESET' || error?.cause?.code === 'ECONNRESET' ||
            (error instanceof TypeError && error.message === 'terminated');
          if ((isOverloaded || isNetworkError) && overloadedRetries < 3) {
            overloadedRetries++;
            const reason = isOverloaded ? 'overloaded (529)' : 'network error';
            logger.warn(`Anthropic Manual: Anthropic API ${reason}, retry ${overloadedRetries}/3`);
            await this.sendToClient(createAgentTextMessage(
              this.sessionId,
              isOverloaded ? 'The AI service is temporarily overloaded. Retrying...' : 'Network connection interrupted. Retrying...'
            ));
            await new Promise(resolve => setTimeout(resolve, 5000));
          } else if (isOverloaded) {
            logger.error('Anthropic Manual: Anthropic API overloaded (529) after 3 retries, giving up');
            await this.sendToClient(createErrorMessage(
              this.sessionId,
              'The AI service is overloaded. Please try again later.',
              'AGENT_ERROR'
            ));
            await this.sendToClient(createAgentCompleteMessage(
              this.sessionId,
              'awaiting_user',
              'Agent stopped due to overloaded API'
            ));
            continueLoop = false;
            completedNaturally = true;
          } else {
            logger.error('Anthropic Manual: Error in agent conversation loop:', error);
            await this.sendToClient(createErrorMessage(
              this.sessionId,
              `Agent error: ${error.message}`,
              'AGENT_ERROR'
            ));
            await this.sendToClient(createAgentCompleteMessage(
              this.sessionId,
              'awaiting_user',
              'Agent stopped due to error'
            ));
            continueLoop = false;
            completedNaturally = true;
          }
        }
      }

      if (this.stopRequested) {
        logger.log(`Anthropic Manual: Agent iteration stopped by user request for session ${this.sessionId}`);
        this.stopRequested = false;
        await this.sendToClient(createAgentCompleteMessage(
          this.sessionId,
          'awaiting_user',
          'Agent stopped by user request'
        ));
        break;
      }
      const reachedMax = !completedNaturally && iteration >= maxIterations;
      if (this.#pendingMessages.length === 0) {
        if (reachedMax) {
          logger.log(`Anthropic Manual: Agent conversation reached max iterations (${maxIterations})`);
          await this.sendToClient(createAgentCompleteMessage(
            this.sessionId,
            'awaiting_user',
            `Reached maximum iterations (${maxIterations})`
          ));
        }
        break;
      }

      if (reachedMax) {
        logger.log(`Anthropic Manual: max iterations (${maxIterations}) hit; draining queued message with fresh budget`);
      }
      const next = this.#pendingMessages.shift();
      logger.log(`Anthropic Manual: processing queued message (remaining: ${this.#pendingMessages.length})`);
      this.sessionManager.addToConversationHistory(this.sessionId, { role: 'user', content: next });
    }
  }

  /**
   * Start conversation using Claude Agent SDK
   */
  async startConversationWithAnthropicSdk(userMessage, previousAgentContext = null) {
    const session = this.sessionManager.getSession(this.sessionId);
    const mode = session.mode;
    const { query } = await loadClaudeAgentSdk();

    // Track user message for cross-mode replay (SDK → manual on future switch)
    this.sessionManager.addToConversationHistory(this.sessionId, {
      role: 'user',
      content: userMessage
    });

    let systemPrompt = this.#buildRouteSystemPrompt(mode, 'prefixed');

    // Check model token count and handle large models (for SDK mode)
    const currentModel = session?.clientModel;
    let modelTokenCount = 0;

    if (currentModel) {
      const modelJson = JSON.stringify(currentModel, null, 2);
      modelTokenCount = countTokens(modelJson);
      this.sessionManager.updateModelTokenCount(this.sessionId, modelTokenCount);
    }

    // Create abort controller for stop iteration
    this.abortController = new AbortController();
    this.maxTurnsReached = false;

    const maxIterations = this.configManager.getMaxIterations();

    try {
      // Build tools list - combine SDK filesystem tools with MCP servers
      const canWriteToLocalSandbox = this.configManager.canWriteToLocalSandbox();
      const builtInSdkTools = canWriteToLocalSandbox
        ? ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash']
        : ['Read', 'Glob', 'Grep'];

      let mcpServers = {
        builtin: await this.builtInToolProvider.getMcpServer(mode)
      };

      // Get client MCP server and derive allowed tool names from the same source
      const clientMcpServer = await this.dynamicToolProvider.getMcpServer();
      const clientToolNames = this.dynamicToolProvider.getToolNames(); // client_* prefixed, used for system prompt
      const prefixedClientToolNames = clientToolNames.map(name => `mcp__client__${name.replace(/^client_/, '')}`);
      if (clientMcpServer) {
        mcpServers.client = clientMcpServer;
      }

      // Build allowed tools list with MCP prefixes, filtered by mode, sandbox grant
      // and client capability — isToolAvailable, which is the exact predicate
      // getMcpServer registers by, so this list can never name a tool the server did
      // not register and can never omit one it did.
      //
      // Model-state gating is deliberately NOT applied here, and this is the one route
      // where that distinction is load-bearing. The list is built once per query and
      // cannot be rebuilt while the query runs; the live answer comes from the MCP
      // server, which registers a gated tool disabled and has syncModelStateGates flip
      // it as the model changes. Filtering with isToolActive here would freeze the
      // turn's opening model state into two places the toggle cannot reach: this list,
      // and the prompt rewrite below, which would then go on naming a revived tool by
      // an unprefixed name the model cannot call.
      const allBuiltInTools = this.builtInToolProvider.getTools();
      const toolSession = this.sessionManager.getSession(this.sessionId);
      const builtInToolNames = this.builtInToolProvider.getToolNames()
        .filter(name => {
          if (SDK_FILE_TOOL_TWINS.has(name)) return false; // SDK provides native Read/Write/Edit
          const toolDef = allBuiltInTools.tools[name];
          if (toolDef?.nonSdkOnly) return false;
          return isToolAvailable(toolDef, { mode, session: toolSession, canWriteToLocalSandbox });
        })
        .map(name => `mcp__builtin__${name}`);
      let allowedTools = [
        ...builtInSdkTools,      // SDK filesystem tools (no prefix)
        ...SDK_WEB_TOOLS,        // web access, every agent — see SDK_WEB_TOOLS
        ...builtInToolNames,     // Built-in tools with mcp__builtin__ prefix
        ...prefixedClientToolNames // Client tools with mcp__client__ prefix
      ];

      // Prefix tool names in system prompt
      systemPrompt = this.#anthropicSdkPrefixToolNamesInSystemPrompt(systemPrompt, builtInToolNames, clientToolNames);

      // Then say what the SDK's own filesystem tools are for. Appended after the
      // prefixing pass on purpose: these names take no mcp__ prefix, and the pass
      // would not leave `Read` alone if a builtin were ever named that.
      systemPrompt += this.#anthropicSdkFilesystemToolsNote(builtInSdkTools);

      // Where the SDK's filesystem tools may look, and — via cwd — where a Glob
      // or Grep that names no path defaults to. Pinning cwd is part of the gate:
      // bwrap sets no --chdir, so the worker's cwd is the container root and an
      // unqualified Grep would otherwise walk the whole sandbox.
      const sessionTempDir = this.sessionManager.getSessionTempDir(this.sessionId);
      const filesystemRoots = [sessionTempDir, APP_ROOT];

      const anthropicSdkThinking = this.#resolveAnthropicThinking();
      const anthropicSdkEffort = this.#resolveEffort();

      // Build query options with MCP servers
      const queryOptions = {
        abortController: this.abortController,
        systemPrompt: systemPrompt,
        model: this.#resolveNativeModel(),
        maxTurns: maxIterations,
        mcpServers: mcpServers,
        allowedTools: allowedTools,
        disallowedTools: canWriteToLocalSandbox
          ? SDK_UNUSABLE_TOOLS
          : [...SDK_UNUSABLE_TOOLS, ...SDK_WRITE_TOOLS],
        permissionMode: 'bypassPermissions',
        cwd: sessionTempDir,
        env: anthropicSdkSubprocessEnv(),
        // SDK isolation mode. Omitting this loads all three filesystem settings
        // tiers "matching CLI defaults" (the SDK's own wording): user from
        // ~/.claude/settings.json, project from <cwd>/.claude/settings.json, local
        // from <cwd>/.claude/settings.local.json. In the sandbox HOME is /session
        // and cwd is the session temp dir — the same directory, and the only
        // writable one — so all three resolve inside space the agent can write,
        // as does CLAUDE.md. A settings.json dropped there defines `hooks`, which
        // are shell commands the CLI runs on its own tool calls: that turns any
        // write primitive into command execution, and turns a written CLAUDE.md
        // into self-injection. Nothing here needs on-disk settings, so load none.
        settingSources: [],
        // Confines native Read/Glob/Grep, which arrive with the claude_code
        // preset and are handed to every agent including read-only ones. Nothing
        // else in this options object can do it: allowedTools only pre-approves
        // a prompt, and bypassPermissions means there is no prompt.
        hooks: {
          PreToolUse: [{ hooks: [this.#sdkPreToolUseGuard(filesystemRoots, sessionTempDir)] }],
        },
        thinking: anthropicSdkThinking,
        // Omitted entirely when the level defines no effort — see the manual loop.
        ...(anthropicSdkThinking?.type !== 'disabled' && anthropicSdkEffort
          ? { effort: anthropicSdkEffort } : {}),
        // No output-token or compaction options: the SDK's Options has neither a
        // `maxTokens` nor a `compact`, and the CLI auto-compacts on its own.
      };

      // If we have an SDK session ID, resume the conversation
      if (this.anthropicSdkSessionId) {
        queryOptions.resume = this.anthropicSdkSessionId;
        logger.log(`Anthropic SDK: Resuming SDK conversation with session_id: ${this.anthropicSdkSessionId}`);
      } else {
        logger.log(`Anthropic SDK: Starting new SDK conversation`);
      }

      // Build prompt - inject prior agent's history as plain string prefix on agent switch
      let prompt = userMessage;
      if (previousAgentContext?.length > 0 && !this.anthropicSdkSessionId) {
        const contextToReplay = previousAgentContext.slice(0, -1).map(toAnthropicMessage);
        if (contextToReplay.length > 0) {
          logger.debug(`[Agent switch → SDK] Replaying ${contextToReplay.length} messages from prior agent.`);
          const contextText = await this.#buildPriorContextTextHelper(contextToReplay);
          prompt = `[Prior conversation context]\n${contextText}\n[End of prior context]\n\n${userMessage}`;
        }
      }

      // Create query iterator with Agent SDK
      const queryIterator = query({
        prompt,
        options: queryOptions
      });

      // Process messages from SDK
      for await (const message of queryIterator) {
        await this.#handleAnthropicSdkMessage(message);
      }

      // Process any messages queued while the SDK was running. Each queued message
      // gets a fresh maxTurns budget — even if the prior run hit the limit.
      while (!this.stopRequested && this.#pendingMessages.length > 0) {
        const next = this.#pendingMessages.shift();
        logger.log(`Anthropic SDK: processing queued message (remaining: ${this.#pendingMessages.length})`);
        this.maxTurnsReached = false;
        const followUpIterator = query({ prompt: next, options: { ...queryOptions, resume: this.anthropicSdkSessionId } });
        for await (const message of followUpIterator) {
          await this.#handleAnthropicSdkMessage(message);
        }
      }

      // Stopped mid-run — either the user pressed stop or our AskUserQuestion
      // intercept aborted the query. Clear the flag here (as every other route
      // does): it is per-run state, and leaving it set would make the drain
      // loop above skip every message queued during all later runs.
      if (this.stopRequested) {
        this.stopRequested = false;
        logger.log(`Anthropic SDK: Agent iteration stopped for session ${this.sessionId}`);
        await this.sendToClient(createAgentCompleteMessage(
          this.sessionId,
          'awaiting_user',
          'Agent stopped by user request'
        ));
      } else if (this.maxTurnsReached) {
        logger.log(`Anthropic SDK: Agent reached max iterations for session ${this.sessionId}`);
        await this.sendToClient(createAgentCompleteMessage(
          this.sessionId,
          'awaiting_user',
          `Reached maximum iterations (${maxIterations})`
        ));
      } else {
        logger.log(`Anthropic SDK: Agent conversation completed successfully for session ${this.sessionId}`);
        await this.sendToClient(createAgentCompleteMessage(
          this.sessionId,
          'success',
          'Task completed successfully'
        ));
      }

    } catch (error) {
      if (error.name === 'AbortError' || this.stopRequested) {
        this.stopRequested = false;
        logger.log(`Anthropic SDK: Agent iteration stopped by user request for session ${this.sessionId}`);
        await this.sendToClient(createAgentCompleteMessage(
          this.sessionId,
          'awaiting_user',
          'Agent stopped by user request'
        ));
      } else if (error.message?.includes('maximum number of turns')) {
        logger.log(`Anthropic SDK: Agent reached max turns for session ${this.sessionId}`);
        await this.sendToClient(createAgentCompleteMessage(
          this.sessionId,
          'awaiting_user',
          `Reached maximum iterations (${maxIterations})`
        ));
      } else {
        logger.error('Anthropic SDK: Error in agent conversation loop:', error);
        await this.sendToClient(createErrorMessage(
          this.sessionId,
          `Agent error: ${error.message}`,
          'AGENT_ERROR'
        ));
        await this.sendToClient(createAgentCompleteMessage(
          this.sessionId,
          'awaiting_user',
          `Agent error: ${error.message}`
        ));
      }
    } finally {
      // Safety net: report any per-assistant usage that wasn't superseded by a
      // result message (e.g. the query was aborted mid-stream).
      this.#flushAnthropicSdkUsageAccumulator();
      this.abortController = null;
    }
  }

  /**
   * Determine the response type for a completed tool call (using stripped tool name)
   */
  #getResponseType(displayName) {
    if (['generate_ltm_narrative'].includes(displayName)) return 'ltm-discuss';
    if (['discuss_model_with_seldon', 'discuss_model_across_runs', 'discuss_with_mentor'].includes(displayName)) return 'discuss';
    if (['generate_quantitative_model', 'generate_qualitative_model'].includes(displayName)) return 'model';
    return 'other';
  }

  /**
   * Remove MCP prefix from tool names for client display
   */
  #stripMcpPrefix(toolName) {
    if (toolName.startsWith('mcp__builtin__')) {
      return toolName.substring('mcp__builtin__'.length);
    }
    if (toolName.startsWith('mcp__client__')) {
      return toolName.substring('mcp__client__'.length);
    }
    return toolName;
  }

  /**
   * Render an AskUserQuestion tool call's full payload to markdown so the end
   * user sees everything they need to answer: each question, whether multiple
   * selections are allowed, and every option with its label and description.
   * The client only ever replies with free text, so the options are presented
   * as a plain bulleted list (no checkboxes/combo boxes) the user reads and
   * then answers in prose. The SDK can't execute this tool in our headless
   * context, so we surface the content to the client and stop the loop to
   * await the user's reply.
   */
  #formatAskUserQuestions(questions) {
    if (!Array.isArray(questions) || questions.length === 0) return '';

    const sections = [];
    for (const q of questions) {
      if (!q || typeof q.question !== 'string' || !q.question.trim()) continue;

      const lines = [];
      lines.push(`**${q.question.trim()}**`);
      if (q.multiSelect) {
        lines.push('_(select all that apply)_');
      }

      const options = Array.isArray(q.options) ? q.options : [];
      for (const opt of options) {
        if (!opt || typeof opt.label !== 'string' || !opt.label.trim()) continue;
        const description = typeof opt.description === 'string' && opt.description.trim()
          ? ` — ${opt.description.trim()}`
          : '';
        lines.push(`- **${opt.label.trim()}**${description}`);
      }

      sections.push(lines.join('\n'));
    }

    return sections.join('\n\n');
  }

  /**
   * Handle messages from Agent SDK
   */
  async #handleAnthropicSdkMessage(message) {
    switch (message.type) {
      case 'assistant':
        await this.#handleAnthropicSdkAssistantMessage(message);
        break;

      case 'result':
        await this.#handleAnthropicSdkResultMessage(message);
        break;

      case 'system':
        if (message.subtype === 'init') {
          if (message.session_id) {
            this.anthropicSdkSessionId = message.session_id;
            logger.log(`Anthropic SDK initialized for session ${this.sessionId}, SDK session_id: ${this.anthropicSdkSessionId}`);
          }
        } else if (message.subtype === 'error') {
          logger.error(`Anthropic SDK system error for session ${this.sessionId}:`, message.error || message);
          await this.sendToClient(createErrorMessage(
            this.sessionId,
            message.error?.message || 'SDK system error',
            'SDK_SYSTEM_ERROR'
          ));
        } else if (message.subtype === 'api_retry') {
          logger.log(`Anthropic SDK: API retry attempt ${message.attempt}/${message.max_retries} for session ${this.sessionId} (status: ${message.error_status}, delay: ${Math.round(message.retry_delay_ms / 1000)}s)`);
        }
        break;

      case 'user':
        await this.#handleAnthropicSdkUserMessage(message);
        break;

      // The SDK reset its transcript and mounted a fresh one — /clear, plan-mode
      // exit, or a fresh-session flow. None of those are reachable from here (we
      // send no slash commands and run bypassPermissions), so this is a notice,
      // not a branch we act on: session_id is what `resume` keys on and it is
      // unchanged, and nothing we cache is scoped to the conversation id.
      case 'conversation_reset':
        break;

      // Liveness heartbeat the SDK emits every 30s while a tool is still running
      // (our long generate_* tools trip it routinely). Nothing to do: the client
      // already has the tool-call notification and gets the completion message
      // when the tool returns.
      case 'tool_progress':
        break;

      default:
        logger.warn(`Anthropic SDK: Unhandled message type: ${message.type}`, message);
    }
  }

  /**
   * Handle assistant messages (text from Claude)
   *
   * Usage isn't reported here — the SDKResultMessage carries the authoritative
   * aggregate (including the SDK's internal compaction calls). But on abort no
   * result message arrives, so we also accumulate every per-assistant usage and
   * flush it as a fallback in the surrounding try/finally.
   */
  async #handleAnthropicSdkAssistantMessage(message) {
    const usage = message.message?.usage;
    if (usage) {
      this.#anthropicSdkAccumulatorUsage.input_tokens += usage.input_tokens ?? 0;
      this.#anthropicSdkAccumulatorUsage.output_tokens += usage.output_tokens ?? 0;
      this.#anthropicSdkAccumulatorUsage.cache_creation.ephemeral_5m_input_tokens += usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
      this.#anthropicSdkAccumulatorUsage.cache_creation.ephemeral_1h_input_tokens += usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      this.#anthropicSdkAccumulatorUsage.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
    }

    const content = message.message?.content;
    const rawTextParts = [];

    if (content && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          rawTextParts.push(block.text);
          const html = await marked.parse(block.text);
          await this.sendToClient(createAgentTextMessage(this.sessionId, html, false));
        }
        else if (block.type === 'thinking' && block.thinking) {
          //claude code is too chatty -- don't send these!
          /*const html = await marked.parse(block.thinking);
          await this.sendToClient(createAgentTextMessage(this.sessionId, html, true));*/
        }
        else if (block.type === 'tool_use' && block.name) {
          if (block.name === 'AskUserQuestion') {
            // Remember this id so the SDK's "can't answer" error result for it is
            // swallowed rather than logged/forwarded as a tool failure.
            this.anthropicSdkAskUserQuestionToolUseIds.add(block.id);
            const questionsMarkdown = this.#formatAskUserQuestions(block.input?.questions);
            if (questionsMarkdown) {
              const html = await marked.parse(questionsMarkdown);
              await this.sendToClient(createAgentTextMessage(this.sessionId, html, false));
            }
            this.stopRequested = true;
            this.abortController?.abort();
            return;
          }

          this.anthropicSdkPendingToolCalls.set(block.id, block.name);

          const isFilesystemTool = ['Read', 'Edit', 'Write', 'Glob', 'Grep'].includes(block.name);
          const isBuiltInMcpTool = block.name.startsWith('mcp__builtin__');
          const isBuiltIn = isFilesystemTool || isBuiltInMcpTool;

          const displayName = this.#stripMcpPrefix(block.name);

          await this.sendToClient(createToolCallNotificationMessage(
            this.sessionId,
            block.id,
            displayName,
            block.input || {},
            isBuiltIn
          ));
        }
        else if (block.type === 'tool_result' && block.tool_use_id) {
          // Swallow the SDK's unanswerable-AskUserQuestion error result — already
          // handled by surfacing the question and aborting.
          if (this.anthropicSdkAskUserQuestionToolUseIds.has(block.tool_use_id)) {
            this.anthropicSdkAskUserQuestionToolUseIds.delete(block.tool_use_id);
            continue;
          }

          const toolName = this.anthropicSdkPendingToolCalls.get(block.tool_use_id) || 'unknown';
          const displayName = this.#stripMcpPrefix(toolName);

          if (block.is_error) {
            logger.log(`Anthropic SDK: Tool error for ${toolName} (${block.tool_use_id}):`, block.content);
          } else {
            logger.log(`Anthropic SDK: Tool call completed: ${displayName}`);
          }

          const responseType = this.#getResponseType(displayName);

          await this.sendToClient(createToolCallCompletedMessage(
            this.sessionId,
            block.tool_use_id,
            displayName,
            block.content,
            block.is_error || false,
            responseType
          ));

          this.anthropicSdkPendingToolCalls.delete(block.tool_use_id);
        }
      }
    }

    // Track client-facing text for cross-mode replay (SDK → manual)
    if (rawTextParts.length > 0) {
      this.sessionManager.addToConversationHistory(this.sessionId, {
        role: 'assistant',
        content: rawTextParts.join('\n')
      });
    }
  }

  /**
   * Handle user messages (tool results being sent back to Claude)
   */
  async #handleAnthropicSdkUserMessage(message) {
    const content = message.message?.content;

    if (content && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          // Swallow the SDK's unanswerable-AskUserQuestion error result — already
          // handled by surfacing the question and aborting.
          if (this.anthropicSdkAskUserQuestionToolUseIds.has(block.tool_use_id)) {
            this.anthropicSdkAskUserQuestionToolUseIds.delete(block.tool_use_id);
            continue;
          }

          const toolName = this.anthropicSdkPendingToolCalls.get(block.tool_use_id) || 'unknown';
          const displayName = this.#stripMcpPrefix(toolName);

          if (block.is_error) {
            logger.log(`Anthropic SDK: Tool error for ${toolName} (${block.tool_use_id}):`, block.content);
          } else {
            logger.log(`Anthropic SDK: Tool call completed: ${displayName}`);
          }

          const responseType = this.#getResponseType(displayName);

          await this.sendToClient(createToolCallCompletedMessage(
            this.sessionId,
            block.tool_use_id,
            displayName,
            block.content,
            block.is_error || false,
            responseType
          ));

          this.anthropicSdkPendingToolCalls.delete(block.tool_use_id);
        }
      }
    }
  }

  /**
   * Handle result messages (conversation completion).
   *
   * The result message carries the aggregate usage for the entire query (across
   * every assistant turn AND the SDK's internal compaction calls), so this is
   * the canonical point where we report usage for the SDK route. The
   * per-assistant accumulator is reset because the result supersedes it.
   */
  async #handleAnthropicSdkResultMessage(message) {
    if (message.usage) {
      this.#logApiUsage(Provider.ANTHROPIC, message.usage);
      this.#resetAnthropicSdkUsageAccumulator();
    } else {
      this.#flushAnthropicSdkUsageAccumulator();
    }

    if (message.subtype === 'success') {
      logger.log(`Anthropic SDK conversation completed successfully for session ${this.sessionId}`);
    } else if (message.subtype === 'error_max_turns') {
      logger.log(`Anthropic SDK conversation reached max iterations for session ${this.sessionId}`);
      this.maxTurnsReached = true;
    } else if (message.subtype === 'error') {
      logger.warn(`Anthropic SDK conversation error for session ${this.sessionId}:`, message.error || message);
    } else if (message.subtype === 'tool_error') {
      logger.log(`Anthropic SDK tool error for session ${this.sessionId}:`, message);
    } else {
      logger.warn(`Anthropic SDK Unhandled result message subtype: ${message.subtype}`, message);
    }
  }

  /**
   * What the Agent SDK's native filesystem tools actually reach, for the system prompt.
   *
   * This route is the only one that offers them, and it offers them from here rather
   * than from any agent's prompt — so no agent prompt describes them, and the model is
   * left to infer their scope from their names. It infers wrongly, and always in the
   * same direction: asked about a file that belongs to the user, it reads `app.css` or
   * `index.html` as a path and reaches for `Grep`, which searches this server's own
   * source tree instead and answers "path does not exist". The user's model and their
   * interface are on their machine, behind the mcp__ tools, and nothing about the tool
   * names says so.
   *
   * Ends the model.sdjson prohibition that the builtin `read_file` carries in its own
   * description. read_file is not registered on this route (native `Read` shadows it),
   * so without this the prohibition is simply absent here — and native `Read` has no
   * guard of its own.
   */
  /**
   * The single PreToolUse hook, covering both confinements.
   *
   * One function calling two evaluators rather than two entries in the hooks
   * array: a deny has to win over an allow, and composing them here states that
   * rather than assuming it of the SDK. Filesystem first — it is synchronous,
   * while the network check may await a DNS lookup.
   */
  #sdkPreToolUseGuard(filesystemRoots, sessionTempDir) {
    const filesystemGuard = createSdkFilesystemGuard(filesystemRoots, sessionTempDir);
    const networkGuard = createSdkNetworkGuard();

    return async (input) => {
      const filesystemDecision = await filesystemGuard(input);
      if (filesystemDecision?.hookSpecificOutput) return filesystemDecision;
      return networkGuard(input);
    };
  }

  #anthropicSdkFilesystemToolsNote(builtInSdkTools) {
    if (!builtInSdkTools?.length) return '';

    const names = builtInSdkTools.map(name => `\`${name}\``).join(', ');

    return `

# ${builtInSdkTools.join(', ')}

${names} act on this server's own filesystem, and they take absolute paths. What is on it \
is the scratch files the tools here wrote — nothing that belongs to the user. Their model, \
and their interface if they have one, live on their machine and are reachable only through \
the mcp__ tools; no amount of looking will find them here. So a bare or relative path like \
\`app.css\` or \`index.html\` is not a path you can read — it names something on the other \
side of a tool call, and the tool whose name matches what you want is the way to it.

Never read model.sdjson from disk. The model is inspected and changed only through the \
model tools.`;
  }

  /**
   * Prefix tool names in system prompt for SDK mode
   * Scans the system prompt and adds mcp__ prefixes to tool names
   *
   * Two tiers, because the two sets of names carry different risk. Built-in names and
   * the `client_`-prefixed form are ours: they are chosen here, they read as identifiers,
   * and rewriting them anywhere they appear is safe. A client tool's *bare* name is
   * chosen by the host application and rewritten only where the prompt marks it up as
   * code or bold — a client registering `export`, `search` or `notes` would otherwise
   * have every ordinary occurrence of that word turned into mcp__client__export
   * mid-sentence. The client-tool roster makes those names appear in the prompt as a
   * matter of course, so the distinction now earns its keep.
   */
  #anthropicSdkPrefixToolNamesInSystemPrompt(systemPrompt, builtInToolNames, clientToolNames) {
    let modifiedPrompt = systemPrompt;

    // Rewritten wherever they appear, marked up or not.
    const toolNameMapping = {};
    // Rewritten only inside `backticks` or **bold**.
    const delimitedOnlyMapping = {};

    // Built-in tools: tool_name -> mcp__builtin__tool_name
    for (const prefixedName of builtInToolNames) {
      const unprefixedName = prefixedName.replace(/^mcp__builtin__/, '');
      toolNameMapping[unprefixedName] = prefixedName;
    }

    // Client tools: client_tool_name -> mcp__client__tool_name
    for (const clientToolName of clientToolNames) {
      const unprefixedName = clientToolName.replace(/^client_/, '');
      const prefixedName = `mcp__client__${unprefixedName}`;
      toolNameMapping[clientToolName] = prefixedName;
      // Also map the unprefixed name, for an agent config that writes it plainly —
      // but only where it is delimited. See the note above.
      delimitedOnlyMapping[unprefixedName] = prefixedName;
    }

    // Replace tool names in the system prompt
    // Look for patterns like `tool_name` or **tool_name** or tool_name (surrounded by word boundaries)
    const rewrite = (mapping, includeBareWord) => {
      for (const [unprefixed, prefixed] of Object.entries(mapping)) {
        // Escaped: a client picks its own tool names, and a '.' or '(' in one would
        // otherwise compile into a pattern that matches far more than the name.
        const escaped = escapeRegExp(unprefixed);
        const patterns = [
          new RegExp(`\`${escaped}\``, 'g'),           // `tool_name`
          new RegExp(`\\*\\*${escaped}\\*\\*`, 'g'),   // **tool_name**
          ...(includeBareWord ? [new RegExp(`\\b${escaped}\\b`, 'g')] : []) // tool_name
        ];

        for (const pattern of patterns) {
          modifiedPrompt = modifiedPrompt.replace(pattern, (match) => {
            // Preserve the formatting around the tool name
            return match.replace(unprefixed, prefixed);
          });
        }
      }
    };

    rewrite(toolNameMapping, true);
    rewrite(delimitedOnlyMapping, false);

    return modifiedPrompt;
  }

  /**
   * Process agent response and handle tool calls
   * Returns true if the conversation should continue
   */
  async processAgentResponseAnthropicManual(response, messages, builtInTools, dynamicTools) {
    let hasToolCalls = false;

    // Collect all assistant content blocks and tool results before touching messages.
    // This ensures every tool_use is always paired with its tool_result in one atomic
    // write, preventing orphaned tool_use blocks if processing is interrupted mid-response.
    const assistantContent = [];
    const toolResults = [];

    // Process each content block (stream to client, execute tools)
    for (const block of response.content) {
      // Check if stop was requested before processing each block
      if (this.stopRequested) {
        return false; // Stop processing immediately (nothing added to messages yet)
      }

      if (block.type === 'text') {
        // Send text content to client
        const text = await marked.parse(block.text);

        await this.sendToClient(createAgentTextMessage(
          this.sessionId,
          text,
          false
        ));

        assistantContent.push({ type: 'text', text: block.text });
      } else if (block.type === 'redacted_thinking' || (block.type === 'thinking' && block.signature)) {
        // Kept verbatim and in position, signature included, so the next iteration
        // of a tool loop still has the reasoning that chose the tool. Never shown to
        // the client, and every other consumer of this history reads text blocks only.
        // An unsigned block is one a max_tokens cutoff truncated; it cannot be replayed.
        assistantContent.push(block);
      } else if (block.type === 'tool_use') {
        hasToolCalls = true;

        // Notify client that tool call is happening (for UI display)
        const isBuiltIn = this.#isBuiltInTool(block.name, builtInTools);
        await this.sendToClient(createToolCallNotificationMessage(
          this.sessionId,
          block.id,
          block.name,
          block.input,
          isBuiltIn
        ));

        // Send additional text notification for slow tools
        await this.#sendSlowToolMessageHelper(block.name, block.input);

        // Execute tool
        const toolResult = await this.executeToolCallHelper(block, builtInTools, dynamicTools);

        // Check if stop was requested during tool execution
        if (this.stopRequested) {
          return false; // Stop processing immediately (nothing added to messages yet)
        }

        if (toolResult.isError) {
          logger.log(`Anthropic Manual: Tool error for ${block.name}:`, toolResult.content);
        } else {
          logger.log(`Anthropic Manual: Tool call completed: ${block.name}`);
        }

        const responseType = this.#getResponseType(block.name);

        // Notify client of completion
        await this.sendToClient(createToolCallCompletedMessage(
          this.sessionId,
          block.id,
          block.name,
          toolResult.content,
          toolResult.isError,
          responseType
        ));

        // Blocks rather than flat text when the tool answered with a picture. What
        // lands in `messages` is a handle block, never base64 -- the bytes are
        // attached to a transient copy when the API call is built.
        const resultContent = toolResultToBlocks(toolResult);

        assistantContent.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: resultContent, is_error: toolResult.isError || false });
      }
    }

    // Atomically commit the full response to messages: one assistant message containing
    // all content blocks (text + all tool_uses), then one user message with all tool_results.
    // Keeping every tool_use paired with its tool_result in the same write prevents the
    // "tool_use without tool_result" API error that occurs when context summarisation
    // truncates the middle of an interleaved sequence.
    if (assistantContent.length > 0) {
      const last = messages[messages.length - 1];
      if (!last || last.role !== 'assistant') {
        messages.push({ role: 'assistant', content: [] });
      } else if (!Array.isArray(last.content)) {
        // The context is shared with the SDK/OpenRouter/Gemini routes and with
        // restored history, all of which write assistant turns as plain strings.
        // Promote to block form before appending rather than blowing up on
        // String.push.
        last.content = (typeof last.content === 'string' && last.content.trim())
          ? [{ type: 'text', text: last.content }]
          : [];
      }
      for (const block of assistantContent) {
        messages[messages.length - 1].content.push(block);
      }
    }
    if (toolResults.length > 0) {
      messages.push({ role: 'user', content: toolResults });
    }

    // If we had tool calls, continue the loop to let Claude process results
    if (hasToolCalls) {
      return true;
    }

    // Continue if stop_reason is max_tokens. 
    if (response.stop_reason === 'max_tokens') {
      if (messages[messages.length - 1]?.role === 'assistant') {
        messages.push({
          role: 'user',
          content: 'Your previous response was cut off by the output token limit. Continue exactly where you left off.'
        });
      }
      return true;
    }

    // Any other stop reason (end_turn, stop_sequence, etc.) — complete
    await this.sendToClient(createAgentCompleteMessage(
      this.sessionId,
      'success',
      'Task completed successfully'
    ));
    return false;
  }

  /**
   * Build prior-history context text on an agent switch. If the conversation
   * fits within `config.agentMaxContextTokens`, returns it verbatim; otherwise
   * summarizes via the **destination** provider (the one we just switched TO).
   *
   * Accepts history in either Anthropic format ({role, content}) or Gemini
   * format ({role, parts}); each summarizer extracts text from both shapes via
   * the shared normalizer below.
   */
  /**
   * Universal system-prompt hook: every route builds its prompt through here, so the
   * session-dependent sections — the client's own tools, attached-file context — reach
   * all six provider/loop paths identically instead of once per route.
   *
   * RAG wording is intentionally tool-agnostic for the read-in-full (manifest) tier
   * ("open and read the file at <path>") — the anthropic-sdk route excludes the
   * read_file built-in (it uses the SDK's native Read) and would rewrite a
   * literal `read_file` token to a non-existent MCP tool. The `search_documents`
   * token is safe to mention (it exists on every route).
   *
   * @param {'prefixed'|'bare'} clientToolNameStyle  Passed straight to buildPromptRoster;
   *        'bare' only on the ADK route, which is the only one that registers client
   *        tools under their unprefixed names. Explicit at every call site rather than
   *        re-derived here from provider + agent mode: that derivation is startConversation's
   *        dispatch, and a second copy of it would drift the moment a route moved.
   */
  #buildRouteSystemPrompt(mode, clientToolNameStyle) {
    const sections = [
      this.configManager.buildSystemPrompt(mode),
      // The roster names only tools the route will actually register, which is why the
      // built-in names go in: under 'bare' they are what a client tool can collide with.
      this.dynamicToolProvider.buildPromptRoster(clientToolNameStyle, this.#builtInToolNameSet())
    ];

    const files = this.sessionManager.getAttachedFiles(this.sessionId).filter(f => f.status === 'ready');
    if (files.length > 0) {
      const tempDir = this.sessionManager.getSessionTempDir(this.sessionId);
      const lines = files.map(f => {
        if (f.tier === 'vector') {
          return `- "${f.name}" (${f.mimeType}, ~${f.tokenCount} tokens) — large document. Use the search_documents tool to find relevant passages (optionally restrict to this file with fileId "${f.fileId}").`;
        }
        const path = join(tempDir, 'rag', f.fileId, 'extracted.txt');
        return `- "${f.name}" (${f.mimeType}, ~${f.tokenCount} tokens) — open and read the file at ${path} to use its full contents.`;
      });

      sections.push(`## Attached Files
The user has attached the following reference documents to this session. Consult them whenever they are relevant to the request.
${lines.join('\n')}`);
    }

    return sections.filter(Boolean).join('\n\n');
  }

  /**
   * Every built-in tool name, unfiltered by availability.
   *
   * Used only to settle client-tool name collisions, so it deliberately ignores mode and
   * model size: whether a client tool exists should not depend on how big the model
   * happens to be this turn, and a name that is a built-in's in one session is a
   * built-in's in all of them.
   */
  #builtInToolNameSet() {
    return new Set(this.builtInToolProvider.getToolNames());
  }

  async #buildPriorContextTextHelper(history) {
    const conversationText = this.#normalizeHistoryToText(history);
    const tokenCount = countTokens(conversationText);
    if (tokenCount <= config.agentMaxContextTokens) {
      logger.log(`Prior agent context (${history.length} messages, ~${tokenCount} tokens) under limit — injecting verbatim`);
      return conversationText;
    }
    if (OPENAI_COMPATIBLE_PROVIDERS.has(this.provider)) {
      return this.#summarizePriorContextWithOpenAiCompatible(conversationText, history.length);
    }
    if (OPENROUTER_PROVIDERS.has(this.provider)) {
      return this.#summarizePriorContextWithOpenRouter(conversationText, history.length);
    }
    if (this.provider === 'google') {
      return this.#summarizePriorContextWithGemini(conversationText, history.length);
    }
    // Default: anthropic.
    return this.#summarizePriorContextWithAnthropic(conversationText, history.length);
  }

  #normalizeHistoryToText(history) {
    return history.map((msg) => {
      const role = (msg.role === 'assistant' || msg.role === 'model') ? 'Assistant' : 'User';
      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
      } else if (Array.isArray(msg.parts)) {
        text = msg.parts.filter(p => p.text).map(p => p.text).join('\n');
      }
      return text ? `${role}: ${text}` : '';
    }).filter(line => line).join('\n\n');
  }

  async #summarizePriorContextWithAnthropic(conversationText, messageCount) {
    try {
      logger.log(`Anthropic: Summarizing prior agent context (${messageCount} messages) before injection`);
      const anthropic = await this.#getAnthropic();
      const summaryModel = config.nativeAgentProviders.anthropic.summaryModel;
      const response = await anthropic.messages.create({
        model: summaryModel,
        max_tokens: 1024,
        messages: [{ role: 'user', content: `Summarize this conversation history concisely (2-4 paragraphs):\n\n${conversationText}` }]
      });
      if (response.usage) {
        this.#logApiUsage(Provider.ANTHROPIC, response.usage, summaryModel);
      }
      return response.content[0].text;
    } catch (error) {
      logger.error('Anthropic: Error summarizing prior context:', error);
      return '[Prior conversation condensed due to size]';
    }
  }

  async #summarizePriorContextWithGemini(conversationText, messageCount) {
    try {
      logger.log(`Gemini: Summarizing prior agent context (${messageCount} messages) before injection`);
      const gemini = await this.#getGemini();
      const summaryModel = config.nativeAgentProviders.google.summaryModel;
      const response = await gemini.models.generateContent({
        model: summaryModel,
        contents: [{
          role: 'user',
          parts: [{ text: `Summarize this conversation history concisely (2-4 paragraphs):\n\n${conversationText}` }]
        }]
      });
      if (response.usageMetadata) {
        this.#logApiUsage(Provider.GOOGLE, response.usageMetadata, summaryModel);
      }
      return response.text || response.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch (error) {
      logger.error('Gemini: Error summarizing prior context:', error);
      return '[Prior conversation condensed due to size]';
    }
  }

  async #summarizePriorContextWithOpenAiCompatible(conversationText, messageCount) {
    // Pick the per-provider summary model from the native registry. Falls back to
    // the agent's primary model for any unforeseen provider so summarization proceeds.
    const model = config.nativeAgentProviders[this.provider]?.summaryModel || this.#resolveNativeModel();
    try {
      logger.log(`${this.provider}: Summarizing prior agent context (${messageCount} messages) before injection`);
      const client = await this.#getOpenAiCompatibleClient();
      const completion = await client.chat.completions.create({
        model,
        messages: [
          { role: 'user', content: `Summarize this conversation history concisely (2-4 paragraphs):\n\n${conversationText}` }
        ],
        ...maxOutputTokensParam(this.provider, 1024),
        ...reasoningParams(this.provider),
      });
      if (completion.usage) {
        this.#logApiUsage(usageProviderFor(this.provider), completion.usage, model);
      }
      return completion.choices?.[0]?.message?.content ?? '';
    } catch (error) {
      logger.error(`${this.provider}: Error summarizing prior context: ${this.#describeOpenAiError(error)}`);
      return '[Prior conversation condensed due to size]';
    }
  }

  async #summarizePriorContextWithOpenRouter(conversationText, messageCount) {
    // Pick the per-brand summary model from the OpenRouter registry. Falls back to
    // the agent's primary model for any unforeseen brand so summarization proceeds.
    const model = config.openRouterAgentProviders[this.provider]?.summaryModel || this.#resolveOpenRouterModel();
    try {
      logger.log(`OpenRouter (${this.provider}): Summarizing prior agent context (${messageCount} messages) before injection`);
      const openRouterClient = await this.#getOpenRouter();
      const completion = await openRouterClient.chat.send({
        chatRequest: {
          model,
          messages: [
            { role: 'user', content: `Summarize this conversation history concisely (2-4 paragraphs):\n\n${conversationText}` }
          ],
          maxCompletionTokens: 1024,
        }
      });
      if (completion.usage) {
        this.#logApiUsage(Provider.OPENROUTER, completion.usage, model);
      }
      const message = completion.choices?.[0]?.message;
      if (typeof message?.content === 'string') return message.content;
      if (Array.isArray(message?.content)) {
        return message.content.filter(b => typeof b?.text === 'string').map(b => b.text).join('');
      }
      return '';
    } catch (error) {
      logger.error(`OpenRouter (${this.provider}): Error summarizing prior context: ${this.#describeOpenRouterError(error)}`);
      return '[Prior conversation condensed due to size]';
    }
  }

  /**
   * The sandbox-write grant, enforced where the call actually lands.
   *
   * The manual routes filter tools when they build the declaration list, which can only
   * decline to *advertise* write_file and edit_file — the tool objects stay in the
   * collection and these execute paths reach them by name. A model that was never shown
   * a tool still calls it occasionally, and most reliably right after an agent switch:
   * the previous agent's transcript is replayed into this one's prompt, so an agent
   * without the grant can be reading a worked example of the tools Merlin has. Filtering
   * answers that with a real write. This answers it with a refusal.
   *
   * @returns {Object|null} An error envelope to return instead of calling the tool, or null to proceed
   */
  #refuseSandboxWrite(toolDef, toolName) {
    if (!toolDef?.requiresSandboxWrite || this.configManager.canWriteToLocalSandbox()) return null;

    logger.warn(`Blocked ${toolName} for session ${this.sessionId} — agent lacks can_write_to_local_sandbox`);
    return {
      content: [{ type: 'text', text: `${toolName} is not available to you — this agent cannot write to the local sandbox.` }],
      isError: true
    };
  }

  /**
   * Execute a tool call (built-in or client tool)
   */
  async executeToolCallHelper(toolUse, builtInTools, _dynamicTools) {
    try {
      // Check if it's a built-in tool
      if (builtInTools.tools[toolUse.name]) {
        const toolDef = builtInTools.tools[toolUse.name];
        const refusal = this.#refuseSandboxWrite(toolDef, toolUse.name);
        if (refusal) return refusal;

        const result = await toolDef.handler(toolUse.input);
        // Handler already returns { content: [...], isError: bool }
        return result;
      }

      // Check if it's a client tool
      if (this.dynamicToolProvider.isClientTool(toolUse.name)) {
        // Through the registered handler, exactly as the built-in branch above does,
        // rather than calling requestClientExecution directly.
        //
        // The handler closes over the client's own tool definition, and calling
        // around it dropped two things on the floor. The declared `timeout` was one:
        // request_interface_media asks for eight hours because it waits for a person
        // to go and find a photograph, and this route gave it the 30-second default
        // and abandoned the call. The media contract was the other: without the
        // definition there is nothing to tell the transport which argument holds an
        // image handle, so a tool expecting bytes was sent the handle alone.
        //
        // It already answers with the envelope — wrapping that again put the tool's
        // result inside a content field the model then read as a JSON string, and
        // forced isError to false so a failed client tool looked like a successful
        // one that happened to mention an error.
        return await this.dynamicToolProvider.getTools().tools[toolUse.name].handler(toolUse.input);
      }

      // Tool not found
      return {
        content: [{ type: 'text', text: `Tool not found: ${toolUse.name}` }],
        isError: true
      };

    } catch (error) {
      logger.error(`Anthropic Manual: Error executing tool ${toolUse.name}:`, error);
      return {
        content: [{ type: 'text', text: error.message }],
        isError: true
      };
    }
  }

  /**
   * Convert tool servers to Anthropic tool format
   */
  #anthropicManualConvertTools(builtInTools, dynamicTools, mode) {
    const tools = [];
    const toolNames = new Set();
    const session = this.sessionManager.getSession(this.sessionId);

    // Convert built-in tools
    for (const [toolName, toolDef] of Object.entries(builtInTools.tools)) {
      if (toolNames.has(toolName)) {
        logger.warn(`Anthropic: Duplicate tool name detected: ${toolName} (from built-in tools)`);
        continue;
      }

      // Skip tools ruled out by mode, sandbox grant, or client capability
      if (!isToolActive(toolDef, { mode, session, canWriteToLocalSandbox: this.configManager.canWriteToLocalSandbox() })) {
        continue;
      }

      toolNames.add(toolName);

      tools.push({
        name: toolName,
        description: toolDef.description,
        input_schema: toolDef.inputSchema.toJSONSchema()
      });
    }

    // Convert dynamic tools (client tools)
    if (dynamicTools && dynamicTools.tools) {
      for (const [toolName, toolDef] of Object.entries(dynamicTools.tools)) {
        if (toolNames.has(toolName)) {
          logger.warn(`Anthropic: Duplicate tool name detected: ${toolName} (from client tools) - skipping client version, using built-in`);
          continue;
        }
        toolNames.add(toolName);

        tools.push({
          name: toolName,
          description: toolDef.description,
          input_schema: toolDef.inputSchema.toJSONSchema()
        });
      }
    }

    // Cache all tool definitions up to the last one — stable within a session
    if (tools.length > 0) {
      tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: 'ephemeral', ttl: '5m' } };
    }

    return tools;
  }

  /**
   * Check if a tool is a built-in tool
   */
  #isBuiltInTool(toolName, builtInTools) {
    return toolName in builtInTools.tools;
  }

  // ─── Gemini manual pathway ──────────────────────────────────────────────────

  async startConversationGeminiManual(userMessage) {
    const gemini = await this.#getGemini();
    this.sessionManager.addToConversationHistory(this.sessionId, {
      role: 'user',
      parts: [{ text: userMessage }]
    });

    const session = this.sessionManager.getSession(this.sessionId);
    const mode = session.mode;
    const systemPrompt = this.#buildRouteSystemPrompt(mode, 'prefixed');
    const builtInTools = this.builtInToolProvider.getTools();
    const dynamicTools = this.dynamicToolProvider.getTools();

    await this.sessionManager.cleanupContext(this.sessionId, config.agentMaxContextTokens, this.provider);

    const messages = this.sessionManager.getConversationContext(this.sessionId);

    // Normalize in-place: Anthropic-format messages ({role,content}) from historical
    // session load or a prior Anthropic-mode agent switch must become Gemini-format
    // ({role:'user'|'model', parts}) before being sent to the Gemini API.
    for (let i = 0; i < messages.length; i++) {
      messages[i] = toGeminiMessage(messages[i]);
    }

    const currentModel = session?.clientModel;

    let modelTokenCount = 0;

    if (currentModel) {
      const modelJson = JSON.stringify(currentModel, null, 2);
      modelTokenCount = encode(modelJson).length;
      this.sessionManager.updateModelTokenCount(this.sessionId, modelTokenCount);
    }

    const maxIterations = this.configManager.getMaxIterations();

    // Pinned for the whole turn — see the anthropic-manual loop for why. It matters more
    // here: the context cache is created against a specific model, so re-resolving per
    // iteration would let a mid-turn setIntelligence() rebuild the cache underneath a
    // running tool-use loop as well as swap the model.
    const model = this.#resolveNativeModel();
    const thinkingConfig = this.#resolveGeminiThinking();

    while (true) {
      let continueLoop = true;
      let completedNaturally = false;
      let iteration = 0;
      let retries = 0;
      let cacheRetries = 0;

      while (continueLoop && iteration < maxIterations && !this.stopRequested) {
        iteration++;
        await this.sessionManager.cleanupContext(this.sessionId, config.agentMaxContextTokens, this.provider);

        // Rebuilt per iteration so the list tracks the model the previous iteration
        // may have just changed — see the anthropic-manual loop. The cache below is
        // keyed on the declared tool names, so a list that changes shape here
        // correctly invalidates it rather than serving a cache built around a tool
        // that is no longer offered.
        const toolDeclarations = this.#geminiManualConvertTools(builtInTools, dynamicTools, mode);

        // Refresh the context cache before each call. #getGeminiManualConfig
        // returns the live cache cheaply while it's valid, and proactively
        // recreates it ~30s before its 300s TTL so it never expires mid-flight.
        const geminiConfig = await this.#getGeminiManualConfig(systemPrompt, toolDeclarations, model, thinkingConfig);

        try {
          const response = await gemini.models.generateContent({
            model,
            // Transient copy — see the anthropic-manual call for why history must
            // never hold the bytes.
            contents: hydrateContentsForGemini(messages, this.mediaStore),
            config: geminiConfig
          });

          // Pinned model, so a level change mid-turn can't misattribute this call.
          this.#logApiUsage(Provider.GOOGLE, response.usageMetadata, model);
          cacheRetries = 0;

          if (this.stopRequested) break;

          continueLoop = await this.processGeminiManualResponse(response, messages, builtInTools, dynamicTools);
          if (!continueLoop) completedNaturally = true;

          if (this.stopRequested) break;

        } catch (error) {
          const isQuota = error?.status === 429;
          const isNetworkError = error?.cause?.code === 'UND_ERR_SOCKET' || error?.code === 'UND_ERR_SOCKET' ||
            error?.code === 'ECONNRESET' || error?.cause?.code === 'ECONNRESET' ||
            (error instanceof TypeError && error.message === 'terminated');
          const isStaleCacheError = error?.status === 403 &&
            typeof error?.message === 'string' && error.message.includes('CachedContent not found');
          if (isStaleCacheError && cacheRetries < 3) {
            cacheRetries++;
            logger.warn(`Gemini Manual: cached content expired mid-session, recreating cache (attempt ${cacheRetries}/3)`);
            // Invalidate the dead cache; the next iteration rebuilds geminiConfig
            // with a fresh one via #getGeminiManualConfig. cacheRetries is its own
            // counter (reset on every successful call) so a long session can
            // recover from each cache expiry independently of network/quota retries.
            this.#geminiManualCacheName = null;
            this.#geminiManualCacheKey = null;
            this.#geminiManualCacheExpiry = null;
          } else if ((isQuota || isNetworkError) && retries < 3) {
            retries++;
            const reason = isQuota ? 'quota/rate-limited (429)' : 'network error';
            logger.warn(`Gemini Manual: Gemini API ${reason}, retry ${retries}/3`);
            await this.sendToClient(createAgentTextMessage(
              this.sessionId,
              isQuota ? 'The AI service is temporarily rate-limited. Retrying...' : 'Network connection interrupted. Retrying...'
            ));
            await new Promise(resolve => setTimeout(resolve, 5000));
          } else if (isQuota) {
            logger.error('Gemini Manual: Gemini API rate-limited after 3 retries, giving up');
            await this.sendToClient(createErrorMessage(this.sessionId, 'The AI service is rate-limited. Please try again later.', 'AGENT_ERROR'));
            await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'awaiting_user', 'Agent stopped due to rate limiting'));
            continueLoop = false;
            completedNaturally = true;
          } else {
            logger.error('Gemini Manual: Error in Gemini agent conversation loop:', error);
            await this.sendToClient(createErrorMessage(this.sessionId, `Agent error: ${error.message}`, 'AGENT_ERROR'));
            await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'awaiting_user', 'Agent stopped due to error'));
            continueLoop = false;
            completedNaturally = true;
          }
        }
      }

      if (this.stopRequested) {
        this.stopRequested = false;
        await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'awaiting_user', 'Agent stopped by user request'));
        break;
      }
      const reachedMax = !completedNaturally && iteration >= maxIterations;
      if (this.#pendingMessages.length === 0) {
        if (reachedMax) {
          logger.log(`Gemini Manual: Agent conversation reached max iterations (${maxIterations})`);
          await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'awaiting_user', `Reached maximum iterations (${maxIterations})`));
        }
        break;
      }

      if (reachedMax) {
        logger.log(`Gemini Manual: max iterations (${maxIterations}) hit; draining queued message with fresh budget`);
      }
      const next = this.#pendingMessages.shift();
      logger.log(`Gemini Manual: processing queued message (remaining: ${this.#pendingMessages.length})`);
      // `messages` IS the live session context — one append, not two.
      this.sessionManager.addToConversationHistory(this.sessionId, { role: 'user', parts: [{ text: next }] });
    }
  }

  async processGeminiManualResponse(response, messages, builtInTools, dynamicTools) {
    const candidate = response.candidates?.[0];
    if (!candidate?.content) {
      await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'success', 'Task completed successfully'));
      return false;
    }

    const parts = candidate.content.parts || [];

    messages.push({ role: 'model', parts });

    const rawTextParts = [];
    for (const part of parts) {
      if (part.thought) continue;
      if (part.text) {
        rawTextParts.push(part.text);
        const html = await marked.parse(part.text);
        await this.sendToClient(createAgentTextMessage(this.sessionId, html, false));
      }
    }

    const functionCallParts = parts.filter(p => p.functionCall);
    if (functionCallParts.length === 0) {
      await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'success', 'Task completed successfully'));
      return false;
    }

    const functionResponseParts = [];
    for (const part of functionCallParts) {
      if (this.stopRequested) return false;

      const { name, args } = part.functionCall;
      const callId = `fc_${Date.now()}_${Math.random().toString(36).substr(2, 7)}`;
      const isBuiltIn = this.#isBuiltInTool(name, builtInTools);

      await this.#sendSlowToolMessageHelper(name, args);
      await this.sendToClient(createToolCallNotificationMessage(this.sessionId, callId, name, args, isBuiltIn));

      const toolResult = await this.executeToolCallGeminiManual({ name, input: args });

      if (this.stopRequested) return false;

      if (toolResult.isError) {
        logger.log(`Gemini Manual: Tool error for ${name}:`, toolResult.content);
      } else {
        logger.log(`Gemini Manual: Tool call completed: ${name}`);
      }

      const responseType = this.#getResponseType(name);
      await this.sendToClient(createToolCallCompletedMessage(
        this.sessionId, callId, name, toolResult.content, toolResult.isError, responseType
      ));

      const resultText = toolResultToText(toolResult);

      functionResponseParts.push({
        functionResponse: { name, response: { result: resultText } }
      });

      // Pictures ride as sibling parts of the same user turn rather than inside
      // functionResponse.parts. The SDK types do support the latter, but a sibling
      // inlineData part is the long-established form that every model version
      // accepts, and isSafeConversationStart still classifies the turn correctly
      // because it looks for a part with a functionResponse, which this still has.
      for (const media of mediaBlocksOf(toolResult)) {
        functionResponseParts.push({ media });
      }
    }

    messages.push({ role: 'user', parts: functionResponseParts });
    return true;
  }

  // ─── Gemini ADK pathway ─────────────────────────────────────────────────────

  #adkHasPriorContext = false;

  async startConversationWithGeminiAdk(userMessage, previousAgentContext = null) {
    const session = this.sessionManager.getSession(this.sessionId);
    const mode = session.mode;
    const { LlmAgent, Runner, InMemorySessionService, isFinalResponse } = await loadGoogleAdk();
    if (!this.geminiAdkSessionService) {
      this.geminiAdkSessionService = new InMemorySessionService();
    }

    this.sessionManager.addToConversationHistory(this.sessionId, {
      role: 'user',
      parts: [{ text: userMessage }]
    });

    // 'bare': getAdkTools strips the client_ prefix before registering, and this route
    // has no prompt-rewrite pass to reconcile a mismatch the way the SDK route does.
    let systemPrompt = this.#buildRouteSystemPrompt(mode, 'bare');
    const currentModel = session?.clientModel;
    let modelTokenCount = 0;

    if (currentModel) {
      const modelJson = JSON.stringify(currentModel, null, 2);
      modelTokenCount = encode(modelJson).length;
      this.sessionManager.updateModelTokenCount(this.sessionId, modelTokenCount);
      logger.log(`Model token count: ${modelTokenCount} (limit: ${config.agentMaxTokensForEngines}, exceeds: ${modelTokenCount > config.agentMaxTokensForEngines})`);
    }

    this.abortController = new AbortController();
    // @google/genai attaches an abort listener per HTTP request without removing it on
    // success, so a multi-tool ADK turn easily exceeds Node's default limit of 10.
    setMaxListeners(0, this.abortController.signal);
    const maxIterations = this.configManager.getMaxIterations();
    let maxIterationsHit = false;

    try {
      // Names, not instances: the tool objects are now rebuilt per model request (see
      // the toolset below), so nothing built here survives long enough to identify a
      // call by identity. The set is fixed for the session either way.
      const builtInAdkToolNames = this.#builtInToolNameSet();

      // A toolset rather than an array, so ADK re-resolves it before EVERY request
      // instead of once per turn — see createAdkLiveToolset. Both providers resolve
      // inside it: one rule, applied at one moment, for everything the model can see.
      // Client tools are re-listed alongside the built-ins even though nothing about
      // them can change mid-turn, because splitting the two would mean two answers to
      // "what is live right now" and only one of them kept current.
      //
      // What this list must never do is SHRINK around a name the model is still
      // holding: ADK ends the invocation on a call it cannot resolve, so the
      // model-state gates are enforced when a tool runs here, not by omission.
      // getAdkTools has the whole story.
      const adkToolset = await createAdkLiveToolset(async () => [
        ...await this.builtInToolProvider.getAdkTools(mode),
        // The same set the roster was built against a few lines up, so what this
        // registers and what the prompt announces are decided by one rule, not two.
        ...await this.dynamicToolProvider.getAdkTools(builtInAdkToolNames)
      ]);

      const pendingCallIds = new Map();

      const geminiThinking = this.#resolveGeminiThinking();
      const agent = new LlmAgent({
        name: this.configManager.getAgentName(),
        model: this.#resolveNativeModel(),
        // A function, not the string itself. ADK runs any *string* instruction
        // through injectSessionState, which treats every `{IDENTIFIER}` in it as a
        // session-state lookup and throws "Context variable not found" when the key
        // is absent. Our prompts are literal text, and an agent config that documents
        // a placeholder like `${DEPENDENCY_PATH}` killed the turn before the first
        // model call — the `$` sits outside the braces ADK matches, so shell-style
        // placeholders are not safe from it. The function form sets
        // requireStateInjection=false, so the prompt reaches Gemini verbatim.
        instruction: () => systemPrompt,
        tools: [adkToolset],
        generateContentConfig: {
          // Spread so a level that defines no effort sends no thinkingConfig at all.
          ...(geminiThinking ? { thinkingConfig: geminiThinking } : {})
        },
        // The only way to get a picture in front of the model on this route. ADK
        // drops anything but the returned value from a tool response, so the tools
        // queue their images and this drains the queue onto the request just before
        // it goes out. Returning undefined is the documented "carry on with the
        // request as modified" contract.
        beforeModelCallback: async ({ request }) => {
          // Both providers queue: a picture can come from a client tool or from a
          // built-in (generate_image, view_media), and either way ADK cannot carry
          // it back as a tool result.
          const pending = [
            ...this.builtInToolProvider.pendingAdkMedia.splice(0),
            ...this.dynamicToolProvider.pendingAdkMedia.splice(0)
          ];
          if (pending.length === 0 || !Array.isArray(request?.contents)) return undefined;

          const budget = new MediaBudget();
          for (const media of pending) {
            const parts = [{ text: `Image ${media.mediaId} returned by a tool:` }];

            let data = null;
            if (budget.take(media)) {
              try { data = this.mediaStore.readBase64(media.mediaId); } catch { data = null; }
            }

            if (data) {
              parts.push({ inlineData: { mimeType: media.mimeType, data } });
            } else {
              parts[0].text = this.mediaStore.describeForModel(media);
            }

            request.contents.push({ role: 'user', parts });
          }

          return undefined;
        },
        beforeToolCallback: async ({ tool, args }) => {
          const callId = `adk_${Date.now()}_${Math.random().toString(36).substr(2, 7)}`;
          const key = `${tool.name}::${JSON.stringify(args)}`;
          pendingCallIds.set(key, callId);
          const isBuiltIn = builtInAdkToolNames.has(tool.name);
          await this.#sendSlowToolMessageHelper(tool.name, args);
          await this.sendToClient(createToolCallNotificationMessage(
            this.sessionId, callId, tool.name, args, isBuiltIn
          ));
        },
        afterToolCallback: async ({ tool, args, toolResponse }) => {
          const key = `${tool.name}::${JSON.stringify(args)}`;
          const callId = pendingCallIds.get(key) || `adk_${Date.now()}`;
          pendingCallIds.delete(key);
          logger.log(`Gemini ADK: Tool call completed: ${tool.name}`);
          const responseType = this.#getResponseType(tool.name);
          const content = [{ type: 'text', text: String(toolResponse ?? '') }];
          await this.sendToClient(createToolCallCompletedMessage(
            this.sessionId, callId, tool.name, content, false, responseType
          ));
        }
      });

      const runner = new Runner({
        appName: 'sd-ai',
        agent,
        sessionService: this.geminiAdkSessionService
      });

      if (!this.geminiAdkSessionId) {
        this.geminiAdkSessionId = this.sessionId;
        await this.geminiAdkSessionService.createSession({
          appName: 'sd-ai',
          userId: this.sessionId,
          sessionId: this.geminiAdkSessionId
        });
        logger.log(`Gemini ADK: session created: ${this.geminiAdkSessionId}`);
      } else {
        logger.log(`Gemini ADK: Resuming session: ${this.geminiAdkSessionId}`);
      }

      let prompt = userMessage;
      if (previousAgentContext?.length > 0 && !this.#adkHasPriorContext) {
        const contextToReplay = previousAgentContext.slice(0, -1).map(toGeminiMessage);
        if (contextToReplay.length > 0) {
          logger.debug(`[Agent switch → ADK] Replaying ${contextToReplay.length} messages from prior agent.`);
          const contextText = await this.#buildPriorContextTextHelper(contextToReplay);
          prompt = `[Prior conversation context]\n${contextText}\n[End of prior context]\n\n${userMessage}`;
        }
        this.#adkHasPriorContext = true;
      }

      let currentMessage = { role: 'user', parts: [{ text: prompt }] };

      let turnCount = 0;
      while (true) {
        for await (const event of runner.runAsync({
          userId: this.sessionId,
          sessionId: this.geminiAdkSessionId,
          newMessage: currentMessage,
          abortSignal: this.abortController.signal
        })) {
          if (event.usageMetadata && !this.#geminiAdkReportedUsageMetadata.has(event.usageMetadata)) {
            this.#geminiAdkReportedUsageMetadata.add(event.usageMetadata);
            this.#logApiUsage(Provider.GOOGLE, event.usageMetadata);
          }

          if (this.stopRequested) break;
          await this.#handleGeminiAdkEvent(event);
          if (isFinalResponse(event)) turnCount++;
          if (turnCount >= maxIterations) {
            logger.warn(`Gemini ADK: agent reached max iterations (${maxIterations})`);
            maxIterationsHit = true;
            this.abortController.abort();
            break;
          }
        }

        if (this.stopRequested) break;
        if (this.#pendingMessages.length === 0) break;

        if (maxIterationsHit) {
          logger.warn(`Gemini ADK: max iterations (${maxIterations}) hit; draining queued message with fresh budget`);
          maxIterationsHit = false;
          // Previous run aborted the controller — create a fresh one for the next run.
          this.abortController = new AbortController();
          setMaxListeners(0, this.abortController.signal);
        }

        const next = this.#pendingMessages.shift();
        logger.log(`Gemini ADK: processing queued message (remaining: ${this.#pendingMessages.length})`);
        currentMessage = { role: 'user', parts: [{ text: next }] };
        turnCount = 0;
      }

      if (this.stopRequested) {
        this.stopRequested = false;
        await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'awaiting_user', 'Agent stopped by user request'));
      } else if (maxIterationsHit) {
        logger.log(`Gemini ADK: max iterations hit ${this.sessionId}`);
        await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'awaiting_user', `Reached maximum iterations (${maxIterations})`));
      } else {
        logger.log(`Gemini ADK: conversation completed successfully for session ${this.sessionId}`);
        await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'success', 'Task completed successfully'));
      }

    } catch (error) {
      if (maxIterationsHit) {
        logger.log(`Gemini ADK: agent reached max iterations for session ${this.sessionId}`);
        await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'awaiting_user', `Reached maximum iterations (${maxIterations})`));
      } else if (error.name === 'AbortError' || this.stopRequested) {
        this.stopRequested = false;
        logger.log(`Gemini ADK: agent stopped for session ${this.sessionId}`);
        await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'awaiting_user', 'Agent stopped by user request'));
      } else {
        logger.error('Gemini ADK: in ADK conversation loop:', error);
        await this.sendToClient(createErrorMessage(this.sessionId, `Agent error: ${error.message}`, 'AGENT_ERROR'));
        await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'awaiting_user', `Agent error: ${error.message}`));
      }
    } finally {
      this.abortController = null;
    }
  }

  async #handleGeminiAdkEvent(event) {
    if (event.errorCode) {
      throw new Error(event.errorMessage || `ADK error: ${event.errorCode}`);
    }

    const content = event.content;
    if (!content?.parts) return;

    const rawTextParts = [];
    for (const part of content.parts) {
      if (part.thought) continue;
      if (part.text && !event.partial) {
        rawTextParts.push(part.text);
        const html = await marked.parse(part.text);
        await this.sendToClient(createAgentTextMessage(this.sessionId, html, false));
      }
    }

    if (rawTextParts.length > 0) {
      this.sessionManager.addToConversationHistory(this.sessionId, {
        role: 'model',
        parts: [{ text: rawTextParts.join('\n') }]
      });
    }
  }

  // ─── Shared Gemini helpers ──────────────────────────────────────────────────

  async #sendSlowToolMessageHelper(toolName, args) {
    if (toolName === 'create_visualization') {
      const vizType = args?.useAICustom ? 'AI-generated custom' : (args?.type || 'standard');
      await this.sendToClient(createAgentProgressMessage(this.sessionId, `Creating ${vizType} visualization: "${args?.title || 'visualization'}"... This may take a moment.`));
    } else if (toolName === 'draw_causal_loop_diagram') {
      await this.sendToClient(createAgentProgressMessage(this.sessionId, `Drawing causal loop diagram: "${args?.title || 'Causal Loop Diagram'}"... This may take a moment.`));
    } else if (toolName === 'get_variable_data') {
      const varCount = args?.variableNames?.length || 0;
      const runCount = args?.runIds?.length || 0;
      await this.sendToClient(createAgentProgressMessage(this.sessionId, `Retrieving data for ${varCount} variable${varCount !== 1 ? 's' : ''} from ${runCount} run${runCount !== 1 ? 's' : ''}...`));
    } else if (toolName === 'get_feedback_information') {
      const runCount = args?.runIds?.length || 0;
      const runText = runCount === 0 ? 'all runs' : `${runCount} run${runCount !== 1 ? 's' : ''}`;
      await this.sendToClient(createAgentProgressMessage(this.sessionId, `Analyzing feedback loops for ${runText}... This may take a moment.`));
    } else if (toolName === 'run_model') {
      await this.sendToClient(createAgentProgressMessage(this.sessionId, `Running model simulation...`));
    } else if (toolName === 'discuss_model_with_seldon') {
      await this.sendToClient(createAgentProgressMessage(this.sessionId, `Consulting Seldon for expert analysis...`));
    } else if (toolName === 'discuss_model_across_runs') {
      await this.sendToClient(createAgentProgressMessage(this.sessionId, `Analyzing model behavior across runs...`));
    } else if (toolName === 'discuss_with_mentor') {
      await this.sendToClient(createAgentProgressMessage(this.sessionId, `Consulting Seldon mentor for guidance...`));
    }
  }

  executeToolCallGeminiManual(toolUse) {
    try {
      const builtInTools = this.builtInToolProvider.getTools();
      if (builtInTools.tools[toolUse.name]) {
        const refusal = this.#refuseSandboxWrite(builtInTools.tools[toolUse.name], toolUse.name);
        if (refusal) return Promise.resolve(refusal);

        return builtInTools.tools[toolUse.name].handler(toolUse.input);
      }
      if (this.dynamicToolProvider.isClientTool(toolUse.name)) {
        // Through the registered handler, so the tool's declared timeout and media
        // contract are honoured — see executeToolCallHelper for what calling around
        // it cost. Already an envelope; do not re-wrap it.
        return this.dynamicToolProvider.getTools().tools[toolUse.name].handler(toolUse.input);
      }
      return Promise.resolve({ content: [{ type: 'text', text: `Tool not found: ${toolUse.name}` }], isError: true });
    } catch (error) {
      logger.error(`Gemini Manual: Error executing tool ${toolUse.name}:`, error);
      return Promise.resolve({ content: [{ type: 'text', text: error.message }], isError: true });
    }
  }

  #geminiManualConvertTools(builtInTools, dynamicTools, mode) {
    const declarations = [];
    const toolNames = new Set();
    const session = this.sessionManager.getSession(this.sessionId);

    for (const [toolName, toolDef] of Object.entries(builtInTools.tools)) {
      if (toolNames.has(toolName)) continue;
      if (!isToolActive(toolDef, { mode, session, canWriteToLocalSandbox: this.configManager.canWriteToLocalSandbox() })) continue;

      toolNames.add(toolName);
      declarations.push({
        name: toolName,
        description: toolDef.description,
        parameters: sanitizeSchemaForGemini(toolDef.inputSchema.toJSONSchema())
      });
    }

    if (dynamicTools?.tools) {
      for (const [toolName, toolDef] of Object.entries(dynamicTools.tools)) {
        if (toolNames.has(toolName)) continue;
        toolNames.add(toolName);
        declarations.push({
          name: toolName,
          description: toolDef.description,
          parameters: sanitizeSchemaForGemini(toolDef.inputSchema.toJSONSchema())
        });
      }
    }

    return declarations;
  }

  /**
   * @param geminiModel   the caller's pinned model for this turn. Passed in rather than
   *                      re-resolved so every iteration of one turn caches against the
   *                      same model even if the level changes while the turn is running.
   * @param geminiThinking the caller's pinned thinkingConfig, or undefined to send none.
   */
  async #getGeminiManualConfig(systemPrompt, toolDeclarations, geminiModel, geminiThinking) {
    // A cache is created against a specific model, so the model belongs in the key.
    // setIntelligence() also clears the cache explicitly, but keying on the model means
    // any future path that changes it can't silently reuse a cache built for another.
    // Build a cache key from the stable inputs — recreate if they change (e.g. tool set changes on model resize)
    const cacheKey = geminiModel + systemPrompt + JSON.stringify(toolDeclarations.map(t => t.name));

    const cacheStillValid = this.#geminiManualCacheName &&
      this.#geminiManualCacheKey === cacheKey &&
      this.#geminiManualCacheExpiry && Date.now() < this.#geminiManualCacheExpiry;

    if (cacheStillValid) {
      return {
        cachedContent: this.#geminiManualCacheName,
        ...(geminiThinking ? { thinkingConfig: geminiThinking } : {})
      };
    }

    const gemini = await this.#getGemini();

    // Delete the old cache if the key changed or it expired
    if (this.#geminiManualCacheName) {
      try {
        await gemini.caches.delete({ name: this.#geminiManualCacheName });
      } catch (e) {
        // Gemini may have already expired the cache — ignore deletion failures
      }
      this.#geminiManualCacheName = null;
      this.#geminiManualCacheKey = null;
      this.#geminiManualCacheExpiry = null;
    }

    try {
      const cacheConfig = {
        ttl: '300s',
        systemInstruction: systemPrompt
      };
      if (toolDeclarations.length > 0) {
        cacheConfig.tools = [{ functionDeclarations: toolDeclarations }];
      }

      const cache = await gemini.caches.create({
        model: geminiModel,
        config: cacheConfig
      });

      this.#geminiManualCacheName = cache.name;
      this.#geminiManualCacheKey = cacheKey;
      this.#geminiManualCacheExpiry = Date.now() + 270_000; // 270s, 30s before 300s TTL

      return {
        cachedContent: cache.name,
        ...(geminiThinking ? { thinkingConfig: geminiThinking } : {})
      };
    } catch (e) {
      logger.warn('[gemini-cache] failed to create cache, falling back to uncached:', e.message);
      const cfg = {
        systemInstruction: systemPrompt,
        ...(geminiThinking ? { thinkingConfig: geminiThinking } : {})
      };
      if (toolDeclarations.length > 0) {
        cfg.tools = [{ functionDeclarations: toolDeclarations }];
      }
      return cfg;
    }
  }

  // ─── OpenRouter pathways ────────────────────────────────────────────────────

  /**
   * Surface the actual upstream-provider reason from an OpenRouter SDK error.
   * The SDK's default `.message` is just "Provider returned error" — the
   * actionable detail lives in `.error` (the upstream OR error block) and
   * `.body` (raw JSON), and the routed provider is on `.openrouterMetadata`.
   */
  #describeOpenRouterError(error) {
    if (!error) return 'unknown error';
    const parts = [error.message || error.toString()];
    const openrouterErr = error.error;
    if (openrouterErr) {
      if (typeof openrouterErr.code === 'number') parts.push(`code=${openrouterErr.code}`);
      if (openrouterErr.metadata) {
        try {
          parts.push(`metadata=${JSON.stringify(openrouterErr.metadata)}`);
        } catch { /* circular / unserializable — skip */ }
      }
    }
    if (error.openrouterMetadata) {
      try {
        parts.push(`routing=${JSON.stringify(error.openrouterMetadata)}`);
      } catch { /* skip */ }
    }
    if (error.body && typeof error.body === 'string') {
      // Body often contains the upstream provider's verbatim error — keep the
      // first ~1KB so logs stay readable but the cause is recoverable.
      const truncated = error.body.length > 1024 ? error.body.slice(0, 1024) + '…' : error.body;
      parts.push(`body=${truncated}`);
    }
    return parts.join(' | ');
  }

  /**
   * Resolve the model slug to use for the current brand provider. The brand is set
   * on construction; the slug comes from the matching entry in the shared registry
   * config.openRouterAgentProviders.
   */
  #resolveOpenRouterModel() {
    const model = config.openRouterAgentProviders[this.provider]?.model;
    if (!model) throw new Error(`No openRouterAgentProviders entry configured for provider "${this.provider}"`);
    return model;
  }

  /**
   * Resolve the model id for a native-API provider.
   *
   * The intelligence ladder wins when this provider has one; config.nativeAgentProviders
   * is the fallback, which is what keeps a provider with no ladder byte-identical to
   * its pre-feature behaviour without a branch at any call site.
   */
  #resolveNativeModel() {
    const level = this.#resolveLevelConfig();
    if (level?.model) return level.model;

    const model = config.nativeAgentProviders[this.provider]?.model;
    if (!model) throw new Error(`No nativeAgentProviders entry configured for provider "${this.provider}"`);
    return model;
  }

  /** The resolved level object for the current (provider, intelligence), or null. */
  #resolveLevelConfig() {
    return resolveLevel(this.provider, this.intelligence)?.level ?? null;
  }

  /**
   * Anthropic/OpenAI-style effort for the current level.
   *
   * Returns undefined when the level deliberately omits `effort` — callers must then
   * omit the parameter entirely rather than sending `undefined`, so the provider
   * applies its own default. A missing key and an explicit undefined are not the same
   * request; on the Anthropic path the latter risks a 400.
   */
  #resolveEffort() {
    return this.#resolveLevelConfig()?.effort;   // may legitimately be undefined
  }

  /** Anthropic `thinking` config; a level may override the shared default. */
  #resolveAnthropicThinking() {
    return this.#resolveLevelConfig()?.thinking ?? config.agentAnthropicThinking;
  }

  /**
   * Gemini `thinkingConfig`. Same omit-vs-default contract as #resolveEffort: a level
   * with no `effort` yields undefined and the caller drops the key.
   */
  #resolveGeminiThinking() {
    const level = this.#resolveLevelConfig();
    if (!level) return config.agentGeminiThinking; // no ladder -> pre-feature constant
    return level.effort === undefined ? undefined : { thinkingLevel: level.effort };
  }

  /**
   * Change the intelligence level on a live session.
   *
   * Deliberately does not tear anything down: conversation history lives in
   * SessionManager, and both the Anthropic and Gemini routes resolve their model per
   * turn, so a change simply applies to the next turn. An in-flight turn is left
   * alone — it finishes on the model it started with.
   *
   * The one thing that does need clearing is Gemini's context cache. It is created
   * against a specific model but keyed only on systemPrompt+tools, so without this
   * the next call would hand the new model a cache built for the old one.
   */
  setIntelligence(requested) {
    if (!supportsIntelligence(this.provider)) {
      logger.log(`[intelligence] provider "${this.provider}" does not use intelligence levels — ignoring "${requested}"`);
      return this.intelligence;
    }

    const previousModel = this.#resolveNativeModel();
    const resolved = resolveLevel(this.provider, requested);
    if (resolved.id === this.intelligence) return this.intelligence;

    this.intelligence = resolved.id;
    // Mutate in place: the tool providers hold a reference to this object.
    this.agentProfile.intelligence = resolved.id;

    if (this.#resolveNativeModel() !== previousModel) this.#invalidateGeminiManualCache();

    logger.log(`[intelligence] session ${this.sessionId} -> "${resolved.id}" (${this.#resolveNativeModel()})`);
    return this.intelligence;
  }

  /**
   * Drop the Gemini context cache so the next call rebuilds it against the current
   * model. Fire-and-forget: the delete is best-effort (Gemini may have expired it
   * already) and the local handles are what actually gate reuse.
   */
  #invalidateGeminiManualCache() {
    const name = this.#geminiManualCacheName;
    this.#geminiManualCacheName = null;
    this.#geminiManualCacheKey = null;
    this.#geminiManualCacheExpiry = null;
    if (!name) return;

    this.#getGemini()
      .then(gemini => gemini.caches.delete({ name }))
      .catch(() => { /* already expired or unreachable — the cleared handles suffice */ });
  }

  /**
   * Start conversation using @openrouter/agent (the OpenRouter Agent SDK).
   * Used for any provider in OPENROUTER_PROVIDERS (config.openRouterAgentProviders).
   * The brand selects the model slug; the gateway is shared.
   */
  async startConversationOpenRouterSDK(userMessage, previousAgentContext = null) {
    const session = this.sessionManager.getSession(this.sessionId);
    const mode = session.mode;
    const model = this.#resolveOpenRouterModel();
    const openRouterClient = await this.#getOpenRouter();
    const { callModel, stepCountIs } = await loadOpenRouterAgent();

    this.sessionManager.addToConversationHistory(this.sessionId, {
      role: 'user',
      content: userMessage
    });

    const systemPrompt = this.#buildRouteSystemPrompt(mode, 'prefixed');
    const currentModel = session?.clientModel;
    let modelTokenCount = 0;
    if (currentModel) {
      const modelJson = JSON.stringify(currentModel, null, 2);
      modelTokenCount = encode(modelJson).length;
      this.sessionManager.updateModelTokenCount(this.sessionId, modelTokenCount);
    }

    this.abortController = new AbortController();
    setMaxListeners(0, this.abortController.signal);
    const maxIterations = this.configManager.getMaxIterations();

    try {
      let userPromptText = userMessage;
      if (previousAgentContext?.length > 0) {
        const contextToReplay = previousAgentContext.slice(0, -1).map(toAnthropicMessage);
        if (contextToReplay.length > 0) {
          logger.debug(`[Agent switch → OpenRouter SDK] Replaying ${contextToReplay.length} messages from prior agent.`);
          const contextText = await this.#buildPriorContextTextHelper(contextToReplay);
          userPromptText = `[Prior conversation context]\n${contextText}\n[End of prior context]\n\n${userMessage}`;
        }
      }

      // Pass the system prompt as an inline 'system'-role message in the input
      // array rather than via `instructions`. OpenRouter forwards the Responses
      // API `instructions` field to upstream providers as a `developer`-role
      // message — which Alibaba (the Qwen upstream) rejects with
      // "developer is not one of ['system', 'assistant', 'user', 'tool', 'function']".
      // An explicit 'system'-role item is passed through verbatim.
      const baseRequest = {
        model,
        stopWhen: stepCountIs(maxIterations),
        // The stop button's only lever on this route — the anthropic and gemini
        // routes hand their signal to the SDK the same way. Without it
        // stopIteration() aborts a controller @openrouter/agent never sees: the
        // tool loop keeps requesting turns and keeps calling client tools that
        // the stopped front end is no longer answering, so the run never unwinds,
        // the finally below never runs, and everything it spent goes unreported.
        // The SDK composes this into the in-flight API request AND into every
        // tool execution it races, so both halves of a wedged turn come loose.
        signal: this.abortController.signal,
      };

      let input = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPromptText }
      ];

      while (true) {
        if (this.stopRequested) break;
        this.#openRouterSdkFailureDetail = null;

        // Rebuilt per queued message rather than once for the whole conversation:
        // this is the only moment on this route where a new list can reach the
        // model, and the message being drained may well have been typed BECAUSE
        // the user changed the model in their own application while the agent was
        // working. `callModel` runs its entire tool loop against the array handed
        // to it, so what is decided here holds until this run ends.
        const orTools = await this.#buildOpenRouterTools(mode);

        // Drive everything off the SDK's event broadcaster so we see items
        // from every turn — including the INITIAL response (whose output never
        // reaches onTurnEnd) and any text the model emits alongside tool
        // calls. `response.output_item.done` fires once per completed item
        // across all turns; `tool.call_output` carries the executed tool's
        // result; `response.completed` carries each response's usage so we
        // can report it immediately rather than waiting for getResponse() to
        // resolve (which an abort skips); `getToolCallsStream()` gives us
        // parsed-argument tool calls for live notifications before execution.
        const result = callModel(openRouterClient, {
          ...baseRequest,
          tools: orTools,
          input
        });

        const notifiedToolCallIds = new Set();
        const completedToolCallIds = new Set();
        // FunctionCallOutputItem has no `name` field, so we look up the tool's
        // display name from the parsed call we saw on the notification side.
        const toolCallNames = new Map();
        const builtInToolMap = this.builtInToolProvider.getTools().tools;
        const sdkFsTools = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];

        const notifyStreamTask = (async () => {
          try {
            for await (const toolCall of result.getToolCallsStream()) {
              if (this.stopRequested) break;
              if (!toolCall?.id || !toolCall?.name) continue;
              if (notifiedToolCallIds.has(toolCall.id)) continue;
              notifiedToolCallIds.add(toolCall.id);
              toolCallNames.set(toolCall.id, toolCall.name);
              const isBuiltIn = !!builtInToolMap[toolCall.name] || sdkFsTools.includes(toolCall.name);
              const args = (toolCall.arguments && typeof toolCall.arguments === 'object') ? toolCall.arguments : {};
              await this.#sendSlowToolMessageHelper(toolCall.name, args);
              await this.sendToClient(createToolCallNotificationMessage(
                this.sessionId, toolCall.id, toolCall.name, args, isBuiltIn
              ));
            }
          } catch (err) {
            if (!this.stopRequested) {
              logger.warn(`OpenRouter SDK: tool-call notification stream error: ${err?.message ?? err}`);
            }
          }
        })();

        const eventStreamTask = (async () => {
          const seenItemIds = new Set();
          const countedResponseIds = new Set();
          try {
            for await (const event of result.getFullResponsesStream()) {
              // One terminal event per turn of the tool loop
              // (OPENROUTER_TERMINAL_RESPONSE_EVENTS), each carrying what that turn
              // alone billed — so they are summed into the run's total, not
              // overwritten. Completed, incomplete and failed all count: the last two
              // are the turns a stop or an upstream error ends on, and the provider
              // bills them the same. Deduped by response id across all three because
              // the SDK can reissue an event (see the item dedup below) and a second
              // copy would bill the same turn twice. Handled BEFORE the stop check so
              // the turn in flight when the user hits stop is still counted.
              if (OPENROUTER_TERMINAL_RESPONSE_EVENTS.has(event?.type)) {
                const response = event.response;
                if (response?.usage) {
                  const responseId = response.id;
                  if (!responseId || !countedResponseIds.has(responseId)) {
                    if (responseId) countedResponseIds.add(responseId);
                    this.#accumulateOpenRouterUsage(response.usage, model);
                  }
                }

                // A failed response is also the only place the upstream reason is
                // visible. Capture it before the SDK turns this same event into a
                // detail-free throw. Logged here too: on a follow-up turn the SDK
                // rejects immediately, and this is the record of what the provider
                // actually said.
                if (event.type === 'response.failed') {
                  const err = response?.error;
                  let detail;
                  try {
                    detail = typeof err === 'string' ? err : JSON.stringify(err);
                  } catch {
                    detail = String(err);
                  }
                  this.#openRouterSdkFailureDetail = detail ?? 'no error block on the failed response';
                  logger.error(`OpenRouter SDK: response.failed from ${model}: ${this.#openRouterSdkFailureDetail}`);
                }
                continue;
              }

              // After a stop, keep draining the stream rather than abandoning it.
              // The request already in flight is not cancelled, so its turns finish
              // and bill regardless; staying on the stream is what lets their
              // terminal events reach the accumulator above. This costs no extra
              // waiting — getResponse() below is blocked on the same work either
              // way. Everything client-facing is skipped from here on.
              if (this.stopRequested) continue;

              // Forwarding to the client is isolated from the drain: a send that
              // rejects (most often the socket going away, which is how a run stops
              // when the user closes the tab) must not abandon the stream. The turns
              // still in flight bill whether or not anyone is listening, and their
              // terminal events above are the only record of what they cost.
              try {
                // Tool execution completed — emit the completion message.
                if (event?.type === 'tool.call_output') {
                  const out = event.output;
                  if (!out?.callId || completedToolCallIds.has(out.callId)) continue;
                  completedToolCallIds.add(out.callId);
                  const text = typeof out.output === 'string'
                    ? out.output
                    : Array.isArray(out.output)
                      ? out.output.filter(o => o.type === 'input_text').map(o => o.text || '').join('\n')
                      : String(out.output ?? '');
                  const isError = out.status === 'incomplete';
                  const displayName = toolCallNames.get(out.callId) || 'tool';
                  const responseType = this.#getResponseType(displayName);
                  logger.log(`OpenRouter SDK: tool call completed: ${displayName}`);
                  await this.sendToClient(createToolCallCompletedMessage(
                    this.sessionId, out.callId, displayName,
                    [{ type: 'text', text }], isError, responseType
                  ));
                  continue;
                }

                // A complete output item from any turn (initial or follow-up):
                // message text, reasoning, function_call, function_call_output.
                if (event?.type === 'response.output_item.done' && event.item) {
                  const item = event.item;
                  // Cache the tool name keyed by callId BEFORE dedup — the
                  // matching tool.call_output later in this same stream looks it
                  // up to label the completion message. function_call always
                  // arrives here before its corresponding tool.call_output.
                  if (item.type === 'function_call' && item.callId && item.name) {
                    toolCallNames.set(item.callId, item.name);
                  }
                  // Dedup by item id when the SDK supplies one — output_item.done
                  // can fire more than once for a logical item across reissues.
                  if (item.id) {
                    if (seenItemIds.has(item.id)) continue;
                    seenItemIds.add(item.id);
                  }
                  await this.#handleOpenRouterItem(item, notifiedToolCallIds, completedToolCallIds);
                  continue;
                }
              } catch (err) {
                if (!this.stopRequested) {
                  logger.warn(`OpenRouter SDK: failed to forward a ${event?.type} event to the client: ${err?.message ?? err}`);
                }
              }
            }
          } catch (err) {
            if (!this.stopRequested) {
              logger.warn(`OpenRouter SDK: event stream error: ${err?.message ?? err}`);
            }
          }
        })();

        try {
          await result.getResponse();
        } catch (e) {
          // If a stop was requested mid-flight, getResponse may reject before
          // resolving. The latest cumulative usage captured from
          // response.completed gets flushed in the finally block.
          if (this.stopRequested) {
            logger.debug(`OpenRouter SDK: getResponse() aborted after stop: ${e?.message ?? e}`);
            await Promise.allSettled([notifyStreamTask, eventStreamTask]);
            break;
          }
          await Promise.allSettled([notifyStreamTask, eventStreamTask]);
          throw e;
        }

        // Drain the side-streams so every item has been forwarded to the
        // client before we close this iteration.
        await Promise.allSettled([notifyStreamTask, eventStreamTask]);

        // Report what every turn of this tool loop billed, once per iteration of
        // the outer queued-message loop.
        this.#flushOpenRouterUsage();

        if (this.stopRequested) break;

        if (this.#pendingMessages.length === 0) break;
        const next = this.#pendingMessages.shift();
        logger.log(`OpenRouter SDK: processing queued message (remaining: ${this.#pendingMessages.length})`);
        // Re-seed input for the next queued turn — system stays, user becomes
        // the queued text.
        input = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: next }
        ];
      }

      if (this.stopRequested) {
        this.stopRequested = false;
        await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'awaiting_user', 'Agent stopped by user request'));
      } else {
        logger.log(`OpenRouter SDK: conversation completed successfully for session ${this.sessionId}`);
        await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'success', 'Task completed successfully'));
      }
    } catch (error) {
      if (error.name === 'AbortError' || this.stopRequested) {
        this.stopRequested = false;
        logger.log(`OpenRouter SDK: agent stopped for session ${this.sessionId}`);
        await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'awaiting_user', 'Agent stopped by user request'));
      } else {
        // "Response failed" on its own says nothing — the SDK drops the cause on
        // the floor. Attach whatever the response.failed event carried so the log
        // line names the provider's actual complaint.
        const described = this.#describeOpenRouterError(error);
        const detail = this.#openRouterSdkFailureDetail
          ? `${described} | upstream=${this.#openRouterSdkFailureDetail}`
          : described;
        logger.error(`OpenRouter SDK: in conversation loop: ${detail}`);
        await this.sendToClient(createErrorMessage(this.sessionId, `Agent error: ${detail}`, 'AGENT_ERROR'));
        await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'awaiting_user', `Agent error: ${detail}`));
      }
    } finally {
      // A user stop, an abort or an error skips the in-loop flush above, so the
      // tokens the run spent before it ended are reported here instead.
      this.#flushOpenRouterUsage();
      this.#openRouterSdkFailureDetail = null;
      this.abortController = null;
    }
  }

  /**
   * Hand-rolled tool loop on top of OpenRouter's chat completions API — the
   * counterpart to startConversationAnthropicManual for any OpenRouter brand.
   */
  async startConversationOpenRouterManual(userMessage) {
    try {
      const session = this.sessionManager.getSession(this.sessionId);
      const model = this.#resolveOpenRouterModel();
      const openRouterClient = await this.#getOpenRouter();

      this.sessionManager.addToConversationHistory(this.sessionId, {
        role: 'user',
        content: userMessage
      });

      const mode = session.mode;
      const systemPrompt = this.#buildRouteSystemPrompt(mode, 'prefixed');
      const builtInTools = this.builtInToolProvider.getTools();
      const dynamicTools = this.dynamicToolProvider.getTools();

      await this.sessionManager.cleanupContext(this.sessionId, config.agentMaxContextTokens, this.provider);

      const messages = this.sessionManager.getConversationContext(this.sessionId);
      // Normalize Anthropic/Gemini formats to plain {role, content} for the chat API.
      for (let i = 0; i < messages.length; i++) {
        const m = toAnthropicMessage(messages[i]);
        const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user';
        const content = typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content.filter(b => b.type === 'text').map(b => b.text || '').join('\n')
            : '';
        messages[i] = { role, content };
      }
      for (let i = messages.length - 1; i >= 0; i--) {
        if (!messages[i].content || (typeof messages[i].content === 'string' && messages[i].content.trim() === '')) messages.splice(i, 1);
      }

      const currentModel = session?.clientModel;
      let modelTokenCount = 0;
      if (currentModel) {
        const modelJson = JSON.stringify(currentModel, null, 2);
        modelTokenCount = countTokens(modelJson);
        this.sessionManager.updateModelTokenCount(this.sessionId, modelTokenCount);
      }

      const maxIterations = this.configManager.getMaxIterations();

      while (true) {
        let continueLoop = true;
        let completedNaturally = false;
        let iteration = 0;

        while (continueLoop && iteration < maxIterations && !this.stopRequested) {
          iteration++;
          await this.sessionManager.cleanupContext(this.sessionId, config.agentMaxContextTokens, this.provider);

          // Rebuilt per iteration so the list tracks the model — see anthropic-manual.
          const chatTools = this.#openRouterManualConvertTools(builtInTools, dynamicTools, mode);

          try {
            const completion = await openRouterClient.chat.send({
              chatRequest: {
                model,
                // Transient copy — see the anthropic-manual call for why history
                // must never hold the bytes.
                messages: [
                  { role: 'system', content: systemPrompt },
                  ...hydrateMessagesForOpenRouter(messages, this.mediaStore)
                ],
                tools: chatTools.length > 0 ? chatTools : undefined,
              }
            });

            // Each chat.send bills its own request, so an iteration's usage adds to
            // the run's total rather than replacing it. Recorded before the stop
            // check below, so a stop landing between this response and the next
            // iteration still counts the turn the user was charged for.
            this.#accumulateOpenRouterUsage(completion?.usage, model);

            if (this.stopRequested) break;

            continueLoop = await this.processOpenRouterManualResponse(completion, messages, builtInTools, dynamicTools);
            if (!continueLoop && !this.stopRequested) completedNaturally = true;

            if (this.stopRequested) break;
          } catch (error) {
            const detail = this.#describeOpenRouterError(error);
            logger.error(`OpenRouter Manual: error in agent conversation loop: ${detail}`);
            await this.sendToClient(createErrorMessage(this.sessionId, `Agent error: ${detail}`, 'AGENT_ERROR'));
            await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'awaiting_user', 'Agent stopped due to error'));
            continueLoop = false;
            completedNaturally = true;
          }
        }

        if (this.stopRequested) {
          logger.log(`OpenRouter Manual: agent stopped by user request for session ${this.sessionId}`);
          this.stopRequested = false;
          await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'awaiting_user', 'Agent stopped by user request'));
          break;
        }
        const reachedMax = !completedNaturally && iteration >= maxIterations;
        if (this.#pendingMessages.length === 0) {
          if (reachedMax) {
            logger.log(`OpenRouter Manual: agent conversation reached max iterations (${maxIterations})`);
            await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'awaiting_user', `Reached maximum iterations (${maxIterations})`));
          }
          break;
        }
        if (reachedMax) logger.log(`OpenRouter Manual: max iterations (${maxIterations}) hit; draining queued message with fresh budget`);
        const next = this.#pendingMessages.shift();
        logger.log(`OpenRouter Manual: processing queued message (remaining: ${this.#pendingMessages.length})`);
        // `messages` IS the live session context — one append, not two.
        this.sessionManager.addToConversationHistory(this.sessionId, { role: 'user', content: next });
      }
    } catch (error) {
      // Catches setup-time failures (resolveModel, cleanupContext, tool conversion,
      // etc.) and anything else outside the per-iteration try. Without this they'd
      // bubble to startConversation's generic handler that only logs `error.message`
      // and we'd lose the upstream provider's actual rejection reason.
      const detail = this.#describeOpenRouterError(error);
      logger.error(`OpenRouter Manual: in conversation setup: ${detail}`);
      await this.sendToClient(createErrorMessage(this.sessionId, `Agent error: ${detail}`, 'AGENT_ERROR'));
      await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'awaiting_user', `Agent error: ${detail}`));
    } finally {
      // One exit for all of them — natural end, user stop, max iterations, a failed
      // request, a setup error — so however the loop ended, what it spent is reported.
      this.#flushOpenRouterUsage();
    }
  }

  /**
   * Start conversation for a native-API provider whose own API is OpenAI-compatible
   * (OPENAI_COMPATIBLE_PROVIDERS — currently deepseek and openai). The request goes to
   * the vendor's own API through the official `openai` client.
   *
   * Self-contained on purpose: tool conversion, response processing, media hydration and
   * error description all have OpenAI-route implementations of their own. The OpenRouter
   * loop looks similar because both descend from OpenAI's function-calling shape, but
   * @openrouter/sdk speaks camelCase (toolCalls / toolCallId / imageUrl) and validates
   * against it, while this client speaks the wire format and 400s on an unrecognized
   * property. Sharing the code meant one dialect silently losing the other's tool calls,
   * so the routes are kept apart rather than bridged by a translation step.
   */
  async startConversationOpenAiCompatibleManual(userMessage) {
    const label = `${this.provider} Manual`;
    try {
      const session = this.sessionManager.getSession(this.sessionId);
      const model = this.#resolveNativeModel();
      const client = await this.#getOpenAiCompatibleClient();

      this.sessionManager.addToConversationHistory(this.sessionId, {
        role: 'user',
        content: userMessage
      });

      const mode = session.mode;
      const systemPrompt = this.#buildRouteSystemPrompt(mode, 'prefixed');
      const builtInTools = this.builtInToolProvider.getTools();
      const dynamicTools = this.dynamicToolProvider.getTools();

      await this.sessionManager.cleanupContext(this.sessionId, config.agentMaxContextTokens, this.provider);

      const messages = this.sessionManager.getConversationContext(this.sessionId);
      // Normalize Anthropic/Gemini formats to plain {role, content} for the chat API.
      for (let i = 0; i < messages.length; i++) {
        const m = toAnthropicMessage(messages[i]);
        const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user';
        const content = typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content.filter(b => b.type === 'text').map(b => b.text || '').join('\n')
            : '';
        messages[i] = { role, content };
      }
      for (let i = messages.length - 1; i >= 0; i--) {
        if (!messages[i].content || (typeof messages[i].content === 'string' && messages[i].content.trim() === '')) messages.splice(i, 1);
      }

      const currentModel = session?.clientModel;
      let modelTokenCount = 0;
      if (currentModel) {
        const modelJson = JSON.stringify(currentModel, null, 2);
        modelTokenCount = countTokens(modelJson);
        this.sessionManager.updateModelTokenCount(this.sessionId, modelTokenCount);
      }

      const maxIterations = this.configManager.getMaxIterations();

      while (true) {
        let continueLoop = true;
        let completedNaturally = false;
        let iteration = 0;

        while (continueLoop && iteration < maxIterations && !this.stopRequested) {
          iteration++;
          await this.sessionManager.cleanupContext(this.sessionId, config.agentMaxContextTokens, this.provider);

          // Rebuilt per iteration so the list tracks the model — see anthropic-manual.
          const chatTools = this.#openAiManualConvertTools(builtInTools, dynamicTools, mode);

          try {
            const completion = await client.chat.completions.create({
              model,
              // Transient copy — see the anthropic-manual call for why history
              // must never hold the bytes.
              messages: [
                { role: 'system', content: systemPrompt },
                ...hydrateMessagesForOpenAi(messages, this.mediaStore)
              ],
              tools: chatTools.length > 0 ? chatTools : undefined,
              ...reasoningParams(this.provider),
            });

            // Reported per request, on the line after it returns, exactly as the
            // anthropic and gemini manual loops do. Every stop check below is
            // downstream of this, so no turn the user was billed for can be lost by
            // ending the loop early. Deferring a summed total to the end would be
            // wrong twice over: it drops every turn but the last if the run ends
            // early, and openai's tiers bill by the size of a single prompt — a
            // summed input count crosses the 272K long-context threshold that no
            // individual request came near, doubling the rate for the whole run.
            if (completion?.usage)
              this.#logApiUsage(usageProviderFor(this.provider), completion.usage, model);

            if (this.stopRequested) break;

            continueLoop = await this.processOpenAiManualResponse(completion, messages, builtInTools, dynamicTools);
            if (!continueLoop && !this.stopRequested) completedNaturally = true;

            if (this.stopRequested) break;
          } catch (error) {
            const detail = this.#describeOpenAiError(error);
            logger.error(`${label}: error in agent conversation loop: ${detail}`);
            await this.sendToClient(createErrorMessage(this.sessionId, `Agent error: ${detail}`, 'AGENT_ERROR'));
            await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'awaiting_user', 'Agent stopped due to error'));
            continueLoop = false;
            completedNaturally = true;
          }
        }

        if (this.stopRequested) {
          logger.log(`${label}: agent stopped by user request for session ${this.sessionId}`);
          this.stopRequested = false;
          await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'awaiting_user', 'Agent stopped by user request'));
          break;
        }
        const reachedMax = !completedNaturally && iteration >= maxIterations;
        if (this.#pendingMessages.length === 0) {
          if (reachedMax) {
            logger.log(`${label}: agent conversation reached max iterations (${maxIterations})`);
            await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'awaiting_user', `Reached maximum iterations (${maxIterations})`));
          }
          break;
        }
        if (reachedMax) logger.log(`${label}: max iterations (${maxIterations}) hit; draining queued message with fresh budget`);
        const next = this.#pendingMessages.shift();
        logger.log(`${label}: processing queued message (remaining: ${this.#pendingMessages.length})`);
        // `messages` IS the live session context — one append, not two.
        this.sessionManager.addToConversationHistory(this.sessionId, { role: 'user', content: next });
      }
    } catch (error) {
      // Catches setup-time failures (resolveModel, cleanupContext, tool conversion,
      // etc.) and anything else outside the per-iteration try.
      const detail = this.#describeOpenAiError(error);
      logger.error(`${label}: in conversation setup: ${detail}`);
      await this.sendToClient(createErrorMessage(this.sessionId, `Agent error: ${detail}`, 'AGENT_ERROR'));
      await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'awaiting_user', `Agent error: ${detail}`));
    }
  }

  /**
   * Tool declarations for the OpenAI chat-completions API: `{type:'function', function:
   * {name, description, parameters}}`, filtered by the same availability rules every
   * route applies.
   */
  #openAiManualConvertTools(builtInTools, dynamicTools, mode) {
    const tools = [];
    const seen = new Set();
    const session = this.sessionManager.getSession(this.sessionId);
    for (const [toolName, toolDef] of Object.entries(builtInTools.tools)) {
      if (seen.has(toolName)) continue;
      if (!isToolActive(toolDef, { mode, session, canWriteToLocalSandbox: this.configManager.canWriteToLocalSandbox() })) continue;
      seen.add(toolName);
      tools.push({
        type: 'function',
        function: {
          name: toolName,
          description: toolDef.description,
          parameters: toolDef.inputSchema.toJSONSchema()
        }
      });
    }
    if (dynamicTools?.tools) {
      for (const [toolName, toolDef] of Object.entries(dynamicTools.tools)) {
        if (seen.has(toolName)) continue;
        seen.add(toolName);
        tools.push({
          type: 'function',
          function: {
            name: toolName,
            description: toolDef.description,
            parameters: toolDef.inputSchema.toJSONSchema()
          }
        });
      }
    }
    return tools;
  }

  /**
   * Process one chat-completions response from a native OpenAI-compatible provider:
   * emit the assistant text, run every tool call, and append the turn plus its results
   * to the live session context.
   *
   * Reads and writes the wire format — `tool_calls` on the assistant turn, `tool_call_id`
   * on the tool turn — because that is what this client sends and receives verbatim.
   * Returns true when the loop should iterate again (tool calls were answered).
   */
  async processOpenAiManualResponse(completion, messages, builtInTools, dynamicTools) {
    const message = completion.choices?.[0]?.message ?? {};
    const hasText = typeof message.content === 'string' && message.content.trim() !== '';
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    if (hasText) {
      const html = await marked.parse(message.content);
      await this.sendToClient(createAgentTextMessage(this.sessionId, html, false));
    }

    // Commit the assistant turn exactly once. `messages` IS the live session context, so
    // addToConversationHistory is the whole write — a companion messages.push would
    // duplicate the turn, and when the response carries both text and tool calls the text
    // belongs on the tool_calls turn rather than on a separate text-only turn ahead of it.
    if (toolCalls.length === 0) {
      if (hasText) {
        this.sessionManager.addToConversationHistory(this.sessionId, { role: 'assistant', content: message.content });
      }
      await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'success', 'Task completed successfully'));
      return false;
    }

    this.sessionManager.addToConversationHistory(this.sessionId, {
      role: 'assistant',
      content: message.content ?? '',
      tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.function?.name, arguments: tc.function?.arguments } }))
    });

    const pendingMedia = [];

    for (const tc of toolCalls) {
      if (this.stopRequested) return false;

      const name = tc.function?.name;
      let args = {};
      try { args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { /* leave empty */ }
      const isBuiltIn = this.#isBuiltInTool(name, builtInTools);
      await this.#sendSlowToolMessageHelper(name, args);
      await this.sendToClient(createToolCallNotificationMessage(this.sessionId, tc.id, name, args, isBuiltIn));

      const toolResult = await this.executeToolCallHelper({ name, input: args }, builtInTools, dynamicTools);
      if (this.stopRequested) return false;

      const resultText = toolResultToText(toolResult);

      logger.log(`${this.provider} Manual: tool call completed: ${name}`);
      const responseType = this.#getResponseType(name);
      await this.sendToClient(createToolCallCompletedMessage(
        this.sessionId, tc.id, name, toolResult.content, toolResult.isError, responseType
      ));

      // The tool message stays text-only: OpenAI rejects a non-text tool result outright.
      // Pictures go in a user turn after the loop instead.
      messages.push({ role: 'tool', tool_call_id: tc.id, content: resultText });

      for (const media of mediaBlocksOf(toolResult)) {
        pendingMedia.push({ toolName: name, media });
      }
    }

    // After the loop, never inside it: every entry in tool_calls has to be answered by a
    // tool message before any other role appears, or the API 400s the whole request. So
    // one trailing turn carries whatever pictures this round produced.
    if (pendingMedia.length > 0) {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Images returned by ${[...new Set(pendingMedia.map(p => p.toolName))].join(', ')}:`
          },
          ...pendingMedia.map(p => p.media)
        ]
      });
    }

    return true;
  }

  /**
   * Surface the actionable detail from an official `openai` client error. Its `.message`
   * already carries the API's own sentence, but the status, the machine-readable code and
   * the request id are what make a 400 reproducible — and the request id is the only
   * thing OpenAI support can act on.
   */
  #describeOpenAiError(error) {
    if (!error) return 'unknown error';
    const parts = [error.message || error.toString()];
    if (error.status !== undefined) parts.push(`status=${error.status}`);
    if (error.code) parts.push(`code=${error.code}`);
    if (error.type) parts.push(`type=${error.type}`);
    if (error.param) parts.push(`param=${error.param}`);
    if (error.request_id) parts.push(`request_id=${error.request_id}`);
    return parts.join(' | ');
  }

  /**
   * Translate an item from @openrouter/agent's `getNewMessagesStream` into client
   * websocket messages — assistant text, tool-call notifications, and tool results.
   */
  async #handleOpenRouterItem(item, notifiedToolCallIds, completedToolCallIds) {
    if (!item || !item.type) {
      logger.warn(`OpenRouter SDK: dropping malformed item: ${JSON.stringify(item)?.slice(0, 500)}`);
      return;
    }

    if (item.type === 'message') {
      if (item.role !== 'assistant') {
        logger.debug(`OpenRouter SDK: skipping non-assistant message (role=${item.role})`);
        return;
      }
      const parts = Array.isArray(item.content) ? item.content : [];
      // Pull text from every text-bearing part type the Responses API may emit:
      // output_text (normal), refusal (safety stop), text (fallback shape some
      // upstreams use). Anything else gets logged so we can extend later.
      const textSegments = [];
      for (const p of parts) {
        if (!p || typeof p !== 'object') continue;
        if (p.type === 'output_text' && typeof p.text === 'string') {
          textSegments.push(p.text);
        } else if (p.type === 'refusal' && typeof p.refusal === 'string') {
          textSegments.push(p.refusal);
        } else if (p.type === 'text' && typeof p.text === 'string') {
          textSegments.push(p.text);
        } else {
          logger.warn(`OpenRouter SDK: unhandled message content part type=${p.type}`);
        }
      }
      const text = textSegments.join('').trim();
      if (text && text.length > 0) {
        const html = await marked.parse(text);
        await this.sendToClient(createAgentTextMessage(this.sessionId, html, false));
        this.sessionManager.addToConversationHistory(this.sessionId, { role: 'assistant', content: text });
      }
      return;
    }

    if (item.type === 'function_call' && item.name) {
      // Notifications normally fire live via getToolCallsStream(); the
      // dedup set tells us whether we already sent one. Fall back to
      // sending here only for items the live stream missed (defensive).
      if (notifiedToolCallIds?.has(item.callId)) {
        return;
      }
      const isBuiltIn = !!this.builtInToolProvider.getTools().tools[item.name] || ['Read', 'Edit', 'Write', 'Glob', 'Grep'].includes(item.name);
      let parsedInput = {};
      try { parsedInput = item.arguments ? JSON.parse(item.arguments) : {}; } catch { /* leave empty */ }
      await this.#sendSlowToolMessageHelper(item.name, parsedInput);
      await this.sendToClient(createToolCallNotificationMessage(this.sessionId, item.callId, item.name, parsedInput, isBuiltIn));
      notifiedToolCallIds?.add(item.callId);
      return;
    }

    if (item.type === 'function_call_output' && item.callId) {
      // Completions normally fire live via the tool.call_output event stream;
      // skip if already dispatched. This branch remains as a defensive fallback
      // for environments where the side-stream didn't surface the event.
      if (completedToolCallIds?.has(item.callId)) {
        return;
      }
      const output = typeof item.output === 'string'
        ? item.output
        : Array.isArray(item.output)
          ? item.output.filter(o => o.type === 'input_text').map(o => o.text || '').join('\n')
          : String(item.output ?? '');
      const isError = item.status === 'incomplete';
      const displayName = item.name || 'tool';
      logger.log(`OpenRouter SDK: tool call completed: ${displayName}`);
      const responseType = this.#getResponseType(displayName);
      await this.sendToClient(createToolCallCompletedMessage(
        this.sessionId, item.callId, displayName, [{ type: 'text', text: output }], isError, responseType
      ));
      completedToolCallIds?.add(item.callId);
      return;
    }

    if (item.type === 'reasoning') {
      return; //we don't want the chain of thought stuff
    }

    logger.warn(`OpenRouter SDK: unhandled item type=${item.type} — keys=${Object.keys(item).join(',')}`);
  }

  /**
   * Wrap built-in and dynamic tools in @openrouter/agent's `tool()` factory so
   * the agent loop auto-executes them.
   *
   * The one route that cannot re-advertise mid-run. `callModel` destructures `tools`
   * once at entry, converts it to wire format once, and sends that same array on every
   * turn of its internal loop; there is no per-turn hook that can replace it (tools is
   * not one of the async-resolvable request fields, and no lifecycle hook reaches the
   * outgoing declaration list). So this list is fixed from here until the run ends.
   *
   * Which is why it filters on isToolAvailable and not isToolActive. When a list cannot
   * be corrected, the two ways of being wrong are not symmetric: a tool advertised
   * while its model-state gate is closed costs one call, answered by a refusal that
   * says what to do instead ("build the structure first with generate_quantitative_model
   * ...") — while a tool withheld because the gate was closed when the run began stays
   * invisible for the whole run, including the entire stretch after the agent's own
   * generate_* call opened it. That second failure is the one this route kept hitting.
   * The gate still holds: every gated handler re-checks it at call time
   * (BuiltInToolProvider#applyModelStateGates), so nothing runs against a model it
   * cannot run against.
   */
  async #buildOpenRouterTools(mode) {
    const { tool: orTool } = await loadOpenRouterAgent();
    const builtInTools = this.builtInToolProvider.getTools();
    const dynamicTools = this.dynamicToolProvider.getTools();
    const session = this.sessionManager.getSession(this.sessionId);
    const tools = [];
    const seen = new Set();

    for (const [toolName, toolDef] of Object.entries(builtInTools.tools)) {
      if (seen.has(toolName)) continue;
      // isToolAvailable, not isToolActive — see the note above this method.
      if (!isToolAvailable(toolDef, { mode, session, canWriteToLocalSandbox: this.configManager.canWriteToLocalSandbox() })) continue;
      seen.add(toolName);

      tools.push(orTool({
        name: toolName,
        description: toolDef.description,
        inputSchema: toolDef.inputSchema,
        execute: async (input) => toOpenRouterAgentOutput(await toolDef.handler(input), this.mediaStore)
      }));
    }

    if (dynamicTools?.tools) {
      for (const [toolName, toolDef] of Object.entries(dynamicTools.tools)) {
        if (seen.has(toolName)) continue;
        seen.add(toolName);
        tools.push(orTool({
          name: toolName,
          description: toolDef.description,
          inputSchema: toolDef.inputSchema,
          execute: async (input) => {
            // Through the registered handler, exactly as the built-in branch above.
            // `toolDef` here is the *collection entry* — description, inputSchema,
            // handler, timeout — and not the client's own definition, so it has no
            // media contract on it: passing it to requestClientExecution looked right
            // and resolved nothing. Only the handler closes over the real definition.
            //
            // JSON.stringify used to be applied to the whole envelope here, so this
            // route showed the model `{"content":[...],"isError":false}` where every
            // other route showed it the text. @openrouter/agent preserves a
            // multimodal array verbatim, so a picture goes straight out with no
            // history hydration on this route.
            return toOpenRouterAgentOutput(await toolDef.handler(input), this.mediaStore);
          }
        }));
      }
    }

    return tools;
  }

  #openRouterManualConvertTools(builtInTools, dynamicTools, mode) {
    const tools = [];
    const seen = new Set();
    const session = this.sessionManager.getSession(this.sessionId);
    for (const [toolName, toolDef] of Object.entries(builtInTools.tools)) {
      if (seen.has(toolName)) continue;
      if (!isToolActive(toolDef, { mode, session, canWriteToLocalSandbox: this.configManager.canWriteToLocalSandbox() })) continue;
      seen.add(toolName);
      tools.push({
        type: 'function',
        function: {
          name: toolName,
          description: toolDef.description,
          parameters: toolDef.inputSchema.toJSONSchema()
        }
      });
    }
    if (dynamicTools?.tools) {
      for (const [toolName, toolDef] of Object.entries(dynamicTools.tools)) {
        if (seen.has(toolName)) continue;
        seen.add(toolName);
        tools.push({
          type: 'function',
          function: {
            name: toolName,
            description: toolDef.description,
            parameters: toolDef.inputSchema.toJSONSchema()
          }
        });
      }
    }
    return tools;
  }

  async processOpenRouterManualResponse(completion, messages, builtInTools, dynamicTools) {
    const message = completion.choices?.[0]?.message ?? {};
    const hasText = typeof message.content === 'string' && message.content.trim() !== '';
    // camelCase, which is @openrouter/sdk's dialect throughout. The native
    // OpenAI-compatible providers get their own processOpenAiManualResponse rather than
    // sharing this one — feeding a wire-format response through here made its tool calls
    // invisible, so the turn looked like an empty text answer and the agent reported
    // itself complete the moment it tried to use a tool.
    const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];

    if (hasText) {
      const html = await marked.parse(message.content);
      await this.sendToClient(createAgentTextMessage(this.sessionId, html, false));
    }

    // Commit the assistant turn exactly once. `messages` IS the live session
    // context, so addToConversationHistory is the whole write — a companion
    // messages.push would duplicate the turn, and when the response carries both
    // text and tool calls the text belongs on the toolCalls turn rather than on a
    // separate text-only turn ahead of it.
    if (toolCalls.length === 0) {
      if (hasText) {
        this.sessionManager.addToConversationHistory(this.sessionId, { role: 'assistant', content: message.content });
      }
      await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'success', 'Task completed successfully'));
      return false;
    }

    this.sessionManager.addToConversationHistory(this.sessionId, {
      role: 'assistant',
      content: message.content ?? '',
      toolCalls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.function?.name, arguments: tc.function?.arguments } }))
    });

    const pendingMedia = [];

    for (const tc of toolCalls) {
      if (this.stopRequested) return false;

      const name = tc.function?.name;
      let args = {};
      try { args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { /* leave empty */ }
      const isBuiltIn = this.#isBuiltInTool(name, builtInTools);
      await this.#sendSlowToolMessageHelper(name, args);
      await this.sendToClient(createToolCallNotificationMessage(this.sessionId, tc.id, name, args, isBuiltIn));

      const toolResult = await this.executeToolCallHelper({ name, input: args }, builtInTools, dynamicTools);
      if (this.stopRequested) return false;

      const resultText = toolResultToText(toolResult);

      logger.log(`OpenRouter Manual: tool call completed: ${name}`);
      const responseType = this.#getResponseType(name);
      await this.sendToClient(createToolCallCompletedMessage(
        this.sessionId, tc.id, name, toolResult.content, toolResult.isError, responseType
      ));

      // The tool message stays text-only: ChatToolMessage.content permits an array
      // in the SDK's types, but upstream support for a non-text tool result is
      // inconsistent and OpenAI rejects it outright. Pictures go in a user turn
      // after the loop instead.
      messages.push({ role: 'tool', toolCallId: tc.id, content: resultText });

      for (const media of mediaBlocksOf(toolResult)) {
        pendingMedia.push({ toolName: name, media });
      }
    }

    // After the loop, never inside it: every entry in toolCalls has to be answered
    // by a tool message before any other role appears, or the API 400s the whole
    // request. So one trailing turn carries whatever pictures this round produced.
    if (pendingMedia.length > 0) {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Images returned by ${[...new Set(pendingMedia.map(p => p.toolName))].join(', ')}:`
          },
          ...pendingMedia.map(p => p.media)
        ]
      });
    }

    return true;
  }

  /**
   * Request the agent to stop iterating
   */
  stopIteration() {
    logger.log(`Stop iteration requested for session ${this.sessionId}`);
    this.stopRequested = true;
    this.#pendingMessages = [];
    this.abortController?.abort();
    // Report what the OpenRouter run has spent so far right here, rather than only
    // from the flush on the way out of the loop. The tokens are already on the bill
    // at this point, and the way out is not guaranteed: a run can wedge on a turn
    // whose abort the provider or a tool never honors, and then no exit path ever
    // runs. Costs nothing when there is no OpenRouter run in flight, and cannot
    // double-bill — the flush clears what it reported, so the loop's own flush picks
    // up only whatever accumulates after this point.
    this.#flushOpenRouterUsage();
  }


  /**
   * Queue a new message from the user to be processed
   */
  queueMessage(message) {
    this.#pendingMessages.push(message);
    logger.debug(`[orchestrator:${this.sessionId}] Message queued (depth: ${this.#pendingMessages.length})`);
  }

  /**
   * Sync the client's model before a turn and return a note carrying the
   * get_current_model result for the agent, or null when there is nothing to hand
   * over (no such tool on this session, or the fetch failed — the agent then calls
   * the tool itself, as its prompt tells it to when no note is present).
   */
  async #fetchCurrentModel() {
    const tool = this.builtInToolProvider.getTools().tools.get_current_model;
    if (!tool) return null;
    const result = await tool.handler({});
    const text = result.content?.[0]?.text;
    if (result.isError) {
      logger.warn(`Failed to fetch current model before processing request: ${text ?? 'unknown error'}`);
      return null;
    }
    if (!text) return null;
    return `[Model sync: get_current_model was called for you at the start of this message. Its result: ${text}]`;
  }

  #resetAnthropicSdkUsageAccumulator() {
    this.#anthropicSdkAccumulatorUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      cache_read_input_tokens: 0,
    };
  }

  /**
   * Report any per-assistant usage that hasn't been superseded by a result
   * message. Used as the abort/error fallback so a stopped conversation still
   * gets its tokens counted.
   */
  #flushAnthropicSdkUsageAccumulator() {
    const u = this.#anthropicSdkAccumulatorUsage;
    const hasUsage =
      u.input_tokens > 0 ||
      u.output_tokens > 0 ||
      u.cache_creation.ephemeral_5m_input_tokens > 0 ||
      u.cache_creation.ephemeral_1h_input_tokens > 0 ||
      u.cache_read_input_tokens > 0;
    if (hasUsage) {
      logger.log(`Anthropic SDK: flushing accumulated per-assistant usage (no result message) for session ${this.sessionId}`);
      this.#logApiUsage(Provider.ANTHROPIC, u);
    }
    this.#resetAnthropicSdkUsageAccumulator();
  }

  /**
   * Fold one OpenRouter usage block into the run's running total. Takes either shape
   * OpenRouter answers with — the responses API's inputTokens/outputTokens/
   * inputTokensDetails (SDK loop) or chat completions' promptTokens/completionTokens/
   * promptTokensDetails (manual loop) — and always stores the chat-completions shape,
   * which TokenUsageReporter reads as-is. `cost` is OpenRouter's authoritative billed
   * USD for that one request, so it sums like the token counts do; it stays null when
   * no response carried one, which is how the reporter tells "free" from "unknown".
   */
  #accumulateOpenRouterUsage(usage, model) {
    if (!usage) return;
    this.#openRouterPendingUsageModel = model;
    const details = usage.promptTokensDetails ?? usage.inputTokensDetails;
    const total = this.#openRouterPendingUsage ?? {
      promptTokens: 0,
      completionTokens: 0,
      promptTokensDetails: { cachedTokens: 0, cacheWriteTokens: 0 },
      cost: null,
    };
    total.promptTokens += usage.promptTokens ?? usage.inputTokens ?? 0;
    total.completionTokens += usage.completionTokens ?? usage.outputTokens ?? 0;
    total.promptTokensDetails.cachedTokens += details?.cachedTokens ?? 0;
    total.promptTokensDetails.cacheWriteTokens += details?.cacheWriteTokens ?? 0;
    if (typeof usage.cost === 'number') total.cost = (total.cost ?? 0) + usage.cost;
    this.#openRouterPendingUsage = total;
  }

  /**
   * Report the running OpenRouter total and clear it, so a later flush on the same
   * conversation cannot bill the same tokens a second time. Safe to call from
   * anywhere at any time — with nothing pending it is a no-op, and it reads the
   * model off the accumulator rather than from the caller.
   */
  #flushOpenRouterUsage() {
    if (!this.#openRouterPendingUsage) return;
    this.#logApiUsage(Provider.OPENROUTER, this.#openRouterPendingUsage, this.#openRouterPendingUsageModel);
    this.#openRouterPendingUsage = null;
    this.#openRouterPendingUsageModel = null;
  }

  #logApiUsage(provider, usage, model = null) {
    if (!usage) return;
    // Falls back to the model this session actually resolved rather than the registry
    // default, so a raised intelligence level is reflected in the cost report. Guarded
    // because this is a reporting path: every caller that could hit a provider with no
    // nativeAgentProviders entry passes `model` explicitly, but a resolver throw here
    // must never be what loses a turn.
    let resolvedModel = model;
    if (!resolvedModel) {
      try {
        resolvedModel = this.#resolveNativeModel();
      } catch {
        resolvedModel = null;
      }
    }
    this.tokenReporter.report({ provider, model: resolvedModel, usage, clientKey: false, source: this.agentName }).catch(() => {});
  }


  /**
   * Destroy the orchestrator and cleanup resources
   */
  destroy() {
    logger.log(`AgentOrchestrator destroyed for session ${this.sessionId}`);

    if (this.#geminiManualCacheName && this.gemini) {
      this.gemini.caches.delete({ name: this.#geminiManualCacheName }).catch(() => {});
    }

    // Before the provider reference goes: the listener closes over this orchestrator,
    // and an agent switch destroys one and builds another against the same session.
    this.#unsubscribeModelChange?.();
    this.#unsubscribeModelChange = null;

    // Clear any references
    this.sessionManager = null;
    this.sendToClient = null;
    this.builtInToolProvider = null;
    this.dynamicToolProvider = null;
    this.anthropic = null;
    this.gemini = null;
    this.geminiAdkSessionService = null;
    this.configManager = null;
  }
}
