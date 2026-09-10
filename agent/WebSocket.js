import { WorkerSpawner, SandboxUnavailableError } from './WorkerSpawner.js';
import { AgentConfigurationManager } from './utilities/AgentConfigurationManager.js';
import { MediaStore } from './utilities/MediaStore.js';
import { isValidFileId } from './utilities/RagStore.js';
import {
  validateClientMessage,
  createSessionCreatedMessage,
  createSessionReadyMessage,
  createAgentSelectedMessage,
  createIntelligenceChangedMessage,
  createAgentTextMessage,
  createErrorMessage,
  createFileAddedMessage,
  createFileRemovedMessage
} from './utilities/MessageProtocol.js';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { randomBytes } from 'crypto';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import logger from '../utilities/logger.js';
import utils from '../utilities/utils.js';
import config from '../config.js';
import { ProviderDisplayNames } from '../utilities/TokenUsageReporter.js';
import { buildIntelligenceDiscovery, resolveLevel, supportsIntelligence } from './utilities/intelligenceLevels.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Cached result of the agent-config scan. Agent .md files don't change at
// runtime, so we read + parse once on first call and reuse for every session
// (originally scanned twice per session — initialize_session and select_agent).
let _availableAgentsCache = null;

function getAvailableAgents() {
  if (_availableAgentsCache) return _availableAgentsCache;

  const configDir = join(__dirname, 'config');
  const agents = [];

  try {
    const files = readdirSync(configDir).filter(f => f.endsWith('.md'));

    for (const file of files) {
      try {
        const content = readFileSync(join(configDir, file), 'utf8');
        const metadata = AgentConfigurationManager.parseContent(content).metadata;

        if (metadata?.name) {
          agents.push({
            id: file.replace('.md', ''),
            name: metadata.name || file.replace('.md', ''),
            role: metadata.role || 'Agent',
            supportedModes: metadata.supported_modes || [],
            supportedProviders: (metadata.supported_providers?.length ? metadata.supported_providers : config.agentProviders)
              .map(id => ({ id, name: ProviderDisplayNames[id] ?? id })),
            description: metadata.description || ''
          });
        }
      } catch (err) {
        logger.warn(`Failed to load agent config from ${file}:`, err.message);
      }
    }
  } catch (err) {
    logger.error('Failed to scan agent config directory:', err);
  }

  // Hardcoded defaults - socrates is the default agent for all model types
  const defaults = {
    sfd: 'socrates',
    cld: 'socrates'
  };

  _availableAgentsCache = { agents, defaults };
  return _availableAgentsCache;
}

// Registry of all live worker processes so signal handlers can kill them all.
const liveWorkers = new Set();

// Kill a worker and all its descendant processes.
//
// IpcWorker (bwrap sandbox): w.pid is undefined. We kill only the bwrap process;
// the kernel kills everything in the PID namespace when its init (bwrap) exits.
//
// ChildProcess (fork fallback): w.pid is a number. The fork is spawned with
// detached:true so it leads its own process group. Killing the group
// (process.kill(-pid, signal)) also kills grandchildren like the claude CLI
// subprocess launched by the Agent SDK — without this they become orphans at
// 100% CPU after the worker is gone.
function killWorkerProcess(w, signal) {
  if (typeof w.pid === 'number' && process.platform !== 'win32') {
    process.kill(-w.pid, signal);
  } else {
    w.kill(signal);
  }
}

export class WebSocketHandler {
  #ws;
  #sessionManager;
  #sessionId = null;
  #worker = null;
  // Promise for an in-flight WorkerSpawner.spawn(). #onClose/#onError/disconnect
  // must await this before deleteSession runs rmSync on the session temp dir —
  // otherwise the bwrap bind-mount source vanishes mid-spawn and the worker
  // hits ENOENT on /session/ipc-*.sock (during connect) or /session/model.sdjson
  // (during writes). Null when no spawn is in flight.
  #workerSpawnPromise = null;
  // The provider and intelligence level the session is currently running. Tracked here
  // because a later set_intelligence has to resolve against the CURRENT provider's
  // ladder, and that message deliberately carries no provider of its own — the whole
  // point is that it changes one thing without restating the session's identity.
  // Both stay null until the first select_agent; intelligence stays null for a
  // provider with no ladder.
  #currentProvider = null;
  #currentIntelligence = null;
  // Wall-clock of the last APPLIED intelligence change, for the cooldown in
  // #handleSetIntelligence. Zero until the first one, so the first is never throttled.
  #lastIntelligenceChangeAt = 0;
  // Minimum gap between applied intelligence changes. A user working a control cannot
  // realistically outrun this; a client looping on the message can, and each applied
  // change costs a Gemini context-cache rebuild on the next turn.
  static #INTELLIGENCE_CHANGE_COOLDOWN_MS = 1000;
  // True once initialize_session has been accepted — which is where
  // AUTHENTICATION_KEY is checked. Until then no other message type is
  // dispatched; anything arriving early is refused and dropped.
  // Without this the key gates exactly one message and nothing else: the worker
  // is prewarmed on connect, so a client that simply skipped initialize_session
  // could go straight to select_agent + chat and drive the whole agent
  // unauthenticated. Enforced regardless of whether a key is configured, so
  // there is one ordering rule rather than two code paths.
  #initialized = false;

