import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
// Anthropic / Gemini / OpenRouter SDKs are lazy-loaded — only one is needed per
// session (provider depends on the conversation format) and the summarization
// path that uses them is the only consumer. Eager imports cost ~50ms (Anthropic
// + Gemini) and ~250ms (OpenRouter).
let _AnthropicSdk;
const loadAnthropicSdk = async () => _AnthropicSdk ??= (await import('@anthropic-ai/sdk')).default;
let _GoogleGenai;
const loadGoogleGenai = async () => _GoogleGenai ??= (await import('@google/genai')).GoogleGenAI;
let _OpenRouterSdk;
const loadOpenRouterSdk = async () => _OpenRouterSdk ??= (await import('@openrouter/sdk')).OpenRouter;
let _OpenAiSdk;
const loadOpenAiSdk = async () => _OpenAiSdk ??= (await import('openai')).OpenAI;
import { countTokens } from '@anthropic-ai/tokenizer';
import logger from '../../utilities/logger.js';
import TokenUsageReporter, { Provider } from '../../utilities/TokenUsageReporter.js';
import config from '../../config.js';

// External provider ids that route through OpenRouter, derived from the shared
// config registry (config.openRouterAgentProviders) so adding/removing a brand is a
// single config.js edit. The same registry carries each brand's summaryModel slug.
const OPENROUTER_PROVIDERS = new Set(Object.keys(config.openRouterAgentProviders));

// Native-API provider ids (config.nativeAgentProviders) — reached via the vendor's
// own OpenAI-compatible API rather than OpenRouter.
const NATIVE_PROVIDERS = new Set(Object.keys(config.nativeAgentProviders));

/**
 * Can this message legally be the FIRST message of a conversation? The
 * count-based trim in addToConversationHistory cuts from the head of an array
 * that is very often mid-tool-sequence, and every provider rejects a history
 * that opens on a dangling tool turn:
 *   - Anthropic and Gemini both require the first message to be a user turn.
 *   - A user turn carrying tool_result / functionResponse needs the assistant
 *     tool_use / functionCall turn that preceded it — which the cut removed.
 *   - Chat-completions `role: 'tool'` turns likewise need their assistant
 *     toolCalls turn (excluded here by the role check).
 * Handles all three wire formats since one session's context can hold any of
 * them (agent switches normalize lazily, at loop entry).
 */
const isSafeConversationStart = (message) => {
  if (!message || message.role !== 'user') return false;
  if (Array.isArray(message.content) && message.content.some(b => b?.type === 'tool_result')) return false;
  if (Array.isArray(message.parts) && message.parts.some(p => p?.functionResponse)) return false;
  return true;
};

/**
 * SessionManager
 * Manages in-memory WebSocket sessions with session-specific temp folders
 *
 * Key Features:
 * - Pure in-memory state (no persistence)
 * - Session-specific temp folders for Python visualizations
 * - Automatic cleanup on disconnect
 * - Stale session cleanup
 * - Orphaned temp directory cleanup
 */
export class SessionManager {
  static MAX_COMPRESSION_TOKENS_PER_PASS = 200_000;

  constructor(options = {}) {
    this.sessions = new Map();

    // Use explicit override (mainly for isolation in tests) > per-process
    // subdirectory under the configured temp directory > OS tmpdir.
    //
    // The `pid-${process.pid}` segment is critical under PM2 cluster mode
    // (or any multi-process deployment sharing AGENT_SESSION_TEMP_DIR):
    // #cleanupOrphanedTempDirs reads `this.tempBasePath` and removes anything
    // not in *its own* this.sessions map. Without per-pid namespacing each
    // process would rm-rf its sibling processes' active session dirs on the
    // 5-minute cleanup tick, breaking the bwrap bind mount under live workers
    // (the root cause of the /session/*.json ENOENT errors).
    this.tempBasePath = options.tempBasePath
      || join(config.agentSessionTempDir || tmpdir(), 'sd-agent', `pid-${process.pid}`);

    // Configuration
    this.maxSessions = options.maxSessions || 1000;
    this.maxConversationHistory = options.maxConversationHistory || 100;
    this.maxSessionAge = options.maxSessionAge || 8 * 60 * 60 * 1000; // 8 hours
    this.sessionTimeout = options.sessionTimeout || 30 * 60 * 1000; // 30 minutes
    this.cleanupInterval = options.cleanupInterval || 5 * 60 * 1000; // 5 minutes

    // Ensure base temp directory exists
    if (!existsSync(this.tempBasePath)) {
      mkdirSync(this.tempBasePath, { recursive: true });
    }

    // Reap pid-* siblings whose owning process is no longer alive — leftovers
    // from PM2 restarts/crashes where the dying process couldn't run its own
    // shutdown cleanup. Guarded by an mtime check (see #cleanupDeadProcessDirs)
    // so a brand-new sibling that's been assigned a reused PID can't get caught
    // in a race before it's had a chance to populate its dir.
    if (!options.tempBasePath && !options.disableCleanup) {
      this.#cleanupDeadProcessDirs();
    }

    // Start cleanup timer (disabled in worker processes — lifetime managed by main)
    if (!options.disableCleanup) {
      this.#startCleanupTimer();
    }

    logger.log(`SessionManager initialized. Temp base: ${this.tempBasePath}`);
  }

