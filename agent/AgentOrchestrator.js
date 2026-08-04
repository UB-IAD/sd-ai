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
const loadGoogleAdk = async () => _googleAdk ??= await import('@google/adk');
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
  hydrateMessagesForOpenAi
} from './utilities/ToolResultFormatter.js';
import { BuiltInToolProvider, SDK_FILE_TOOL_TWINS } from './tools/BuiltInToolProvider.js';
import { DynamicToolProvider } from './tools/DynamicToolProvider.js';
import {
  createAgentTextMessage,
  createToolCallNotificationMessage,
  createToolCallCompletedMessage,
  createAgentCompleteMessage,
  createErrorMessage
} from './utilities/MessageProtocol.js';
import logger from '../utilities/logger.js';
import config from '../config.js';
import TokenUsageReporter, { Provider } from '../utilities/TokenUsageReporter.js';
import { sanitizeSchemaForGemini } from './tools/builtin/toolHelpers.js';
import { isToolAvailable } from './tools/toolAvailability.js';
import { join } from 'path';

// External provider ids that name the upstream LLM brand but resolve to the same
// OpenRouter-routed code paths. The OpenRouter gateway is an implementation detail —
// users pick the brand they want and the orchestrator routes through the OR SDK.
// Derived from the shared config registry so adding/removing a brand is a single
// config.js edit (see config.openRouterAgentProviders).
const OPENROUTER_PROVIDERS = new Set(Object.keys(config.openRouterAgentProviders));