  // Messages a client may send before initialize_session has been accepted.
  // disconnect is allowed so an unauthenticated client can still hang up
  // cleanly rather than being forced to drop the socket.
  static #PRE_INIT_MESSAGE_TYPES = new Set(['initialize_session', 'disconnect']);

  // SIGKILL every live worker immediately. Called by process signal handlers so
  // workers don't outlive the main process as orphans.
  static killAll() {
    for (const w of liveWorkers) {
      try { killWorkerProcess(w, 'SIGKILL'); } catch { /* already dead */ }
    }
    liveWorkers.clear();
  }

  constructor(ws, sessionManager) {
    this.#ws = ws;
    this.#sessionManager = sessionManager;
    this.#setup();
  }

  #setup() {
    try {
      this.#sessionId = this.#sessionManager.createSession(this.#ws);
      this.#ws.send(JSON.stringify(createSessionCreatedMessage(this.#sessionId)));
      logger.log(`WebSocket connected: ${this.#sessionId}`);
    } catch (error) {
      logger.error('Failed to create session:', error);
      this.#ws.close(1011, error.message);
      return;
    }

    this.#ws.on('message', (data) => this.#onMessage(data));
    this.#ws.on('close', (code, reason) => this.#onClose(code, reason));
    this.#ws.on('error', (error) => this.#onError(error));