  /**
   * Scan the parent `sd-agent` directory for `pid-*` subdirs whose owning
   * process is no longer alive and reap them.
   *
   * Two-part safety check:
   *  - process.kill(pid, 0) → ESRCH: no live process holds that PID right now.
   *  - dir mtime older than one cleanup interval: if the kernel just reused
   *    this PID for a brand-new sibling, the new dir's mtime would be very
   *    recent — skipping fresh dirs eliminates the PID-reuse race window.
   */
  #cleanupDeadProcessDirs() {
    const parentDir = dirname(this.tempBasePath);
    if (!existsSync(parentDir)) return;

    let entries;
    try {
      entries = readdirSync(parentDir);
    } catch (err) {
      logger.warn(`Could not scan ${parentDir} for dead pid dirs: ${err.message}`);
      return;
    }

    const now = Date.now();
    const reaped = [];
    const skippedFresh = [];
    for (const entry of entries) {
      if (!entry.startsWith('pid-')) continue;
      const pid = Number(entry.slice(4));
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (pid === process.pid) continue;

      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (err) {
        // Only ESRCH ("no such process") definitively means dead. Everything
        // else — EPERM on POSIX, EACCES on Windows, transient I/O errors —
        // means we can't confirm it's gone, so treat as alive and skip.
        // False-positive alive just leaves an orphan dir for the next sweep;
        // a false-negative would rm a live sibling's bind-mount source.
        if (err.code === 'ESRCH') alive = false;
      }
      if (alive) continue;

      const fullPath = join(parentDir, entry);
      let mtimeMs;
      try {
        mtimeMs = statSync(fullPath).mtimeMs;
      } catch (err) {
        logger.warn(`Could not stat ${fullPath}, skipping: ${err.message}`);
        continue;
      }
      if (now - mtimeMs < this.cleanupInterval) {
        skippedFresh.push({ entry, pid });
        continue;
      }

      try {
        rmSync(fullPath, { recursive: true, force: true });
        reaped.push({ entry, pid });
      } catch (err) {
        logger.error(`Failed to reap dead pid dir ${fullPath}:`, err);
      }
    }