// Provider ids that reach their vendor's API directly (see config.nativeAgentProviders).
// They run the manual (chat-completions) loop — no agent SDK exists for them — so the
// 'sdk' agent_mode also falls back to the manual loop for these providers.
const NATIVE_PROVIDERS = new Set(Object.keys(config.nativeAgentProviders));

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
  #geminiManualCacheName = null;
  #geminiManualCacheKey = null;
  #geminiManualCacheExpiry = null;
  #pendingMessages = [];
  // ADK can emit multiple events per LLM call that share the same usageMetadata
  // object reference (e.g. a streamed partial yield plus the aggregated close()
  // yield). No LLM-call id is exposed on the event, so reference equality is the
  // only available dedup key.
  #geminiAdkReportedUsageMetadata = new WeakSet();
  // Latest usage seen from a `response.completed` event on the OpenRouter SDK
  // stream. The SDK delivers cumulative usage per response, so the *last* one
  // we see is the authoritative total. Reported once when the loop completes
  // (or aborts) — never per-event, which would double-count.
  #openRouterSdkPendingUsage = null;
  // Upstream error block from a `response.failed` event on the OpenRouter SDK
  // stream. The SDK's own handler for that event reads `event.message`, which
  // does not exist — the detail lives at `event.response.error` — so it throws a
  // bare "Response failed" with nothing attached (@openrouter/sdk
  // esm/lib/model-result.js). We consume the same broadcaster, and buffered
  // events are always drained before the completion error surfaces, so we can
  // stash the real reason here and attach it when that error reaches the catch.
  #openRouterSdkFailureDetail = null;
  // Latest usage seen from a the OpenRouter manual pathway. This pathway delivers 
  // cumulative usage per response, so the *last* one
  // we see is the authoritative total. Reported once when the loop completes
  // (or aborts) — never per-event, which would double-count.
  #openRouterManualPendingUsage = null;
  #deepSeekManualPendingUsage = null;
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

  constructor(sessionManager, sessionId, sendToClient, agentConfig, provider = config.agentDefaultProvider) {
    this.sessionManager = sessionManager;
    this.sessionId = sessionId;
    this.sendToClient = sendToClient;
    this.stopRequested = false;
    this.provider = provider;

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
    this.builtInToolProvider = new BuiltInToolProvider(sessionManager, sessionId, sendToClient, this.provider, this.mediaStore, this.configManager.canWriteToLocalSandbox());
    this.dynamicToolProvider = new DynamicToolProvider(sessionManager, sessionId, sendToClient, this.mediaStore);

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
    } else if (NATIVE_PROVIDERS.has(this.provider)) {
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
   * Lazy OpenAI-compatible client for the native-API providers (config.nativeAgentProviders).
   * DeepSeek's API is OpenAI-compatible; DEEPSEEK_BASE_URL lets deployments point it at
   * any OpenAI-compatible gateway (the official API is the default).
   */
  async #getDeepSeek() {
    if (this.deepSeekClient) return this.deepSeekClient;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error('DeepSeek provider selected but DEEPSEEK_API_KEY is not set');
    }
    const OpenAI = await loadOpenAiSdk();
    this.deepSeekClient = new OpenAI({
      apiKey,
      baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      timeout: 5 * 60 * 1000,
    });
    return this.deepSeekClient;
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

      await this.#fetchCurrentModel();

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
      // Native-API providers (config.nativeAgentProviders) have no agent SDK, so they
      // always run the manual (chat-completions) loop regardless of the 'sdk' default.
      if (NATIVE_PROVIDERS.has(this.provider)) {
        await this.startConversationDeepSeekManual(userMessage);
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
    const systemPrompt = this.#buildSystemPromptWithRag(mode);

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

    // Convert tool servers to Anthropic tool format (with conditional filtering)
    const tools = this.#anthropicManualConvertTools(builtInTools, dynamicTools, modelTokenCount, mode);

    const maxIterations = this.configManager.getMaxIterations();

    while (true) {
      let continueLoop = true;
      let completedNaturally = false;
      let iteration = 0;
      let overloadedRetries = 0;

      while (continueLoop && iteration < maxIterations && !this.stopRequested) {
        iteration++;

        // Summarize context in-place if it has grown over the token limit
        await this.sessionManager.cleanupContext(this.sessionId, config.agentMaxContextTokens, this.provider);

        try {
          // Call Claude API. Adaptive thinking controls depth via `effort`
          // (output_config) rather than a token budget — budget_tokens is removed
          // on Opus 4.7+/Sonnet 4.6 and would 400.
          const thinkingEnabled = config.agentAnthropicThinking?.type !== 'disabled';
          const response = await anthropic.messages.create({
            model: config.agentAnthropicModel,
            max_tokens: 8192,
            system: systemBlocks,
            // Image bytes are attached to a copy here and thrown away with the
            // request. `messages` is the live session context, so hydrating it in
            // place would put base64 into stored history and into every later
            // token count.
            messages: hydrateMessagesForAnthropic(messages, this.mediaStore),
            thinking: config.agentAnthropicThinking,
            ...(thinkingEnabled && { output_config: { effort: config.agentAnthropicEffort } }),
            tools: tools.length > 0 ? tools : undefined
          });

          this.#logApiUsage(Provider.ANTHROPIC, response.usage);

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

    let systemPrompt = this.#buildSystemPromptWithRag(mode);

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
        builtin: await this.builtInToolProvider.getMcpServer(mode, modelTokenCount)
      };

      // Get client MCP server and derive allowed tool names from the same source
      const clientMcpServer = await this.dynamicToolProvider.getMcpServer();
      const clientToolNames = this.dynamicToolProvider.getToolNames(); // client_* prefixed, used for system prompt
      const prefixedClientToolNames = clientToolNames.map(name => `mcp__client__${name.replace(/^client_/, '')}`);
      if (clientMcpServer) {
        mcpServers.client = clientMcpServer;
      }

      // Build allowed tools list with MCP prefixes, filtered by mode, model token
      // count and client capability — the same predicate getMcpServer registers by,
      // so this list can never name a tool the server did not register.
      const allBuiltInTools = this.builtInToolProvider.getTools();
      const toolSession = this.sessionManager.getSession(this.sessionId);
      const builtInToolNames = this.builtInToolProvider.getToolNames()
        .filter(name => {
          if (SDK_FILE_TOOL_TWINS.has(name)) return false; // SDK provides native Read/Write/Edit
          const toolDef = allBuiltInTools.tools[name];
          if (toolDef?.nonSdkOnly) return false;
          return isToolAvailable(toolDef, { mode, modelTokenCount, session: toolSession, canWriteToLocalSandbox });
        })
        .map(name => `mcp__builtin__${name}`);
      let allowedTools = [
        ...builtInSdkTools,      // SDK filesystem tools (no prefix)
        ...builtInToolNames,     // Built-in tools with mcp__builtin__ prefix
        ...prefixedClientToolNames // Client tools with mcp__client__ prefix
      ];

      // Prefix tool names in system prompt
      systemPrompt = this.#anthropicSdkPrefixToolNamesInSystemPrompt(systemPrompt, builtInToolNames, clientToolNames);

      // Then say what the SDK's own filesystem tools are for. Appended after the
      // prefixing pass on purpose: these names take no mcp__ prefix, and the pass
      // would not leave `Read` alone if a builtin were ever named that.
      systemPrompt += this.#anthropicSdkFilesystemToolsNote(builtInSdkTools);

      // Build query options with MCP servers
      const queryOptions = {
        abortController: this.abortController,
        systemPrompt: systemPrompt,
        model: config.agentAnthropicModel,
        maxTokens: 8192,
        maxTurns: maxIterations,
        mcpServers: mcpServers,
        allowedTools: allowedTools,
        ...(canWriteToLocalSandbox ? {} : { disallowedTools: SDK_WRITE_TOOLS }),
        permissionMode: 'bypassPermissions',
        thinking: config.agentAnthropicThinking,
        ...(config.agentAnthropicThinking?.type !== 'disabled' && { effort: config.agentAnthropicEffort }),
        compact: true  // Enable automatic compaction
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
   */
  #anthropicSdkPrefixToolNamesInSystemPrompt(systemPrompt, builtInToolNames, clientToolNames) {
    let modifiedPrompt = systemPrompt;

    // Create mapping of unprefixed tool names to prefixed versions
    const toolNameMapping = {};

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
      // Also map the unprefixed name
      toolNameMapping[unprefixedName] = prefixedName;
    }

    // Replace tool names in the system prompt
    // Look for patterns like `tool_name` or **tool_name** or tool_name (surrounded by word boundaries)
    for (const [unprefixed, prefixed] of Object.entries(toolNameMapping)) {
      // Match tool names in backticks, bold, or standalone
      const patterns = [
        new RegExp(`\`${unprefixed}\``, 'g'),           // `tool_name`
        new RegExp(`\\*\\*${unprefixed}\\*\\*`, 'g'),   // **tool_name**
        new RegExp(`\\b${unprefixed}\\b`, 'g')          // tool_name (word boundary)
      ];

      for (const pattern of patterns) {
        modifiedPrompt = modifiedPrompt.replace(pattern, (match) => {
          // Preserve the formatting around the tool name
          return match.replace(unprefixed, prefixed);
        });
      }
    }

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
        if (block.name === 'create_visualization') {
          const vizType = block.input.useAICustom ? 'AI-generated custom' : (block.input.type || 'standard');
          const title = block.input.title || 'visualization';
          await this.sendToClient(createAgentTextMessage(
            this.sessionId,
            `Creating ${vizType} visualization: "${title}"... This may take a moment.`,
            false
          ));
        } else if (block.name === 'draw_causal_loop_diagram') {
          await this.sendToClient(createAgentTextMessage(
            this.sessionId,
            `Drawing causal loop diagram: "${block.input.title || 'Causal Loop Diagram'}"... This may take a moment.`,
            false
          ));
        } else if (block.name === 'get_variable_data') {
          const varCount = block.input.variableNames?.length || 0;
          const runCount = block.input.runIds?.length || 0;
          await this.sendToClient(createAgentTextMessage(
            this.sessionId,
            `Retrieving data for ${varCount} variable${varCount !== 1 ? 's' : ''} from ${runCount} run${runCount !== 1 ? 's' : ''}...`,
            false
          ));
        } else if (block.name === 'get_feedback_information') {
          const runCount = block.input.runIds?.length || 0;
          const runText = runCount === 0 ? 'all runs' : `${runCount} run${runCount !== 1 ? 's' : ''}`;
          await this.sendToClient(createAgentTextMessage(
            this.sessionId,
            `Analyzing feedback loops for ${runText}... This may take a moment.`,
            false
          ));
        } else if (block.name === 'run_model') {
          await this.sendToClient(createAgentTextMessage(
            this.sessionId,
            `Running model simulation...`,
            false
          ));
        } else if (block.name === 'discuss_model_with_seldon') {
          await this.sendToClient(createAgentTextMessage(
            this.sessionId,
            `Consulting Seldon for expert analysis...`,
            false
          ));
        } else if (block.name === 'discuss_model_across_runs') {
          await this.sendToClient(createAgentTextMessage(
            this.sessionId,
            `Analyzing model behavior across runs...`,
            false
          ));
        } else if (block.name === 'discuss_with_mentor') {
          await this.sendToClient(createAgentTextMessage(
            this.sessionId,
            `Consulting Seldon mentor for guidance...`,
            false
          ));
        }

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
   * Universal RAG hook: every route builds its system prompt through here so
   * attached-file context reaches all six provider/loop paths identically.
   * Appends an "Attached Files" manifest listing each ready file.
   *
   * Wording is intentionally tool-agnostic for the read-in-full (manifest) tier
   * ("open and read the file at <path>") — the anthropic-sdk route excludes the
   * read_file built-in (it uses the SDK's native Read) and would rewrite a
   * literal `read_file` token to a non-existent MCP tool. The `search_documents`
   * token is safe to mention (it exists on every route).
   */
  #buildSystemPromptWithRag(mode) {
    const base = this.configManager.buildSystemPrompt(mode);
    const files = this.sessionManager.getAttachedFiles(this.sessionId).filter(f => f.status === 'ready');
    if (files.length === 0) return base;

    const tempDir = this.sessionManager.getSessionTempDir(this.sessionId);
    const lines = files.map(f => {
      if (f.tier === 'vector') {
        return `- "${f.name}" (${f.mimeType}, ~${f.tokenCount} tokens) — large document. Use the search_documents tool to find relevant passages (optionally restrict to this file with fileId "${f.fileId}").`;
      }
      const path = join(tempDir, 'rag', f.fileId, 'extracted.txt');
      return `- "${f.name}" (${f.mimeType}, ~${f.tokenCount} tokens) — open and read the file at ${path} to use its full contents.`;
    });

    return `${base}

## Attached Files
The user has attached the following reference documents to this session. Consult them whenever they are relevant to the request.
${lines.join('\n')}`;
  }

  async #buildPriorContextTextHelper(history) {
    const conversationText = this.#normalizeHistoryToText(history);
    const tokenCount = countTokens(conversationText);
    if (tokenCount <= config.agentMaxContextTokens) {
      logger.log(`Prior agent context (${history.length} messages, ~${tokenCount} tokens) under limit — injecting verbatim`);
      return conversationText;
    }
    if (NATIVE_PROVIDERS.has(this.provider)) {
      return this.#summarizePriorContextWithDeepSeek(conversationText, history.length);
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
      const response = await anthropic.messages.create({
        model: config.agentAnthropicSummaryModel,
        max_tokens: 1024,
        messages: [{ role: 'user', content: `Summarize this conversation history concisely (2-4 paragraphs):\n\n${conversationText}` }]
      });
      if (response.usage) {
        this.#logApiUsage(Provider.ANTHROPIC, response.usage, config.agentAnthropicSummaryModel);
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
      const response = await gemini.models.generateContent({
        model: config.agentGeminiSummaryModel,
        contents: [{
          role: 'user',
          parts: [{ text: `Summarize this conversation history concisely (2-4 paragraphs):\n\n${conversationText}` }]
        }]
      });
      if (response.usageMetadata) {
        this.#logApiUsage(Provider.GOOGLE, response.usageMetadata, config.agentGeminiSummaryModel);
      }
      return response.text || response.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch (error) {
      logger.error('Gemini: Error summarizing prior context:', error);
      return '[Prior conversation condensed due to size]';
    }
  }

  async #summarizePriorContextWithDeepSeek(conversationText, messageCount) {
    // Pick the per-provider summary model from the native registry. Falls back to
    // the agent's primary model for any unforeseen provider so summarization proceeds.
    const model = config.nativeAgentProviders[this.provider]?.summaryModel || this.#resolveNativeModel();
    try {
      logger.log(`DeepSeek (${this.provider}): Summarizing prior agent context (${messageCount} messages) before injection`);
      const deepSeekClient = await this.#getDeepSeek();
      const completion = await deepSeekClient.chat.completions.create({
        model,
        messages: [
          { role: 'user', content: `Summarize this conversation history concisely (2-4 paragraphs):\n\n${conversationText}` }
        ],
        max_tokens: 1024,
      });
      if (completion.usage) {
        this.#logApiUsage(Provider.DEEPSEEK, completion.usage, model);
      }
      return completion.choices?.[0]?.message?.content ?? '';
    } catch (error) {
      logger.error(`DeepSeek (${this.provider}): Error summarizing prior context: ${this.#describeOpenRouterError(error)}`);
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
  #anthropicManualConvertTools(builtInTools, dynamicTools, modelTokenCount = 0, mode = null) {
    const tools = [];
    const toolNames = new Set();
    const session = this.sessionManager.getSession(this.sessionId);

    // Convert built-in tools
    for (const [toolName, toolDef] of Object.entries(builtInTools.tools)) {
      if (toolNames.has(toolName)) {
        logger.warn(`Anthropic: Duplicate tool name detected: ${toolName} (from built-in tools)`);
        continue;
      }

      // Skip tools ruled out by mode, model size, or client capability
      if (!isToolAvailable(toolDef, { mode, modelTokenCount, session, canWriteToLocalSandbox: this.configManager.canWriteToLocalSandbox() })) {
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
    const systemPrompt = this.#buildSystemPromptWithRag(mode);
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

    const toolDeclarations = this.#geminiManualConvertTools(builtInTools, dynamicTools, modelTokenCount, mode);

    const maxIterations = this.configManager.getMaxIterations();

    while (true) {
      let continueLoop = true;
      let completedNaturally = false;
      let iteration = 0;
      let retries = 0;
      let cacheRetries = 0;

      while (continueLoop && iteration < maxIterations && !this.stopRequested) {
        iteration++;
        await this.sessionManager.cleanupContext(this.sessionId, config.agentMaxContextTokens, this.provider);

        // Refresh the context cache before each call. #getGeminiManualConfig
        // returns the live cache cheaply while it's valid, and proactively
        // recreates it ~30s before its 300s TTL so it never expires mid-flight.
        const geminiConfig = await this.#getGeminiManualConfig(systemPrompt, toolDeclarations);

        try {
          const response = await gemini.models.generateContent({
            model: config.agentGeminiModel,
            // Transient copy — see the anthropic-manual call for why history must
            // never hold the bytes.
            contents: hydrateContentsForGemini(messages, this.mediaStore),
            config: geminiConfig
          });

          this.#logApiUsage(Provider.GOOGLE, response.usageMetadata);
          cacheRetries = 0;

          if (this.stopRequested) break;

          continueLoop = await this.processGeminiManualResponse(response, messages, builtInTools, dynamicTools);
          if (!continueLoop) completedNaturally = true;

          if (this.stopRequested) break;

        } catch (error) {
          const isQuota = error?.status === 429;
          const isNetworkError = error?.code === 'UND_ERR_SOCKET' || error?.code === 'ECONNRESET' ||
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

    let systemPrompt = this.#buildSystemPromptWithRag(mode);
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
      const builtInAdkTools = await this.builtInToolProvider.getAdkTools(mode, modelTokenCount);
      const clientAdkTools = await this.dynamicToolProvider.getAdkTools();

      const pendingCallIds = new Map();

      const agent = new LlmAgent({
        name: this.configManager.getAgentName(),
        model: config.agentGeminiModel,
        // A function, not the string itself. ADK runs any *string* instruction
        // through injectSessionState, which treats every `{IDENTIFIER}` in it as a
        // session-state lookup and throws "Context variable not found" when the key
        // is absent. Our prompts are literal text, and an agent config that documents
        // a placeholder like `${DEPENDENCY_PATH}` killed the turn before the first
        // model call — the `$` sits outside the braces ADK matches, so shell-style
        // placeholders are not safe from it. The function form sets
        // requireStateInjection=false, so the prompt reaches Gemini verbatim.
        instruction: () => systemPrompt,
        tools: [...builtInAdkTools, ...clientAdkTools],
        generateContentConfig: {
          thinkingConfig: config.agentGeminiThinking
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
          const isBuiltIn = builtInAdkTools.some(t => t.name === tool.name);
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
      await this.sendToClient(createAgentTextMessage(this.sessionId, `Creating ${vizType} visualization: "${args?.title || 'visualization'}"... This may take a moment.`, false));
    } else if (toolName === 'draw_causal_loop_diagram') {
      await this.sendToClient(createAgentTextMessage(this.sessionId, `Drawing causal loop diagram: "${args?.title || 'Causal Loop Diagram'}"... This may take a moment.`, false));
    } else if (toolName === 'get_variable_data') {
      const varCount = args?.variableNames?.length || 0;
      const runCount = args?.runIds?.length || 0;
      await this.sendToClient(createAgentTextMessage(this.sessionId, `Retrieving data for ${varCount} variable${varCount !== 1 ? 's' : ''} from ${runCount} run${runCount !== 1 ? 's' : ''}...`, false));
    } else if (toolName === 'get_feedback_information') {
      const runCount = args?.runIds?.length || 0;
      const runText = runCount === 0 ? 'all runs' : `${runCount} run${runCount !== 1 ? 's' : ''}`;
      await this.sendToClient(createAgentTextMessage(this.sessionId, `Analyzing feedback loops for ${runText}... This may take a moment.`, false));
    } else if (toolName === 'run_model') {
      await this.sendToClient(createAgentTextMessage(this.sessionId, `Running model simulation...`, false));
    } else if (toolName === 'discuss_model_with_seldon') {
      await this.sendToClient(createAgentTextMessage(this.sessionId, `Consulting Seldon for expert analysis...`, false));
    } else if (toolName === 'discuss_model_across_runs') {
      await this.sendToClient(createAgentTextMessage(this.sessionId, `Analyzing model behavior across runs...`, false));
    } else if (toolName === 'discuss_with_mentor') {
      await this.sendToClient(createAgentTextMessage(this.sessionId, `Consulting Seldon mentor for guidance...`, false));
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

  #geminiManualConvertTools(builtInTools, dynamicTools, modelTokenCount = 0, mode = null) {
    const declarations = [];
    const toolNames = new Set();
    const session = this.sessionManager.getSession(this.sessionId);

    for (const [toolName, toolDef] of Object.entries(builtInTools.tools)) {
      if (toolNames.has(toolName)) continue;
      if (!isToolAvailable(toolDef, { mode, modelTokenCount, session, canWriteToLocalSandbox: this.configManager.canWriteToLocalSandbox() })) continue;

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

  async #getGeminiManualConfig(systemPrompt, toolDeclarations) {
    // Build a cache key from the stable inputs — recreate if they change (e.g. tool set changes on model resize)
    const cacheKey = systemPrompt + JSON.stringify(toolDeclarations.map(t => t.name));

    const cacheStillValid = this.#geminiManualCacheName &&
      this.#geminiManualCacheKey === cacheKey &&
      this.#geminiManualCacheExpiry && Date.now() < this.#geminiManualCacheExpiry;

    if (cacheStillValid) {
      return {
        cachedContent: this.#geminiManualCacheName,
        thinkingConfig: config.agentGeminiThinking
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
        model: config.agentGeminiModel,
        config: cacheConfig
      });

      this.#geminiManualCacheName = cache.name;
      this.#geminiManualCacheKey = cacheKey;
      this.#geminiManualCacheExpiry = Date.now() + 270_000; // 270s, 30s before 300s TTL

      return {
        cachedContent: cache.name,
        thinkingConfig: config.agentGeminiThinking
      };
    } catch (e) {
      logger.warn('[gemini-cache] failed to create cache, falling back to uncached:', e.message);
      const cfg = {
        systemInstruction: systemPrompt,
        thinkingConfig: config.agentGeminiThinking
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
   * Resolve the model id for a native-API provider from the shared registry
   * config.nativeAgentProviders.
   */
  #resolveNativeModel() {
    const model = config.nativeAgentProviders[this.provider]?.model;
    if (!model) throw new Error(`No nativeAgentProviders entry configured for provider "${this.provider}"`);
    return model;
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

    const systemPrompt = this.#buildSystemPromptWithRag(mode);
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
      const orTools = await this.#buildOpenRouterTools(mode, modelTokenCount);

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
        tools: orTools,
        stopWhen: stepCountIs(maxIterations),
      };

      let input = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPromptText }
      ];

      while (true) {
        if (this.stopRequested) break;
        this.#openRouterSdkFailureDetail = null;

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
          try {
            for await (const event of result.getFullResponsesStream()) {
              // Cumulative usage — overwrite each time so the last value
              // wins. Captured BEFORE the stop check so an in-flight event
              // carrying usage isn't dropped when the user hits stop: we
              // still want to flush the latest tally in the finally block.
              // Reporting happens once when the loop closes or aborts, never
              // per-event (that would double-count).
              if (event?.type === 'response.completed' && event.response?.usage) {
                this.#openRouterSdkPendingUsage = event.response.usage;
                continue;
              }

              // The only place the upstream reason is visible. Capture it before
              // the SDK turns this same event into a detail-free throw. Logged
              // here too: on a follow-up turn the SDK rejects immediately, and
              // this is the record of what the provider actually said.
              if (event?.type === 'response.failed') {
                const err = event.response?.error;
                let detail;
                try {
                  detail = typeof err === 'string' ? err : JSON.stringify(err);
                } catch {
                  detail = String(err);
                }
                this.#openRouterSdkFailureDetail = detail ?? 'no error block on the failed response';
                logger.error(`OpenRouter SDK: response.failed from ${model}: ${this.#openRouterSdkFailureDetail}`);
                continue;
              }

              if (this.stopRequested) break;

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

        // Report the cumulative usage captured from response.completed once
        // per iteration of the outer queued-message loop.
        if (this.#openRouterSdkPendingUsage) {
          this.#logApiUsage(Provider.OPENROUTER, this.#openRouterSdkPendingUsage, model);
          this.#openRouterSdkPendingUsage = null;
        }

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
      // On abort / error paths the in-loop flush above is skipped; report
      // the latest cumulative usage captured before the break.
      if (this.#openRouterSdkPendingUsage) {
        this.#logApiUsage(Provider.OPENROUTER, this.#openRouterSdkPendingUsage, model);
        this.#openRouterSdkPendingUsage = null;
      }
      this.#openRouterSdkFailureDetail = null;
      this.abortController = null;
    }
  }

  /**
   * Hand-rolled tool loop on top of OpenRouter's chat completions API — the
   * counterpart to startConversationAnthropicManual for any OpenRouter brand.
   */
  async startConversationOpenRouterManual(userMessage) {
    let llmUsed = null;
    try {
      const session = this.sessionManager.getSession(this.sessionId);
      const model = this.#resolveOpenRouterModel();
      const openRouterClient = await this.#getOpenRouter();
      llmUsed = model;

      this.sessionManager.addToConversationHistory(this.sessionId, {
        role: 'user',
        content: userMessage
      });

      const mode = session.mode;
      const systemPrompt = this.#buildSystemPromptWithRag(mode);
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

      const chatTools = this.#openRouterManualConvertTools(builtInTools, dynamicTools, modelTokenCount, mode);
      const maxIterations = this.configManager.getMaxIterations();

      while (true) {
        let continueLoop = true;
        let completedNaturally = false;
        let iteration = 0;

        while (continueLoop && iteration < maxIterations && !this.stopRequested) {
          iteration++;
          await this.sessionManager.cleanupContext(this.sessionId, config.agentMaxContextTokens, this.provider);

          try {
            const completion = await openRouterClient.chat.send({
              chatRequest: {
                model,
                // Transient copy — see the anthropic-manual call for why history
                // must never hold the bytes.
                messages: [
                  { role: 'system', content: systemPrompt },
                  ...hydrateMessagesForOpenAi(messages, this.mediaStore)
                ],
                tools: chatTools.length > 0 ? chatTools : undefined,
              }
            });

            if (completion?.usage)
              this.#openRouterManualPendingUsage = completion.usage;

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
      if (this.#openRouterManualPendingUsage && llmUsed)
        this.#logApiUsage(Provider.OPENROUTER, this.#openRouterManualPendingUsage, llmUsed);
    }
  }

  /**
   * Start conversation for a native-API provider (config.nativeAgentProviders) using
   * the OpenAI-compatible chat-completions API. DeepSeek's API is OpenAI-compatible,
   * so this loop is a near mirror of startConversationOpenRouterManual: the request
   * goes to the vendor's own API (DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL), while the
   * response processing and tool conversion are shared with the OpenRouter loop
   * (both speak OpenAI's function-calling shape).
   */
  async startConversationDeepSeekManual(userMessage) {
    let llmUsed = null;
    try {
      const session = this.sessionManager.getSession(this.sessionId);
      const model = this.#resolveNativeModel();
      const deepSeekClient = await this.#getDeepSeek();
      llmUsed = model;

      this.sessionManager.addToConversationHistory(this.sessionId, {
        role: 'user',
        content: userMessage
      });

      const mode = session.mode;
      const systemPrompt = this.#buildSystemPromptWithRag(mode);
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

      const chatTools = this.#openRouterManualConvertTools(builtInTools, dynamicTools, modelTokenCount, mode);
      const maxIterations = this.configManager.getMaxIterations();

      while (true) {
        let continueLoop = true;
        let completedNaturally = false;
        let iteration = 0;

        while (continueLoop && iteration < maxIterations && !this.stopRequested) {
          iteration++;
          await this.sessionManager.cleanupContext(this.sessionId, config.agentMaxContextTokens, this.provider);

          try {
            const completion = await deepSeekClient.chat.completions.create({
              model,
              // Transient copy — see the anthropic-manual call for why history
              // must never hold the bytes.
              messages: [
                { role: 'system', content: systemPrompt },
                ...hydrateMessagesForOpenAi(messages, this.mediaStore)
              ],
              tools: chatTools.length > 0 ? chatTools : undefined,
            });

            if (completion?.usage)
              this.#deepSeekManualPendingUsage = completion.usage;

            if (this.stopRequested) break;

            continueLoop = await this.processOpenRouterManualResponse(completion, messages, builtInTools, dynamicTools);
            if (!continueLoop && !this.stopRequested) completedNaturally = true;

            if (this.stopRequested) break;
          } catch (error) {
            const detail = this.#describeOpenRouterError(error);
            logger.error(`DeepSeek Manual: error in agent conversation loop: ${detail}`);
            await this.sendToClient(createErrorMessage(this.sessionId, `Agent error: ${detail}`, 'AGENT_ERROR'));
            await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'awaiting_user', 'Agent stopped due to error'));
            continueLoop = false;
            completedNaturally = true;
          }
        }

        if (this.stopRequested) {
          logger.log(`DeepSeek Manual: agent stopped by user request for session ${this.sessionId}`);
          this.stopRequested = false;
          await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'awaiting_user', 'Agent stopped by user request'));
          break;
        }
        const reachedMax = !completedNaturally && iteration >= maxIterations;
        if (this.#pendingMessages.length === 0) {
          if (reachedMax) {
            logger.log(`DeepSeek Manual: agent conversation reached max iterations (${maxIterations})`);
            await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'awaiting_user', `Reached maximum iterations (${maxIterations})`));
          }
          break;
        }
        if (reachedMax) logger.log(`DeepSeek Manual: max iterations (${maxIterations}) hit; draining queued message with fresh budget`);
        const next = this.#pendingMessages.shift();
        logger.log(`DeepSeek Manual: processing queued message (remaining: ${this.#pendingMessages.length})`);
        // `messages` IS the live session context — one append, not two.
        this.sessionManager.addToConversationHistory(this.sessionId, { role: 'user', content: next });
      }
    } catch (error) {
      // Catches setup-time failures (resolveModel, cleanupContext, tool conversion,
      // etc.) and anything else outside the per-iteration try.
      const detail = this.#describeOpenRouterError(error);
      logger.error(`DeepSeek Manual: in conversation setup: ${detail}`);
      await this.sendToClient(createErrorMessage(this.sessionId, `Agent error: ${detail}`, 'AGENT_ERROR'));
      await this.sendToClient(createAgentCompleteMessage(this.sessionId, 'awaiting_user', `Agent error: ${detail}`));
    } finally {
      if (this.#deepSeekManualPendingUsage && llmUsed)
        this.#logApiUsage(Provider.DEEPSEEK, this.#deepSeekManualPendingUsage, llmUsed);
    }
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
   */
  async #buildOpenRouterTools(mode, modelTokenCount) {
    const { tool: orTool } = await loadOpenRouterAgent();
    const builtInTools = this.builtInToolProvider.getTools();
    const dynamicTools = this.dynamicToolProvider.getTools();
    const session = this.sessionManager.getSession(this.sessionId);
    const tools = [];
    const seen = new Set();

    for (const [toolName, toolDef] of Object.entries(builtInTools.tools)) {
      if (seen.has(toolName)) continue;
      if (!isToolAvailable(toolDef, { mode, modelTokenCount, session, canWriteToLocalSandbox: this.configManager.canWriteToLocalSandbox() })) continue;
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

  #openRouterManualConvertTools(builtInTools, dynamicTools, modelTokenCount, mode) {
    const tools = [];
    const seen = new Set();
    const session = this.sessionManager.getSession(this.sessionId);
    for (const [toolName, toolDef] of Object.entries(builtInTools.tools)) {
      if (seen.has(toolName)) continue;
      if (!isToolAvailable(toolDef, { mode, modelTokenCount, session, canWriteToLocalSandbox: this.configManager.canWriteToLocalSandbox() })) continue;
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
  }


  /**
   * Queue a new message from the user to be processed
   */
  queueMessage(message) {
    this.#pendingMessages.push(message);
    logger.debug(`[orchestrator:${this.sessionId}] Message queued (depth: ${this.#pendingMessages.length})`);
  }

  async #fetchCurrentModel() {
    const tool = this.builtInToolProvider.getTools().tools.get_current_model;
    if (!tool) return;
    const result = await tool.handler({});
    if (result.isError) {
      logger.warn(`Failed to fetch current model before processing request: ${result.content?.[0]?.text ?? 'unknown error'}`);
    }
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

  #logApiUsage(provider, usage, model = null) {
    if (!usage) return;
    const resolvedModel = model ?? (
      provider === Provider.ANTHROPIC ? config.agentAnthropicModel : config.agentGeminiModel
    );
    this.tokenReporter.report({ provider, model: resolvedModel, usage, clientKey: false }).catch(() => {});
  }


  /**
   * Destroy the orchestrator and cleanup resources
   */
  destroy() {
    logger.log(`AgentOrchestrator destroyed for session ${this.sessionId}`);

    if (this.#geminiManualCacheName && this.gemini) {
      this.gemini.caches.delete({ name: this.#geminiManualCacheName }).catch(() => {});
    }

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