    // No prewarm here. Spawning on connect meant every socket that reached the
    // listener got a bwrap sandbox and a Node process before it had presented
    // the authentication key — up to maxSessions of them, held until the
    // inactivity sweep, from a client that never sends a single frame. The
    // prewarm now runs from the success path of #handleInitializeSession
    // instead; see #prewarmWorker.
  }

  /**
   * Spawn a sandboxed worker eagerly, as soon as initialize_session has been
   * accepted and before select_agent arrives. The worker's IPC socket is up by
   * the time the client sends its first select_agent, so the only remaining
   * latency is the two IPC sends (initialize + select_agent).
   *
   * Deliberately not called on connect: the spawn is the expensive part of a
   * session and must sit behind the authentication key, so that an
   * unauthenticated socket costs a session record and nothing more. The overlap
   * this still buys — the select_agent round trip — is most of what the original
   * prewarm was worth; only the initialize_session round trip is no longer
   * covered.
   *
   * Errors are non-fatal: if the prewarmed spawn fails (bwrap diagnostics,
   * retries exhausted), #handleSelectAgent falls back to a fresh spawn that
   * surfaces the error to the client.
   */
  #prewarmWorker() {
    const tempDir = this.#sessionManager.getSessionTempDir(this.#sessionId);
    const spawnPromise = WorkerSpawner.spawn(this.#sessionId, tempDir);
    this.#workerSpawnPromise = spawnPromise;

    spawnPromise
      .then(w => {
        // Cleanup path may have moved on (WS closed during spawn, or an
        // agent-switch replaced this promise) — the orphan worker must be
        // killed so it doesn't sit around eating resources.
        if (this.#workerSpawnPromise !== spawnPromise) {
          try { killWorkerProcess(w, 'SIGKILL'); } catch { /* already dead */ }
          return;
        }
        this.#worker = w;
        liveWorkers.add(w);
        this.#setupWorkerRelay(w);
        this.#sessionManager.setWorkerTeardown(this.#sessionId, () => this.#killWorker());
        this.#workerSpawnPromise = null;
      })
      .catch(err => {
        logger.warn(`[session:${this.#sessionId}] Worker prewarm failed: ${err.message} — select_agent will retry`);
        if (this.#workerSpawnPromise === spawnPromise) {
          this.#workerSpawnPromise = null;
        }
      });
  }

  async #sendToClient(message) {
    if (this.#ws.readyState === 1) {
      this.#ws.send(JSON.stringify(message));
    }
  }

  async #onMessage(data) {
    try {
      const rawMessage = JSON.parse(data.toString());
      const validation = validateClientMessage(rawMessage);
      if (!validation.success) {
        await this.#sendToClient(createErrorMessage(this.#sessionId, `Invalid message: ${validation.error}`, 'INVALID_MESSAGE'));
        return;
      }

      const message = validation.data;

      // Refused and dropped, not held. The handshake rule is that nothing
      // happens before session_ready: a client that pipelines its opening frames
      // gets them back as errors and resends once the handshake completes.
      //
      // The security property is that no handler runs before the authentication
      // key in #handleInitializeSession has been checked, and discarding the
      // frame outright is the shortest path to it — nothing to replay, nothing
      // to bound against an unauthenticated socket buffering without limit, and
      // no failure path that has to remember to clear a queue.
      if (!this.#initialized && !WebSocketHandler.#PRE_INIT_MESSAGE_TYPES.has(message.type)) {
        logger.warn(`[session:${this.#sessionId}] Dropped '${message.type}' received before initialize_session completed`);
        await this.#sendToClient(createErrorMessage(
          this.#sessionId,
          `'${message.type}' was received before initialize_session completed. Wait for session_ready, then resend.`,
          'SESSION_NOT_INITIALIZED'
        ));
        return;
      }

      // A message from the client is activity. Without this the session's `lastActivity` stayed at
      // whatever it was set to on creation, so the "inactivity" sweep in SessionManager reaped
      // live conversations at 30-35 minutes of age — see SessionManager.touch.
      this.#sessionManager.touch(this.#sessionId);

      await this.#dispatch(message);
    } catch (error) {
      logger.error(`Error handling message for session ${this.#sessionId}:`, error);
      await this.#sendToClient(createErrorMessage(this.#sessionId, error.message, 'MESSAGE_PROCESSING_ERROR'));
    }
  }

  /**
   * Route one validated message to its handler.
   *
   * Split out of #onMessage so the parse/validate/gate steps stay readable
   * ahead of it.
   */
  async #dispatch(message) {
    switch (message.type) {
        case 'initialize_session':
          await this.#handleInitializeSession(message);
          break;
        case 'select_agent':
          await this.#handleSelectAgent(message);
          break;
        case 'set_intelligence':
          await this.#handleSetIntelligence(message);
          break;
        case 'chat':
          await this.#handleChat(message);
          break;
        case 'tool_call_response':
          await this.#handleToolCallResponse(message);
          break;
        case 'model_updated_notification':
          await this.#handleModelUpdated(message);
          break;
        case 'stop_iteration':
          await this.#handleStopIteration(message);
          break;
        case 'add_file':
          await this.#handleAddFile(message);
          break;
        case 'remove_file':
          await this.#handleRemoveFile(message);
          break;
        case 'disconnect': {
          const sessionId = this.#sessionId;
          await this.#waitForSpawnAndKill();
          this.#sessionManager.deleteSession(sessionId);
          this.#ws.close(1000, 'Client requested disconnect');
          break;
        }
        default:
          await this.#sendToClient(createErrorMessage(this.#sessionId, `Unknown message type: ${message.type}`, 'UNKNOWN_MESSAGE_TYPE'));
      }
  }

  async #handleInitializeSession(message) {
    try {
      const authenticationKey = process.env.AUTHENTICATION_KEY;
      if (authenticationKey) {
        if (message.authenticationKey !== authenticationKey) {
          this.#ws.close(1008, 'Unauthorized, please pass valid Authentication key.');
          return;
        }
      }

      if (!utils.supportedPlatform(message.clientProduct, message.clientVersion)) {
        this.#ws.close(1008, 'Your client application is not currently supported.');
        return;
      }

      if (!message.mode || !['cld', 'sfd'].includes(message.mode)) {
        throw new Error('Invalid or missing mode. Must be "cld" or "sfd".');
      }

      const capabilities = {
        supportsArrays: message?.supportsArrays,
        supportsModules: message?.supportsModules,
        supportsSubTypes: message?.supportsSubTypes,
        supportsMedia: message?.supportsMedia
      };

      if (message.clientProduct === 'Stella Architect Beta' && message.clientVersion === '4.3') {
        capabilities.supportsArrays = true;
        capabilities.supportsModules = true;
        capabilities.supportsSubTypes = false;
        // supportsMedia deliberately left alone: 4.3 predates the media protocol
        // entirely, so it falls through to the default of false.
      }
      this.#sessionManager.initializeSession(this.#sessionId, message.mode, message.model, message.tools, message.context, message.clientId, capabilities);

      if (message.historicalMessages && message.historicalMessages.length > 0) {
        for (const histMsg of message.historicalMessages) {
          let role = 'assistant';
          let content = '';

          switch (histMsg.type) {
            case 'user_text':
              role = 'user';
              content = histMsg.content || '';
              break;
            case 'agent_text':
            case 'agent_complete':
              role = 'assistant';
              content = histMsg.content || '';
              break;
            case 'visualization':
              role = 'assistant';
              content = `[Created visualization: ${histMsg.visualizationTitle || 'Untitled'}]`;
              if (histMsg.visualizationDescription) content += ` ${histMsg.visualizationDescription}`;
              break;
          }

          if (content) {
            this.#sessionManager.addToConversationHistory(this.#sessionId, { role, content });
          }
        }

        // Historical-message summarization runs before any orchestrator (and
        // its provider choice) exists — fall back to the default provider's
        // summary API.
        await this.#sessionManager.cleanupContext(this.#sessionId, config.agentMaxContextTokens, config.agentDefaultProvider);
        logger.log(`Loaded ${message.historicalMessages.length} historical messages for session ${this.#sessionId}`);
      }

      // Set only here, after the authentication key, the platform check and
      // every validating call above have all passed. A failure anywhere earlier
      // either closed the socket or fell through to the catch below, and in both
      // cases the session stays unauthenticated and every other message type
      // remains refused.
      this.#initialized = true;

      // First thing after the gate opens, so the bwrap startup + Node module load
      // overlaps the client's select_agent round trip.
      this.#prewarmWorker();

      const { agents, defaults } = getAvailableAgents();
      await this.#sendToClient(createSessionReadyMessage(this.#sessionId, agents, defaults, buildIntelligenceDiscovery()));
      logger.log(`Session initialized: ${this.#sessionId}`);
    } catch (error) {
      logger.error(`Failed to initialize session ${this.#sessionId}:`, error);
      await this.#sendToClient(createErrorMessage(this.#sessionId, `Initialization failed: ${error.message}`, 'INITIALIZATION_ERROR'));
    }
  }

  async #handleSelectAgent(message) {
    try {
      let selectedAgent;

      if (message.agentConfig) {
        const metadata = AgentConfigurationManager.parseContent(message.agentConfig).metadata;
        if (!metadata.name || !metadata.agent_mode) {
          throw new Error('agentConfig must have valid YAML frontmatter with name and agent_mode fields');
        }
        selectedAgent = {
          id: 'custom',
          name: metadata.name,
          supportedProviders: (metadata.supported_providers?.length ? metadata.supported_providers : config.agentProviders)
            .map(id => ({ id, name: ProviderDisplayNames[id] ?? id }))
        };
      } else {
        const { agents } = getAvailableAgents();
        selectedAgent = agents.find(agent => agent.id === message.agentId);
        if (!selectedAgent) {
          throw new Error(`Agent '${message.agentId}' not found. Available agents: ${agents.map(a => a.id).join(', ')}`);
        }
      }

      // Every select_agent — first or subsequent — reuses this session's worker
      // (prewarmed, or spawned fresh below if the prewarm failed). Switching agent is
      // just a new orchestrator inside that worker: conversation history lives in the
      // worker's SessionManager, so it survives the handoff without being copied.
      const conversationHistory = this.#sessionManager.getConversationContext(this.#sessionId);

      // Guard: the WS may have closed during an await above.
      // #onClose already killed the worker and deleted the session — bail out
      // before spawning a new worker that would never be cleaned up.
      if (this.#ws.readyState !== 1) return;

      const tempDir = this.#sessionManager.getSessionTempDir(this.#sessionId);

      // Await prewarm if it's still in flight; on success #worker is already
      // set up (liveWorkers, relay, teardown hook all wired in #prewarmWorker).
      if (this.#workerSpawnPromise) {
        try { await this.#workerSpawnPromise; }
        catch { /* prewarm rejected; fall through to fresh spawn below */ }
      }

      if (!this.#worker) {
        // Prewarm failed, or this is an agent-switch that just killed the
        // prior worker. Spawn fresh. Publish the in-flight spawn so
        // #onClose/#onError/disconnect can await it before deleteSession runs
        // rmSync on tempDir.
        const spawnPromise = WorkerSpawner.spawn(this.#sessionId, tempDir);
        this.#workerSpawnPromise = spawnPromise;
        try {
          this.#worker = await spawnPromise;
        } finally {
          if (this.#workerSpawnPromise === spawnPromise) {
            this.#workerSpawnPromise = null;
          }
        }

        // Guard: WS may have closed during bwrap retry delays (up to 9s).
        if (this.#ws.readyState !== 1) {
          // Await — the worker process is alive and bind-mounted to tempDir.
          // cleanupSessionTempDir below rmSync's that source synchronously, so
          // the worker must be reaped first or it'll write into a vanished
          // bind mount (root cause of the model.sdjson ENOENT).
          await this.#killWorker();
          if (!this.#sessionManager.getSession(this.#sessionId)) {
            this.#sessionManager.cleanupSessionTempDir(tempDir);
          }
          return;
        }

        liveWorkers.add(this.#worker);
        this.#setupWorkerRelay(this.#worker);
        // Let SessionManager's stale-cleanup path await worker exit before
        // rmSync'ing the bwrap bind-mount source.
        this.#sessionManager.setWorkerTeardown(this.#sessionId, () => this.#killWorker());
      } else if (this.#ws.readyState !== 1) {
        // Prewarmed worker was set up successfully, but the WS closed while
        // we were waiting on agent-switch teardown or upstream awaits. Reap
        // the orphan to free the sandbox.
        await this.#killWorker();
        if (!this.#sessionManager.getSession(this.#sessionId)) {
          this.#sessionManager.cleanupSessionTempDir(tempDir);
        }
        return;
      }

      const session = this.#sessionManager.getSession(this.#sessionId);
      if (!this.#worker.connected) {
        throw new Error('Worker process failed to start (sandbox may not be available)');
      }
      this.#worker.send({
        type: 'initialize',
        mode: session.mode,
        model: session.clientModel,
        tools: session.clientTools,
        context: session.context,
        clientId: session.clientId,
        conversationHistory,
        // RAG: the new worker reconciles these against on-disk artifacts (which
        // survive an agent switch) so it reloads rather than re-embeds.
        attachedFiles: this.#sessionManager.getAttachedFiles(this.#sessionId),
        supportsArrays: session.supportsArrays,
        supportsModules: session.supportsModules,
        supportsSubTypes: session.supportsSubTypes,
        supportsMedia: session.supportsMedia,
      });

      const supportedProviders = selectedAgent.supportedProviders; // [{id, name}]
      const provider = supportedProviders.length === 1
        ? supportedProviders[0].id
        : (message.provider ?? config.agentDefaultProvider);
      // An omitted `intelligence` on a provider that hasn't changed means "leave it
      // alone", not "reset to default". Without this, any later select_agent — an agent
      // switch, a re-select — silently undoes a set_intelligence the user made, because
      // select_agent is the message a client sends for reasons unrelated to the level.
      // A provider change does reset, since level ids are per provider.
      const requestedIntelligence = message.intelligence
        ?? (provider === this.#currentProvider ? this.#currentIntelligence : undefined);
      // Resolved against the chosen provider's ladder, never rejected: a client may
      // legitimately send a level valid for the provider it was just using but not for
      // the one it is switching to, and that must degrade rather than fail the session.
      // null when this provider has no ladder, which keeps the message shape unchanged
      // for every provider that ignores the lever.
      const intelligence = resolveLevel(provider, requestedIntelligence)?.id ?? null;
      this.#currentProvider = provider;
      this.#currentIntelligence = intelligence;

      const workerSelectMsg = message.agentConfig
        ? { type: 'select_agent', agentConfig: message.agentConfig, provider, intelligence }
        : { type: 'select_agent', agentId: message.agentId, provider, intelligence };
      this.#worker.send(workerSelectMsg);

      await this.#sendToClient(createAgentSelectedMessage(this.#sessionId, selectedAgent.id, selectedAgent.name, selectedAgent.supportedProviders, provider, intelligence));
      const providerLabel = ProviderDisplayNames[provider] ?? provider;
      await this.#sendToClient(createAgentTextMessage(this.#sessionId, `${selectedAgent.name} (${providerLabel}) — What can I do for you today?`, false));
      logger.log(`Agent selected: ${selectedAgent.id} (${provider}) for session ${this.#sessionId}`);
    } catch (error) {
      logger.error(`Failed to select agent for session ${this.#sessionId}:`, error);
      // A SandboxUnavailableError is permanent for the lifetime of this process
      // (bwrap is broken with no fallback). Returning a retryable
      // AGENT_SELECTION_ERROR here invites a client hot-loop: the client
      // re-sends select_agent on error, spawn fails instantly (no retry delay
      // once #bwrapBroken is latched), and the same socket logs tens of
      // thousands of identical failures per minute. Close the connection
      // instead so there's nothing to retry against on this socket.
      if (error instanceof SandboxUnavailableError) {
        if (this.#ws.readyState === 1) this.#ws.close(1011, 'Worker sandbox unavailable');
        return;
      }
      await this.#sendToClient(createErrorMessage(this.#sessionId, `Agent selection failed: ${error.message}`, 'AGENT_SELECTION_ERROR'));
    }
  }

  /**
   * Change the intelligence level on a live session.
   *
   * Deliberately the lightest possible operation: it forwards one value to the worker
   * and answers with what was applied. It does NOT rebuild the orchestrator the way
   * select_agent does — that would drop the SDK/ADK conversation-continuity handles and
   * emit an agent-switch line, which is exactly the disruption this message exists to
   * avoid. An in-flight turn is untouched and finishes on the model it started with;
   * the new level applies from the next turn.
   *
   * Never errors on a bad value. The reply carries the level actually in effect, so a
   * client that asked for something unavailable is told the truth rather than being
   * left to assume its request stuck.
   */
  async #handleSetIntelligence(message) {
    // The real precondition is a resolved provider — the level is meaningless without
    // one, since ladders are per provider. #currentProvider is set by select_agent.
    if (!this.#currentProvider) {
      await this.#sendToClient(createErrorMessage(this.#sessionId, 'Cannot set intelligence before an agent is selected', 'NO_AGENT'));
      return;
    }

    if (!supportsIntelligence(this.#currentProvider)) {
      // Not an error: the client may be showing a control the provider ignores.
      // Answer with the truth (null) so it can hide it.
      await this.#sendToClient(createIntelligenceChangedMessage(this.#sessionId, null));
      return;
    }

    const intelligence = resolveLevel(this.#currentProvider, message.intelligence)?.id ?? null;
    if (intelligence !== this.#currentIntelligence) {
      // An applied change is not free: it drops the Gemini context cache, so the next
      // turn pays a rebuild. Flipping levels is a client-driven action with no natural
      // rate limit, so cap how often one can be applied. Answering with the level
      // actually in effect is already the contract, which is why a throttled request
      // needs no new message type — the client is told the truth either way.
      const since = Date.now() - this.#lastIntelligenceChangeAt;
      if (since < WebSocketHandler.#INTELLIGENCE_CHANGE_COOLDOWN_MS) {
        logger.warn(`Ignoring intelligence change for session ${this.#sessionId}: ${since}ms since the last one`);
        await this.#sendToClient(createIntelligenceChangedMessage(this.#sessionId, this.#currentIntelligence));
        return;
      }

      this.#lastIntelligenceChangeAt = Date.now();
      this.#currentIntelligence = intelligence;
      this.#worker?.send({ type: 'set_intelligence', intelligence });
      logger.log(`Intelligence set to "${intelligence}" (${this.#currentProvider}) for session ${this.#sessionId}`);
    }

    await this.#sendToClient(createIntelligenceChangedMessage(this.#sessionId, intelligence));
  }

  async #handleChat(message) {
    try {
      if (!this.#worker) {
        throw new Error('No agent selected. Send select_agent first.');
      }
      this.#worker.send({ type: 'chat', message: message.message });
    } catch (error) {
      logger.error(`Error in chat for session ${this.#sessionId}:`, error);
      await this.#sendToClient(createErrorMessage(this.#sessionId, error.message, 'CHAT_ERROR'));
    }
  }

  // Forward to worker which owns all pending promise maps
  async #handleToolCallResponse(message) {
    try {
      // The client is done with the tool, so the hold it had on the inactivity sweep ends here —
      // before every early return below, because each of them is still an answer.
      this.#sessionManager.finishClientToolCall(this.#sessionId, message.callId);

      if (!this.#worker) {
        logger.warn(`Received tool_call_response for ${message.callId} but no worker is running`);
        return;
      }

      // Images the tool answered with. Decoded and written to disk here, in the
      // main process, mirroring #handleAddFile — and for the same two reasons: the
      // decoded byte size can only be checked after decoding and must not be
      // decoded twice, and the main process stays the single owner of the
      // bytes-to-WebSocket boundary in both directions. Only the resulting
      // handles cross the IPC channel.
      let media = [];
      if (message.media?.length) {
        const store = new MediaStore(this.#sessionManager, this.#sessionId);
        try {
          media = message.media.map(item => store.captureBase64(item.content, {
            name: item.name,
            mimeType: item.mimeType,
            description: item.description,
            source: 'client'
          }));
        } catch (error) {
          // Answered as a tool error rather than dropped, so the model learns the
          // picture did not arrive instead of waiting out the tool's timeout.
          this.#worker.send({
            type: 'tool_response',
            callId: message.callId,
            result: `The image this tool returned was rejected: ${error.message}`,
            isError: true,
          });
          await this.#sendToClient(createErrorMessage(this.#sessionId, error.message,
            error.code || 'MEDIA_REJECTED'));
          return;
        }
      }

      this.#worker.send({
        type: 'tool_response',
        callId: message.callId,
        result: message.result,
        isError: message.isError,
        media,
      });
    } catch (error) {
      logger.error(`Error forwarding tool response for session ${this.#sessionId}:`, error);
      await this.#sendToClient(createErrorMessage(this.#sessionId, error.message, 'TOOL_RESPONSE_ERROR'));
    }
  }

  async #handleModelUpdated(message) {
    try {
      // Keep main-process SessionManager in sync (used to initialize new workers on agent switch)
      this.#sessionManager.updateClientModel(this.#sessionId, message.model);
      // Forward to worker so AgentOrchestrator sees the updated model token count
      this.#worker?.send({ type: 'model_updated', model: message.model });
      logger.log(`Model updated for session ${this.#sessionId}: ${message.changeReason}`);
    } catch (error) {
      logger.error(`Error updating model for session ${this.#sessionId}:`, error);
    }
  }

  async #handleStopIteration() {
    try {
      if (!this.#worker) {
        throw new Error('No active agent to stop');
      }
      logger.log(`Stop iteration requested for session ${this.#sessionId}`);
      this.#worker.send({ type: 'stop' });
    } catch (error) {
      logger.error(`Error stopping iteration for session ${this.#sessionId}:`, error);
      await this.#sendToClient(createErrorMessage(this.#sessionId, error.message, 'STOP_ITERATION_ERROR'));
    }
  }

  // RAG: client attaches a file. The main process is authoritative for "the
  // bytes exist": it writes them to the host temp dir (== the worker's /session
  // bind-mount source), tracks metadata, acks immediately with the full file
  // snapshot, then forwards a lightweight notification to the worker which does
  // the extraction/embedding and reports back via rag_file_processed.
  async #handleAddFile(message) {
    try {
      const fileId = message.fileId || `file_${randomBytes(8).toString('hex')}`;
      // Belt and braces: the schema already rejects a malformed fileId, but this
      // value becomes a path segment two lines below and the check is free.
      if (!isValidFileId(fileId)) {
        await this.#sendToClient(createErrorMessage(this.#sessionId, `Invalid fileId: ${message.fileId}`, 'INVALID_FILE_ID'));
        return;
      }

      const existing = this.#sessionManager.getAttachedFiles(this.#sessionId);
      const isNew = !existing.some(f => f.fileId === fileId);
      if (isNew && existing.length >= config.ragMaxFilesPerSession) {
        await this.#sendToClient(createErrorMessage(this.#sessionId, `Attached file limit reached (${config.ragMaxFilesPerSession}).`, 'FILE_LIMIT_EXCEEDED'));
        return;
      }

      const buffer = Buffer.from(message.content, message.encoding === 'base64' ? 'base64' : 'utf8');
      if (buffer.length > config.ragMaxFileBytes) {
        await this.#sendToClient(createErrorMessage(this.#sessionId, `File '${message.name}' exceeds the maximum size of ${config.ragMaxFileBytes} bytes.`, 'FILE_TOO_LARGE'));
        return;
      }

      const tempDir = this.#sessionManager.getSessionTempDir(this.#sessionId);
      const fileDir = join(tempDir, 'rag', fileId);
      mkdirSync(fileDir, { recursive: true });
      writeFileSync(join(fileDir, 'original.bin'), buffer);

      const addedAt = new Date().toISOString();
      this.#sessionManager.addAttachedFile(this.#sessionId, {
        fileId,
        name: message.name,
        mimeType: message.mimeType,
        bytes: buffer.length,
        tokenCount: null,
        tier: null,
        chunkCount: 0,
        status: 'processing',
        addedAt
      });

      // Immediate ack (status: processing). A second file_added snapshot follows
      // from the worker's rag_file_processed once extraction/embedding completes.
      await this.#sendToClient(createFileAddedMessage(this.#sessionId, this.#sessionManager.getAttachedFiles(this.#sessionId)));

      this.#worker?.send({ type: 'add_file', fileId, name: message.name, mimeType: message.mimeType, addedAt });
    } catch (error) {
      logger.error(`Error adding file for session ${this.#sessionId}:`, error);
      await this.#sendToClient(createErrorMessage(this.#sessionId, error.message, 'ADD_FILE_ERROR'));
    }
  }

  // RAG: client removes a file. Drop metadata + on-disk artifacts (covers the
  // no-worker case) and forward to the worker so it drops its in-memory vectors.
  async #handleRemoveFile(message) {
    try {
      // Guarded before it reaches rmSync(recursive) — see #handleAddFile.
      if (!isValidFileId(message.fileId)) {
        await this.#sendToClient(createErrorMessage(this.#sessionId, `Invalid fileId: ${message.fileId}`, 'INVALID_FILE_ID'));
        return;
      }

      const tempDir = this.#sessionManager.getSessionTempDir(this.#sessionId);
      this.#sessionManager.removeAttachedFile(this.#sessionId, message.fileId);
      try { rmSync(join(tempDir, 'rag', message.fileId), { recursive: true, force: true }); } catch { /* already gone */ }
      await this.#sendToClient(createFileRemovedMessage(this.#sessionId, this.#sessionManager.getAttachedFiles(this.#sessionId)));
      this.#worker?.send({ type: 'remove_file', fileId: message.fileId });
    } catch (error) {
      logger.error(`Error removing file for session ${this.#sessionId}:`, error);
      await this.#sendToClient(createErrorMessage(this.#sessionId, error.message, 'REMOVE_FILE_ERROR'));
    }
  }

  async #onClose(code, reason) {
    logger.log(`WebSocket closed: ${this.#sessionId} (code: ${code}, reason: ${reason})`);
    if (this.#sessionId) {
      const sessionId = this.#sessionId;
      const startedAt = Date.now();
      await this.#waitForSpawnAndKill();
      const elapsed = Date.now() - startedAt;
      logger.log(`[session:${sessionId}] Worker shutdown completed in ${elapsed}ms; deleting session`);
      this.#sessionManager.deleteSession(sessionId);
    }
  }

  async #onError(error) {
    logger.error(`WebSocket error for session ${this.#sessionId}:`, error);
    if (this.#sessionId) {
      const sessionId = this.#sessionId;
      await this.#waitForSpawnAndKill();
      this.#sessionManager.deleteSession(sessionId);
    }
  }

  // Cleanup-path helper: wait for any in-flight WorkerSpawner.spawn() to settle,
  // then kill the resulting worker. Callers must use this (not bare #killWorker)
  // anywhere they're about to deleteSession or rmSync the session temp dir —
  // otherwise a WS close arriving mid-spawn lets the cleanup path race ahead of
  // bwrap's --bind setup and the worker hits ENOENT on /session.
  async #waitForSpawnAndKill() {
    if (this.#workerSpawnPromise) {
      try { await this.#workerSpawnPromise; } catch { /* spawn rejection is fine — nothing to kill */ }
    }
    await this.#killWorker();
  }

  // Returns a promise that resolves once the worker process has actually exited
  // (or after the SIGKILL fallback fires). Callers that destroy the session temp
  // directory MUST await this — bwrap's `--bind` source vanishing under a live
  // sandbox produces ENOENT on writes from inside the container.
  #killWorker() {
    if (!this.#worker) return Promise.resolve();
    const w = this.#worker;
    const sessionId = this.#sessionId;
    this.#worker = null;
    liveWorkers.delete(w);
    if (w.connected) {
      try { w.send({ type: 'shutdown' }); } catch { /* already dead */ }
    }
    return new Promise((resolve) => {
      let settled = false;
      const settle = () => { if (!settled) { settled = true; resolve(); } };

      const sigkillTimer = setTimeout(() => {
        logger.warn(`[worker:${sessionId}] did not exit within 2s of shutdown — sending SIGKILL`);
        try { killWorkerProcess(w, 'SIGKILL'); } catch { /* already dead */ }
      }, 2000);

      // Safety: if 'exit' was already emitted before we attached (or never
      // fires), don't hang the session-cleanup path forever.
      const fallbackTimer = setTimeout(() => {
        logger.warn(`[worker:${sessionId}] exit event not received 4s after shutdown — proceeding with cleanup`);
        settle();
      }, 4000);

      w.once('exit', () => {
        clearTimeout(sigkillTimer);
        clearTimeout(fallbackTimer);
        settle();
      });
    });
  }

  /**
   * Swap the handles on an outbound tool_call_request for the bytes they name.
   *
   * Returns a new message rather than mutating the worker's: the original is
   * handle-only and there is no reason to leave a megabyte of base64 reachable
   * from it after the frame has been written.
   */
  #hydrateOutboundMedia(message) {
    const store = new MediaStore(this.#sessionManager, this.#sessionId);

    return {
      ...message,
      media: message.media.map(item => ({
        ...item,
        encoding: 'base64',
        content: store.readBase64(item.mediaId)
      }))
    };
  }

  /**
   * Wire up the IPC relay for a freshly spawned worker.
   * - Forwards all to_client messages to the WebSocket.
   * - Logs worker stdout/stderr.
   * - Cleans up on unexpected exit.
   */
  #setupWorkerRelay(w) {
    w.on('message', async (msg) => {
      // Anything from the worker is activity too, and this is the half that matters for a long
      // agent turn: the client sends one message and then waits, sometimes for minutes, while the
      // worker streams tool calls and usage back. Touching only on inbound client messages would
      // still let a single slow turn age past the inactivity limit and be reaped mid-flight.
      this.#sessionManager.touch(this.#sessionId);

      if (msg.type === 'to_client') {
        // Only forward if this is still the active worker; drop stale messages
        // from a worker that has been replaced or is in its shutdown grace period.
        if (this.#worker === w && this.#ws.readyState === 1) {
          let out = msg.message;

          // Image bytes are attached here, on their way out, rather than by the
          // worker that built the message. The worker sent handles and metadata;
          // this is where they become base64.
          //
          // Here because the IPC channel is newline-delimited JSON reassembled
          // with `buf += chunk`, so one 27 MiB line is quadratic to parse *and*
          // blocks every streaming agent_text queued behind it — and because it
          // keeps the main process the sole owner of the bytes-to-frame boundary
          // in both directions, which is the invariant #handleAddFile already
          // establishes. `w` is in scope, so the failure path can answer the
          // worker directly with no new IPC message type and no round trip.
          if (out.type === 'tool_call_request' && out.media?.length) {
            try {
              out = this.#hydrateOutboundMedia(out);
            } catch (error) {
              // Should be unreachable: the worker checked the handles existed
              // before sending. Fail the call back rather than handing the client
              // a request whose bytes are missing.
              logger.error(`Could not attach media for tool call ${out.callId}:`, error);
              w.send({
                type: 'tool_response',
                callId: out.callId,
                result: `The image could not be read from the session store: ${error.message}`,
                isError: true,
              });
              return;
            }
          }

          this.#ws.send(JSON.stringify(out));

          // From here until the client answers, a session running a tool is indistinguishable from
          // an abandoned one: the request has gone out, the worker is blocked on the reply, and
          // neither side sends anything. Registered after the send, and only on the branch that
          // actually sent, because a request the client never received is not a tool it is running.
          if (out.type === 'tool_call_request') {
            this.#sessionManager.startClientToolCall(this.#sessionId, out.callId, out.timeout);
          }
        }
      } else if (msg.type === 'worker_error') {
        logger.error(`[worker:${this.#sessionId}] ${msg.error}`);
      } else if (msg.type === 'rag_file_processed') {
        // The worker finished extraction/embedding. Update the authoritative
        // metadata and push a refreshed snapshot so the client sees the final
        // status (and so a future agent switch re-initializes correctly).
        if (this.#worker === w) {
          // Drop a late result for a file that's no longer tracked: a quick
          // attach-then-remove deletes the shared rag/<id> bytes out from under
          // the still-queued add_file, so the worker reports it (errored) after
          // the main already removed it. Re-adding here would resurrect a
          // removed file in the client's snapshot.
          const stillTracked = this.#sessionManager.getAttachedFiles(this.#sessionId).some(f => f.fileId === msg.fileId);
          if (!stillTracked) {
            logger.log(`[session:${this.#sessionId}] Ignoring RAG result for untracked file ${msg.fileId} (removed before processing finished)`);
          } else {
            this.#sessionManager.addAttachedFile(this.#sessionId, msg.meta);
            if (this.#ws.readyState === 1) {
              this.#ws.send(JSON.stringify(createFileAddedMessage(this.#sessionId, this.#sessionManager.getAttachedFiles(this.#sessionId))));
            }
          }
        }
      }
    });

    w.on('error', (err) => logger.error(`[worker:${this.#sessionId}] process error: ${err.message}`));
    
    w.on('exit', (code, signal) => {
      logger.log(`[worker:${this.#sessionId}] exited (code=${code} signal=${signal})`);
      liveWorkers.delete(w);
      if (this.#worker === w) this.#worker = null;
    });
  }
}