    if (reaped.length > 0) {
      const summary = reaped.map(({ entry, pid }) => `${entry} (pid=${pid})`).join(', ');
      logger.log(`Reaped ${reaped.length} dead pid-* temp dir(s) under ${parentDir}: ${summary}`);
    }
    if (skippedFresh.length > 0) {
      const summary = skippedFresh.map(({ entry, pid }) => `${entry} (pid=${pid})`).join(', ');
      logger.log(
        `Skipped ${skippedFresh.length} dead pid-* temp dir(s) too fresh to reap safely: ${summary}`
      );
    }
  }

  /**
   * Generate a unique session ID
   */
  #generateSessionId() {
    return `sess_${randomBytes(16).toString('hex')}`;
  }

  /**
   * Create a new session
   */
  createSession(ws) {
    // Enforce max sessions
    if (this.sessions.size >= this.maxSessions) {
      throw new Error('Server at capacity. Please try again later.');
    }

    const sessionId = this.#generateSessionId();
    const sessionTempDir = join(this.tempBasePath, sessionId);

    // Create session-specific temp folder
    try {
      mkdirSync(sessionTempDir, { recursive: true });
    } catch (err) {
      logger.error(`Failed to create temp directory for session ${sessionId}:`, err);
      throw new Error('Failed to initialize session temp directory');
    }

    const session = {
      sessionId,
      ws,
      tempDir: sessionTempDir,
      createdAt: Date.now(),
      lastActivity: Date.now(),

      // Client-provided data
      mode: null,  // 'cld' or 'sfd' - set once at initialization, never changes
      clientModel: null,
      clientTools: [],
      context: {},
      clientId: null,

      // Model token tracking
      modelTokenCount: 0,

      // Active tool calls awaiting client response
      pendingToolCalls: new Map(),

      // Agent conversation context (for Claude Agent SDK)
      conversationContext: [],

      // RAG: metadata for files the client has attached this session. Keyed by
      // fileId. The main process holds metadata only (bytes live on disk);
      // the worker additionally holds the in-memory vector index via its RagStore.
      attachedFiles: new Map(),

      // Async hook installed by WebSocketHandler so stale-session cleanup can
      // wait for the worker to exit before rmSync removes the bwrap bind-mount
      // source. Null when no worker is running for this session.
      workerTeardown: null,
    };

    this.sessions.set(sessionId, session);

    logger.log(`Session created: ${sessionId} (total: ${this.sessions.size})`);

    return sessionId;
  }

  /**
   * Register a session with a known ID and an explicit temp directory path.
   * Used by worker processes where the session ID and temp dir are assigned
   * by the main process and passed in via environment variables.
   */
  createSessionWithId(sessionId, ws, tempDir) {
    if (this.sessions.has(sessionId)) return sessionId;
    if (this.sessions.size >= this.maxSessions) {
      throw new Error('Server at capacity. Please try again later.');
    }

    try {
      mkdirSync(tempDir, { recursive: true });
    } catch (err) {
      logger.error(`Failed to ensure temp directory for session ${sessionId}:`, err);
      throw new Error('Failed to initialize session temp directory');
    }

    const session = {
      sessionId,
      ws,
      tempDir,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      mode: null,
      clientModel: null,
      clientTools: [],
      context: {},
      clientId: null,
      modelTokenCount: 0,
      pendingToolCalls: new Map(),
      conversationContext: [],
      attachedFiles: new Map(),
      workerTeardown: null,
    };

    this.sessions.set(sessionId, session);
    logger.log(`Session registered: ${sessionId}`);
    return sessionId;
  }

  /**
   * Install an async teardown hook the cleanup path will await before rmSync'ing
   * the session temp dir. Used to keep the worker's bwrap `--bind` source alive
   * until the worker process has actually exited.
   */
  setWorkerTeardown(sessionId, teardownFn) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.workerTeardown = teardownFn;
    }
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = Date.now();
    }
    return session;
  }

  /**
   * Initialize a session with model and tools.
   *
   * `capabilities` carries the client's optional `supports*` flags from `initialize_session`.
   * Every one defaults to false when absent, so a client that predates a flag keeps its old
   * behaviour. `supportsMedia` says the client can decode and display images; it is a necessary
   * but not sufficient condition for the `generate_image` / `view_media` built-ins, which also
   * require the client's tool list to declare a media contract (see `tools/toolAvailability.js`).
   */
  initializeSession(sessionId, mode, model, tools, context, clientId, capabilities = {}) {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Validate model type
    if (mode !== 'cld' && mode !== 'sfd') {
      throw new Error(`Invalid mode: ${mode}. Must be 'cld' or 'sfd'`);
    }

    // Set model type (can only be set once)
    if (session.mode && session.mode !== mode) {
      throw new Error(`Cannot change model type from ${session.mode} to ${mode} during session`);
    }
    session.mode = mode;

    if (clientId == null) {
      throw new Error('clientId is required');
    }

    session.clientTools = tools || [];
    session.context = context || {};
    session.clientId = clientId;
    session.supportsArrays = capabilities.supportsArrays ?? false;
    session.supportsModules = capabilities.supportsModules ?? false;
    session.supportsSubTypes = capabilities.supportsSubTypes ?? false;
    session.supportsMedia = capabilities.supportsMedia ?? false;
    this.updateClientModel(sessionId, model);

    logger.log(`Session initialized: ${sessionId} with mode=${mode} and ${tools.length} client tools`);
  }

  /**
   * Update the client model reference and persist to disk.
   * Returns { modelPath, message } when the model is written.
   */
  updateClientModel(sessionId, model) {
    const session = this.getSession(sessionId);
    if (session) {
      session.clientModel = model;
      if (model) {
        const result = this.#writeModelToDisk(sessionId, model);
        const parts = [];
        if (model.errors?.length) {
          parts.push(`Errors: ${model.errors.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('; ')}`);
        }
        // Unit consistency is decided authoritatively by the client's simulation
        // engine, not by the LLM. When the engine reports an explicit (possibly
        // empty) unitWarnings array, surface its verdict as a concrete fact so the
        // agent has no vacuum to fill with fabricated dimensional inconsistencies.
        // A present-but-empty array is a positive "units are consistent" signal; an
        // absent field means the client did not report a unit check, so stay silent.
        if (Array.isArray(model.unitWarnings)) {
          if (model.unitWarnings.length) {
            parts.push(`Unit warnings (reported by the simulation engine's unit checker — authoritative): ${model.unitWarnings.map(w => typeof w === 'string' ? w : JSON.stringify(w)).join('; ')}`);
          } else {
            parts.push(`Unit check: the simulation engine's unit checker reported NO unit warnings for this model — its units are consistent. Do not report any unit or dimensional-consistency problems.`);
          }
        }
        return { ...result, issues: parts.length ? parts.join('\n') : null };
      }
    }
  }

  /**
   * Get the current client model
   */
  getClientModel(sessionId) {
    const session = this.getSession(sessionId);
    return session?.clientModel;
  }

  /**
   * Update model token count and check if it exceeds limit
   */
  updateModelTokenCount(sessionId, tokenCount) {
    const session = this.getSession(sessionId);
    if (session) {
      session.modelTokenCount = tokenCount;
    }
  }

  /**
   * Get model token count
   */
  getModelTokenCount(sessionId) {
    const session = this.getSession(sessionId);
    return session?.modelTokenCount || 0;
  }

  /**
   * Get session temp directory
   */
  getSessionTempDir(sessionId) {
    const session = this.getSession(sessionId);
    return session?.tempDir;
  }

  /**
   * Write a model to disk and return the LLM message describing where to find it.
   * Returns { modelPath, message }.
   */
  #writeModelToDisk(sessionId, model) {
    const sessionTempDir = this.getSessionTempDir(sessionId);
    const modelPath = join(sessionTempDir, 'model.sdjson');
    try {
      mkdirSync(sessionTempDir, { recursive: true });
    } catch (err) {
      logger.error(`[${sessionId}] Write Model to Disk... failed to create session temp directory '${sessionTempDir}':`, err);
      throw new Error(`Failed to create session temp directory '${sessionTempDir}': ${err.message}`);
    }
    try {
      writeFileSync(modelPath, JSON.stringify(model, null, 2));
    } catch (err) {
      const dirExists = existsSync(sessionTempDir);
      // ENOENT on a path whose parent we just mkdir'd on the line above can only
      // mean the host removed the bwrap bind-mount source out from under this
      // worker — the WebSocket closed and cleanupSessionTempDir rmSync'd the
      // `--bind` source while we were mid-write. The mount point `/session` still
      // stats OK (existsSync=true) but its inode was unlinked, so the create fails.
      // Don't escalate to a fatal worker_error: instead of throwing, hand the agent
      // a message it can respond to so a mid-conversation model write degrades
      // gracefully (the LLM can tell the user the change wasn't persisted) rather
      // than crashing the conversation loop. Any other errno is a genuine failure
      // and still throws.
      if (err.code === 'ENOENT') {
        logger.warn(`[${sessionId}] Session temp dir vanished during model write to '${modelPath}' (mount point exists=${dirExists}) — session is tearing down; skipping write.`);
        return {
          modelPath,
          message: `The model could not be saved — this session's storage is no longer available (the session is likely closing). Do not retry writing the model; let the user know the latest change was not persisted.`,
          skipped: true,
        };
      }
      logger.error(`[${sessionId}] Failed to write model to '${modelPath}' (sessionTempDir exists=${dirExists}):`, err);
      throw new Error(`Failed to write model to '${modelPath}': ${err.message}`);
    }
    const message = `The model has been written to disk at: ${modelPath}. Other tools will load it automatically — you do not need to read this file. Use the read_model_section tool if you need to inspect specific sections.`;
    return { modelPath, message };
  }

  /**
   * Write arbitrary data to a named file in the session temp directory.
   * Returns { filePath, message }.
   */
  writeDataToDisk(sessionId, filename, data) {
    const sessionTempDir = this.getSessionTempDir(sessionId);
    const filePath = join(sessionTempDir, filename);
    try {
      mkdirSync(sessionTempDir, { recursive: true });
    } catch (err) {
      logger.error(`[${sessionId}] Write Data to Disk... failed to create session temp directory '${sessionTempDir}':`, err);
      throw new Error(`Failed to create session temp directory '${sessionTempDir}': ${err.message}`);
    }
    try {
      writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (err) {
      logger.error(`[${sessionId}] Failed to write data to '${filePath}':`, err);
      throw new Error(`Failed to write data to '${filePath}': ${err.message}`);
    }
    const message = `The data has been written to disk at: ${filePath}. Use the Read filesystem tool to load it into context.`;
    return { filePath, message };
  }

  /**
   * Add to conversation context
   */
  addToConversationHistory(sessionId, message) {
    const session = this.getSession(sessionId);
    if (session) {
      const context = session.conversationContext;
      context.push(message);

      // Limit conversation history size to prevent memory bloat. Trim in place —
      // every manual agent loop holds a long-lived reference to this exact array
      // (getConversationContext), so reassigning it here would orphan the running
      // conversation: queued user turns and summarization would land on an array
      // nobody sends to the API.
      const overflow = context.length - this.maxConversationHistory;
      if (overflow > 0) {
        // Advance the cut to the next message that can legally open a
        // conversation. Cutting exactly `overflow` would routinely behead a live
        // tool sequence: a long or restored session sits pinned at the cap, so
        // every append trims one message off the head and can leave the array
        // starting on a dangling tool_result (or an assistant turn), which the
        // provider rejects outright.
        let cut = overflow;
        while (cut < context.length && !isSafeConversationStart(context[cut])) cut++;

        // Only accept a boundary that still leaves a usable history. When the
        // nearest safe cut would gut the conversation (one long unbroken tool
        // sequence), skip the trim: this is a soft memory backstop, while
        // #summarizeContextIfNeeded is the mechanism that actually has to hold
        // context in bounds — and it preserves tool_use/tool_result pairing.
        const minRetained = Math.floor(this.maxConversationHistory / 2);
        if (cut < context.length && context.length - cut >= minRetained) {
          context.splice(0, cut);
        } else {
          logger.debug(`[${sessionId}] Conversation history over cap (${context.length}) but no safe trim boundary; leaving intact for the summarizer`);
        }
      }
    }
  }

  /**
   * Get conversation context
   */
  getConversationContext(sessionId) {
    const session = this.getSession(sessionId);
    return session?.conversationContext || [];
  }

  /**
   * Add or replace an attached file's metadata (keyed by fileId).
   */
  addAttachedFile(sessionId, fileMeta) {
    const session = this.getSession(sessionId);
    if (session) {
      session.attachedFiles.set(fileMeta.fileId, fileMeta);
    }
  }

  /**
   * Remove an attached file's metadata. Returns true if it existed.
   */
  removeAttachedFile(sessionId, fileId) {
    const session = this.getSession(sessionId);
    return session ? session.attachedFiles.delete(fileId) : false;
  }

  /**
   * Get the current attached-file metadata as an array (the snapshot sent to the
   * client and used to build the RAG manifest in the system prompt).
   */
  getAttachedFiles(sessionId) {
    const session = this.getSession(sessionId);
    return session ? Array.from(session.attachedFiles.values()) : [];
  }

  /**
   * Summarize an array of messages using the LLM and return a single summary message object.
   * Private — only called by #summarizeContextIfNeeded and cleanupContext.
   *
   * `provider` selects the summarization API: 'google' → Gemini (Gemini-format
   * output), a native-API provider (config.nativeAgentProviders) → the vendor's
   * OpenAI-compatible API, an OpenRouter brand (config.openRouterAgentProviders) →
   * OpenRouter chat completions, anything else → Anthropic. OpenRouter, native
   * and Anthropic share the same `{role, content}` output shape; only Gemini
   * emits `{role, parts}`.
   */
  async #summarizeMessages(messages, sessionId, provider) {
    const isGeminiFormat = provider === 'google';
    const isOpenRouter = OPENROUTER_PROVIDERS.has(provider);
    const isNative = NATIVE_PROVIDERS.has(provider);
    try {
      const conversationText = messages.map((msg) => {
        if (Array.isArray(msg.parts)) {
          const role = msg.role === 'user' ? 'User' : 'Assistant';
          const text = msg.parts.filter(p => p.text).map(p => p.text).join('\n');
          return text ? `${role}: ${text}` : '';
        }
        if (msg.role === 'user') {
          return `User: ${typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}`;
        } else if (msg.role === 'assistant') {
          if (Array.isArray(msg.content)) {
            const textContent = msg.content
              .filter(block => block.type === 'text')
              .map(block => block.text || block)
              .join('\n');
            return textContent ? `Assistant: ${textContent}` : '';
          }
          return `Assistant: ${msg.content}`;
        }
        return '';
      }).filter(line => line).join('\n\n');

      const summaryPrompt = `Please create a concise summary of the following conversation history. Focus on:
- The main task or goal the user requested
- Key decisions, findings, or results achieved
- Important context needed for continuing the conversation
- Current state of the work

Keep the summary brief but informative (2-4 paragraphs maximum).

Conversation history:
${conversationText}`;

      const clientId = this.getSession(sessionId)?.clientId ?? null;
      const reporter = new TokenUsageReporter(config.tokenReporterURL, clientId);

      let summaryText;
      if (isGeminiFormat) {
        if (!this.gemini) {
          const GoogleGenAI = await loadGoogleGenai();
          this.gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        }
        const response = await this.gemini.models.generateContent({
          model: config.agentGeminiSummaryModel,
          contents: [{ role: 'user', parts: [{ text: summaryPrompt }] }]
        });
        reporter.report({ provider: Provider.GOOGLE, model: config.agentGeminiSummaryModel, usage: response.usageMetadata, clientKey: false }).catch(() => {});
        summaryText = response.text || response.candidates?.[0]?.content?.parts?.[0]?.text || '';
      } else if (isNative) {
        if (!this.deepSeek) {
          if (!process.env.DEEPSEEK_API_KEY) {
            throw new Error('DeepSeek provider selected but DEEPSEEK_API_KEY is not set');
          }
          const OpenAI = await loadOpenAiSdk();
          this.deepSeek = new OpenAI({
            apiKey: process.env.DEEPSEEK_API_KEY,
            baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
          });
        }
        const model = config.nativeAgentProviders[provider].summaryModel;
        const completion = await this.deepSeek.chat.completions.create({
          model,
          messages: [{ role: 'user', content: summaryPrompt }],
          max_tokens: 1024,
        });
        reporter.report({ provider: Provider.DEEPSEEK, model, usage: completion.usage, clientKey: false }).catch(() => {});
        summaryText = completion.choices?.[0]?.message?.content ?? '';
      } else if (isOpenRouter) {
        if (!this.openRouter) {
          const OpenRouter = await loadOpenRouterSdk();
          this.openRouter = new OpenRouter({ apiKey: process.env.OPEN_ROUTER_API_KEY });
        }
        const model = config.openRouterAgentProviders[provider].summaryModel;
        const completion = await this.openRouter.chat.send({
          chatRequest: {
            model,
            messages: [{ role: 'user', content: summaryPrompt }],
            maxCompletionTokens: 1024,
          }
        });
        reporter.report({ provider: Provider.OPENROUTER, model, usage: completion.usage, clientKey: false }).catch(() => {});
        const message = completion.choices?.[0]?.message;
        if (typeof message?.content === 'string') {
          summaryText = message.content;
        } else if (Array.isArray(message?.content)) {
          summaryText = message.content.filter(b => typeof b?.text === 'string').map(b => b.text).join('');
        } else {
          summaryText = '';
        }
      } else {
        if (!this.anthropic) {
          const Anthropic = await loadAnthropicSdk();
          this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        }
        const response = await this.anthropic.messages.create({
          model: config.agentAnthropicSummaryModel,
          max_tokens: 1024,
          messages: [{ role: 'user', content: summaryPrompt }]
        });
        reporter.report({ provider: Provider.ANTHROPIC, model: config.agentAnthropicSummaryModel, usage: response.usage, clientKey: false }).catch(() => {});
        summaryText = response.content[0].text;
      }

      logger.log(`Created message history summary: ${summaryText.substring(0, 100)}...`);

      if (isGeminiFormat) {
        return {
          role: 'user',
          parts: [{ text: `[Previous conversation summary]\n${summaryText}\n[End of summary - continuing conversation]` }]
        };
      }
      return {
        role: 'user',
        content: `[Previous conversation summary]\n${summaryText}\n[End of summary - continuing conversation]`
      };

    } catch (error) {
      logger.error('Error summarizing message history:', error);
      if (isGeminiFormat) {
        return { role: 'user', parts: [{ text: '[Previous conversation summary: Earlier messages were condensed to save context. The conversation is continuing from this point.]' }] };
      }
      return {
        role: 'user',
        content: '[Previous conversation summary: Earlier messages were condensed to save context. The conversation is continuing from this point.]'
      };
    }
  }

  /**
   * If the session's conversation context exceeds maxContextTokens, summarize all messages
   * and replace the context with [original_user_message, ...summaries]. Messages are split
   * into chunks of MAX_COMPRESSION_TOKENS_PER_PASS before summarizing to handle large
   * histories (e.g. on session initialization) that would exceed the LLM's input limit.
   */
  async #summarizeContextIfNeeded(sessionId, maxContextTokens, provider) {
    const session = this.getSession(sessionId);
    if (!session) return;

    const messages = session.conversationContext;
    if (messages.length <= 1) return;

    const currentTokens = countTokens(JSON.stringify(messages));
    if (currentTokens <= maxContextTokens) return;

    logger.log(`Message history exceeds token limit: ${currentTokens} tokens (limit: ${maxContextTokens}), summarizing context`);

    const lastUserIdx = messages.findLastIndex(m => m.role === 'user');
    const lastMessage = lastUserIdx !== -1 ? messages[lastUserIdx] : null;

    // If the last user message contains tool results (either format), also keep the preceding
    // model turn (tool_use/functionCall blocks) to avoid orphaned pairs.
    let tailStart = lastUserIdx !== -1 ? lastUserIdx : messages.length;
    const isClaudeToolResult = Array.isArray(lastMessage?.content) && lastMessage.content.some(b => b.type === 'tool_result');
    const isGeminiFunctionResponse = Array.isArray(lastMessage?.parts) && lastMessage.parts.some(p => p.functionResponse);
    const prevRole = lastUserIdx > 0 ? messages[lastUserIdx - 1]?.role : null;
    if (lastMessage && (isClaudeToolResult || isGeminiFunctionResponse) &&
        lastUserIdx > 0 && (prevRole === 'assistant' || prevRole === 'model')) {
      tailStart = lastUserIdx - 1;
    }

    const tail = messages.slice(tailStart);
    const remaining = messages.slice(0, tailStart);

    // Split remaining messages into chunks that fit within the per-pass token budget
    const chunks = [];
    let chunk = [];
    let chunkTokens = 0;
    for (const msg of remaining) {
      const msgTokens = countTokens(JSON.stringify(msg));
      if (chunkTokens + msgTokens > SessionManager.MAX_COMPRESSION_TOKENS_PER_PASS && chunk.length > 0) {
        chunks.push(chunk);
        chunk = [];
        chunkTokens = 0;
      }
      chunk.push(msg);
      chunkTokens += msgTokens;
    }
    if (chunk.length > 0) chunks.push(chunk);

    const summaries = await Promise.all(chunks.map(c => this.#summarizeMessages(c, sessionId, provider)));
    const replacement = [...summaries, ...tail];
    messages.splice(0, messages.length, ...replacement);

    const newTokenCount = countTokens(JSON.stringify(messages));
    logger.log(`Summarized context in ${chunks.length} chunk(s): ${messages.length} messages, ${newTokenCount} tokens (saved ${currentTokens - newTokenCount})`);
  }

  /**
   * Clean up the session's conversation context by summarizing if over the token limit.
   */
  async cleanupContext(sessionId, maxContextTokens, provider) {
    await this.#summarizeContextIfNeeded(sessionId, maxContextTokens, provider);
  }

  /**
   * Add a pending tool call
   */
  addPendingToolCall(sessionId, callId, toolName, args) {
    const session = this.getSession(sessionId);
    if (session) {
      let resolver, rejecter;
      const promise = new Promise((resolve, reject) => {
        resolver = resolve;
        rejecter = reject;
      });

      session.pendingToolCalls.set(callId, {
        toolName,
        arguments: args,
        timestamp: Date.now(),
        promise,
        resolve: resolver,
        reject: rejecter
      });

      return promise;
    }
    return Promise.reject(new Error('Session not found'));
  }

  /**
   * Resolve a pending tool call
   */
  // `media` is the metadata of any images the client answered with — handles, not
  // bytes, which the main process has already written to the media store. Resolves
  // with { result, media } rather than a bare result; safe because this promise has
  // exactly one consumer (DynamicToolProvider.requestClientExecution), while the
  // pendingModelRequests and pendingFeedbackRequests paths resolve separately and
  // still hand back a bare result.
  resolvePendingToolCall(sessionId, callId, result, isError = false, media = []) {
    const session = this.getSession(sessionId);
    if (session) {
      const pendingCall = session.pendingToolCalls.get(callId);
      if (pendingCall) {
        if (isError) {
          pendingCall.reject(new Error(typeof result === 'string' ? result : (result?.error || 'Tool call failed')));
        } else {
          pendingCall.resolve({ result, media });
        }
        session.pendingToolCalls.delete(callId);
        return true;
      }
    }
    return false;
  }

  /**
   * Get pending tool call
   */
  getPendingToolCall(sessionId, callId) {
    const session = this.getSession(sessionId);
    return session?.pendingToolCalls.get(callId);
  }

  /**
   * Delete a session and cleanup resources
   */
  deleteSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      // Reject any pending tool calls
      for (const [, pendingCall] of session.pendingToolCalls.entries()) {
        pendingCall.reject(new Error('Session closed'));
      }
      session.pendingToolCalls.clear();

      // Reject pending feedback/model requests created by builtin tools.
      // Each entry owns a setTimeout handle that must be cleared so the
      // session object becomes GC-eligible immediately.
      for (const map of [session.pendingFeedbackRequests, session.pendingModelRequests]) {
        if (!map) continue;
        for (const [, pending] of map.entries()) {
          clearTimeout(pending.timeout);
          pending.reject(new Error('Session closed'));
        }
        map.clear();
      }

      // Clean up session temp folder
      this.cleanupSessionTempDir(session.tempDir);

      // Clean up references
      session.ws = null;
      session.clientModel = null;
      session.conversationContext = [];
      session.attachedFiles.clear();

      this.sessions.delete(sessionId);

      logger.log(`Session deleted: ${sessionId} (remaining: ${this.sessions.size})`);
    }
  }

  /**
   * Clean up a session temp directory
   */
  cleanupSessionTempDir(tempDir) {
    try {
      if (existsSync(tempDir)) {
        // Remove directory and all its contents recursively
        rmSync(tempDir, { recursive: true, force: true });
        logger.log(`Cleaned up temp directory: ${tempDir}`);
      }
    } catch (err) {
      logger.error(`Failed to cleanup temp directory ${tempDir}:`, err);
    }
  }

  /**
   * Start cleanup timer for stale sessions and orphaned temp dirs.
   * Both sweeps are awaited together so the next interval can't fire a second
   * sweep on top of a slow one (worker teardowns can take up to ~4s each).
   */
  #startCleanupTimer() {
    this.cleanupInProgress = false;
    this.cleanupTimer = setInterval(() => {
      if (this.cleanupInProgress) {
        logger.log('SessionManager cleanup cycle still in progress, skipping this tick');
        return;
      }
      this.cleanupInProgress = true;
      Promise.resolve()
        .then(() => this.cleanupStaleSessions())
        .then(() => this.#cleanupOrphanedTempDirs())
        .then(() => this.#cleanupDeadProcessDirs())
        .catch((err) => logger.error('Error during cleanup cycle:', err))
        .finally(() => { this.cleanupInProgress = false; });
    }, this.cleanupInterval);
  }

  /**
   * Clean up stale sessions. Async because, when a worker is running, we must
   * await its exit before deleteSession() rm's the bwrap `--bind` source — a
   * write from inside the still-mounted sandbox after the source is gone fails
   * with ENOENT (see SessionManager#writeModelToDisk error path).
   */
  async cleanupStaleSessions() {
    const now = Date.now();

    // Snapshot first so deleteSession() calls (which mutate this.sessions)
    // during async teardowns can't disturb iteration.
    const candidates = [];
    for (const [sessionId, session] of this.sessions.entries()) {
      const age = now - session.createdAt;
      const inactivity = now - session.lastActivity;
      if (age > this.maxSessionAge || inactivity > this.sessionTimeout) {
        candidates.push({ sessionId, session, age, inactivity });
      }
    }

    let cleanedCount = 0;
    for (const { sessionId, session, age, inactivity } of candidates) {
      // A concurrent WS close may have already removed it while we were
      // awaiting a previous teardown.
      if (!this.sessions.has(sessionId)) continue;

      const trigger = age > this.maxSessionAge ? 'max-age' : 'inactivity';
      const hasWorker = typeof session.workerTeardown === 'function';
      logger.log(
        `Cleaning up stale session: ${sessionId} (trigger=${trigger}, age=${Math.round(age/1000/60)}m, ` +
        `inactive=${Math.round(inactivity/1000/60)}m, hasWorker=${hasWorker}, ` +
        `wsReadyState=${session.ws?.readyState ?? 'none'})`
      );

      // Close WebSocket if still open. This will also fire #onClose on the
      // handler side, which is idempotent with the teardown we're about to do.
      if (session.ws && session.ws.readyState === 1) {
        try { session.ws.close(1000, 'Session timeout'); } catch { /* already closing */ }
      }

      // Wait for the worker to actually exit before we let deleteSession
      // rmSync the temp dir. #killWorker is safe to call twice (the second
      // call sees this.#worker === null and resolves immediately).
      if (hasWorker) {
        const teardownStart = Date.now();
        try {
          await session.workerTeardown();
          logger.log(`[session:${sessionId}] Stale-cleanup worker teardown completed in ${Date.now() - teardownStart}ms`);
        } catch (err) {
          logger.error(`[session:${sessionId}] Worker teardown failed during stale cleanup (proceeding with delete anyway):`, err);
        }
      }

      this.deleteSession(sessionId);
      cleanedCount++;
    }

    if (cleanedCount > 0) {
      logger.log(`Cleaned up ${cleanedCount} stale session(s)`);
    }
  }

  /**
   * Clean up orphaned temp directories
   */
  #cleanupOrphanedTempDirs() {
    try {
      if (!existsSync(this.tempBasePath)) {
        return;
      }

      const tempDirs = readdirSync(this.tempBasePath);
      const activeSessionIds = new Set(this.sessions.keys());
      let cleanedCount = 0;

      for (const dir of tempDirs) {
        // Check if this temp dir belongs to an active session
        if (!activeSessionIds.has(dir)) {
          const fullPath = join(this.tempBasePath, dir);

          // Additional safety check: only delete dirs that match session pattern
          if (dir.startsWith('sess_')) {
            this.cleanupSessionTempDir(fullPath);
            cleanedCount++;
            logger.log(`Cleaned up orphaned temp directory: ${dir}`);
          }
        }
      }

      if (cleanedCount > 0) {
        logger.log(`Cleaned up ${cleanedCount} orphaned temp director(ies)`);
      }
    } catch (err) {
      logger.error('Failed to cleanup orphaned temp dirs:', err);
    }
  }

  /**
   * Shutdown - cleanup all sessions
   */
  shutdown() {
    logger.log('SessionManager shutting down...');

    // Stop cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    // Close all sessions
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.ws && session.ws.readyState === 1) {
        session.ws.close(1000, 'Server shutting down');
      }
      this.deleteSession(sessionId);
    }

    // Final cleanup of any remaining temp directories
    this.#cleanupOrphanedTempDirs();

    logger.log('SessionManager shutdown complete');
  }
}
