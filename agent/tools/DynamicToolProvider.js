import { StructuredOutputToZodConverter } from '../../utilities/StructuredOutputToZodConverter.js';
import { toolResultToText, mediaBlock, mediaBlocksOf, toMcpContentResult } from '../utilities/ToolResultFormatter.js';
import { MediaStore } from '../utilities/MediaStore.js';
import { sanitizeSchemaForGemini } from './builtin/toolHelpers.js';
import { mediaCapability } from './toolAvailability.js';
import logger from '../../utilities/logger.js';
import config from '../../config.js';

// Provider SDK symbols are lazy-loaded — see BuiltInToolProvider for the same pattern.
// Use MCP's own McpServer instead of the Claude Agent SDK's tool()/createSdkMcpServer:
// the agent SDK bundles an older MCP whose converter strips field descriptions from
// advertised tool schemas. See BuiltInToolProvider for the full rationale.
let _McpServer;
const loadMcpServer = async () =>
  _McpServer ??= (await import('@modelcontextprotocol/sdk/server/mcp.js')).McpServer;
let _FunctionTool;
const loadFunctionTool = async () =>
  _FunctionTool ??= (await import('@google/adk')).FunctionTool;

/**
 * DynamicToolProvider
 * Provides tools from client-registered tool definitions
 *
 * Handles:
 * - Converting client tool definitions to tool collection format
 * - Proxying tool calls to client via WebSocket
 * - Waiting for client responses with timeout
 * - Special handling for get_current_model and update_model
 */
export class DynamicToolProvider {
  // mediaStore is required, and injected by AgentOrchestrator, which shares one
  // instance across every consumer in the worker. Required rather than defaulted so
  // there is exactly one construction site to reason about: the store is a handle
  // over a directory and a second instance would work, but "who owns this" having a
  // single answer is worth more than the convenience of not passing it.
  constructor(sessionManager, sessionId, sendToClient, mediaStore) {
    this.sessionManager = sessionManager;
    this.sessionId = sessionId;
    this.sendToClient = sendToClient;
    this.schemaConverter = new StructuredOutputToZodConverter();
    this.mediaStore = mediaStore;

    // Images a client tool returned on the google-sdk (ADK) route, waiting to be
    // pushed onto the next request. See getAdkTools for why they cannot simply be
    // returned. Drained by the orchestrator's beforeModelCallback.
    this.pendingAdkMedia = [];

    const session = sessionManager.getSession(sessionId);
    const clientTools = session?.clientTools || [];
    this.toolCollection = this.#createToolCollectionFromClientTools(clientTools);
    logger.log(`DynamicToolProvider initialized for session ${sessionId} with ${clientTools.length} client tools`);
  }

  /**
   * Create tool collection from client tool definitions
   */
  #createToolCollectionFromClientTools(clientTools) {
    const tools = {};

    for (const toolDef of clientTools) {
      const toolName = `client_${toolDef.name}`;
      tools[toolName] = {
        description: toolDef.description,
        inputSchema: this.schemaConverter.convert(toolDef.inputSchema),
        handler: this.#createToolHandler(toolDef),
        timeout: toolDef.timeout ?? 30000
      };
    }

    return {
      name: 'client_tools',
      tools
    };
  }

  /**
   * Create a tool handler that proxies to the client
   * Note: toolDef.name is the UNPREFIXED name (e.g., 'get_current_model')
   */
  #createToolHandler(toolDef) {
    return async (args) => {
      try {
        // Unprefixed name when communicating with the client. The timeout and the
        // media contract are read from the client's own definition inside
        // requestClientExecution, so there is nothing to pass and nothing to drop.
        return await this.requestClientExecution(toolDef.name, args);

      } catch (error) {
        logger.log(`Error executing client tool ${toolDef.name}:`, error);
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    };
  }

  /**
   * Request client to execute a tool
   */
  /**
   * Resolve this tool's declared media handles to the metadata the client needs.
   *
   * Metadata only — no `content`. The base64 is injected by the main-process relay
   * on the way out, not here, because the worker IPC channel is newline-delimited
   * JSON accumulated with `buf += chunk`: a 27 MiB line is quadratic to reassemble
   * *and* head-of-line-blocks every streaming agent_text queued behind it.
   *
   * An unknown handle fails the call here, with no client round trip at all, so the
   * model gets a useful error instead of the client getting a meaningless string.
   */
  #resolveMediaArguments(toolDef, args) {
    const declared = toolDef?.media?.inputs;
    if (!declared?.length) return { media: [] };

    const media = [];

    for (const argument of declared) {
      const mediaId = args?.[argument];
      if (mediaId === undefined || mediaId === null || mediaId === '') continue;

      if (!MediaStore.isValidMediaId(mediaId) || !this.mediaStore.exists(mediaId)) {
        return {
          error: `'${mediaId}' is not an image I have. The '${argument}' argument takes a media `
               + `handle like med_0123456789abcdef, as returned by generate_image — not a file name `
               + `or a description. Generate the image first, then pass the handle it gives you.`
        };
      }

      const meta = this.mediaStore.meta(mediaId);
      media.push({
        mediaId: meta.mediaId,
        argument,
        name: meta.name,
        mimeType: meta.mimeType,
        bytes: meta.bytes
      });
    }

    if (media.length > config.mediaMaxItemsPerCall) {
      return { error: `That call carries ${media.length} images, over the limit of ${config.mediaMaxItemsPerCall}.` };
    }

    return { media };
  }

  /**
   * The client's own definition of a tool, by its unprefixed name.
   *
   * Looked up rather than passed in, because passing it was got wrong three times:
   * once on each manual route, and once on the openrouter-sdk route where the value
   * to hand was a *collection entry* that looks near-identical but carries no media
   * contract. Every one of those failed silently — a tool expecting bytes was sent a
   * bare handle, and a tool asking for an eight-hour timeout got thirty seconds.
   * There is now no parameter to forget.
   */
  #clientToolDef(toolName) {
    const session = this.sessionManager.getSession(this.sessionId);
    return (session?.clientTools || []).find(tool => tool.name === toolName) ?? null;
  }

  async requestClientExecution(toolName, args, timeout) {
    const toolDef = this.#clientToolDef(toolName);
    timeout = timeout ?? toolDef?.timeout ?? 30000;
    const callId = this.#generateCallId();

    const resolved = this.#resolveMediaArguments(toolDef, args);
    if (resolved.error) {
      return { content: [{ type: 'text', text: resolved.error }], isError: true };
    }

    // Create pending call that will be resolved when client responds
    const resultPromise = this.sessionManager.addPendingToolCall(
      this.sessionId,
      callId,
      toolName,
      args
    );

    // Send tool_call_request to client (separate from tool_call_notification)
    // This actually requests the client to execute the tool and send back results
    await this.sendToClient({
      type: 'tool_call_request',
      sessionId: this.sessionId,
      callId,
      toolName,
      // The handle stays in `arguments` exactly as the model wrote it — the model's
      // view of its own call is never rewritten — and the bytes arrive beside it,
      // keyed by the argument they are the real value of.
      arguments: args,
      ...(resolved.media.length ? { media: resolved.media } : {}),
      timeout
    });

    // Wait for client response with timeout. The timer is cleared in the finally
    // below: left uncleared it held itself and its closure alive for the full
    // timeout after every fast resolution, which is cheap at 30s and much less so
    // for a media tool asking for minutes.
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        // Named here because a client that answers late only produces an
        // "Unknown callId" warning in the worker, which can't say which tool it was.
        logger.warn(`[DynamicToolProvider] ${toolName} (${callId}) timed out after ${timeout}ms; a late client response will be dropped`);
        reject(new Error(`Tool call timeout: ${toolName} did not respond within ${timeout}ms`));
      }, timeout);
    });

    try {
      const { result, media = [] } = await Promise.race([resultPromise, timeoutPromise]);
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

      // The handles go in the text as well as in their own blocks, for two
      // reasons: the model learns what to call the picture so it can pass it to
      // another tool, and a provider route that cannot render an image still gets
      // a coherent account of what came back instead of a silent hole.
      const notes = media.map(meta => this.mediaStore.describeForModel(meta));

      return {
        content: [
          { type: 'text', text: notes.length ? `${text}\n\nAttached: ${notes.join('; ')}` : text },
          ...media.map(mediaBlock)
        ],
        isError: false
      };
    } catch (error) {
      // Clean up pending call
      const pendingCall = this.sessionManager.getPendingToolCall(this.sessionId, callId);
      if (pendingCall) {
        this.sessionManager.resolvePendingToolCall(this.sessionId, callId, { error: error.message }, true);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Generate a unique call ID
   */
  #generateCallId() {
    return `call_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }

  /**
   * Get the tool collection
   */
  getTools() {
    return this.toolCollection;
  }

  /**
   * Get list of registered client tool names (with client_ prefix)
   */
  getToolNames() {
    return Object.keys(this.toolCollection?.tools || {});
  }

  /**
   * Check if a tool is a client tool (expects prefixed name)
   */
  isClientTool(toolName) {
    return this.getToolNames().includes(toolName);
  }

  /**
   * The client's tools as a system-prompt section, or '' when it registered none.
   *
   * Not an inventory the model could not otherwise see: every route already puts these
   * tools in the request's tool list, with name, description and schema, before the
   * first token is generated. What a schema cannot say is where they came from — that
   * this set is the host application's and varies with it, so a capability missing here
   * is a fact about this client and not about the task. Without that, an unfamiliar name
   * reads as an oddity to route around, and a familiar-sounding absence reads as
   * something to promise anyway.
   *
   * A discovery tool would be the wrong shape for the same information: a round trip to
   * fetch what is already in the context window that requested it, and — because the
   * model-facing name of a client tool differs by route — one that would have to know
   * which loop it was running inside to avoid naming the tools wrongly.
   *
   * Every name it prints is a tool that is live in the same request. That is a property
   * of where it reads from, not of care taken here: the source is `this.toolCollection`,
   * the one object getTools, getMcpServer and getAdkTools all build their registrations
   * out of, run through #liveClientTools — the same filter those registrations use. A
   * roster naming a tool the route did not register would be worse than no roster, since
   * the model would plan around a call that comes back "unknown tool".
   *
   * @param {'prefixed'|'bare'} nameStyle  How this route names a client tool to the model.
   *        'prefixed' — `client_foo`, which is every route but the ADK one. The
   *        anthropic-sdk route rewrites that to mcp__client__foo in the same pass that
   *        rewrites the rest of the prompt, so it wants 'prefixed' too.
   *        'bare' — `foo`, which is what getAdkTools registers.
   * @param {Set<string>} builtInToolNames  Built-in tool names, for the shadowing check
   *        in #liveClientTools.
   */
  buildPromptRoster(nameStyle, builtInToolNames) {
    const live = this.#liveClientTools(nameStyle, builtInToolNames);
    if (live.length === 0) return '';

    // Read off the same capability the media built-ins are gated by, so the roster can
    // never describe a handle flow this session does not have: a client that declares a
    // media contract but no supportsMedia gets neither generate_image nor a sentence
    // telling the model to pass its output somewhere.
    const session = this.sessionManager.getSession(this.sessionId);
    const { declared } = mediaCapability(session);

    const lines = live.map(({ modelFacingName, unprefixedName, toolDef }) => {
      // The media contract lives on the client's own definition, not on the collection
      // entry — the same asymmetry #clientToolDef exists to absorb. Stating it here
      // rather than leaving it to the description, which the client wrote without
      // knowing handles exist, is what stops the model passing a file name and learning
      // the difference from #resolveMediaArguments' error.
      const clientDef = this.#clientToolDef(unprefixedName);
      const notes = [];
      const mediaInputs = declared ? (clientDef?.media?.inputs || []) : [];
      if (mediaInputs.length > 0) {
        notes.push(`pass an image handle from generate_image in ${mediaInputs.map(a => `\`${a}\``).join(', ')}`);
      }
      if (declared && clientDef?.media?.returnsMedia === true) notes.push('may answer with an image');

      const description = toolDef.description ? ` — ${toolDef.description}` : '';
      const suffix = notes.length > 0 ? ` (${notes.join('; ')})` : '';
      return `- \`${modelFacingName}\`${description}${suffix}`;
    });

    return `## Tools From This Application
The application the user is working in registered the tools below for this session. They act on that application itself — its interface, its files, its exports — which nothing else available to you can do. Prefer one whenever the request matches what it does, instead of approximating the result another way or telling the user to do it by hand.

This list is complete and fixed for the session. A capability not named here is one this application did not offer, so never promise, imply, or plan around an action you have no tool for.
${lines.join('\n')}`;
  }

  /**
   * The client tools a route can actually put in front of the model, under the names it
   * will use. The single definition of "live", so a registration and the roster that
   * announces it cannot disagree.
   *
   * The one thing that can drop a tool here is a name collision with a built-in. It can
   * only happen under 'bare', since `client_foo` is not a name any built-in has — which
   * is to say only on the ADK route, the one route that registers client tools
   * unprefixed. Two tools with one name is not a state to hand a provider: the manual
   * routes already refuse it ("skipping client version, using built-in") and this makes
   * ADK refuse it the same way, loudly, instead of registering a duplicate and letting
   * the SDK pick.
   *
   * The built-in set is deliberately the unfiltered one rather than what isToolAvailable
   * left standing this turn: whether a client tool exists should not depend on how big
   * the model happens to be.
   */
  #liveClientTools(nameStyle, builtInToolNames) {
    const live = [];

    for (const [toolName, toolDef] of Object.entries(this.toolCollection?.tools || {})) {
      const unprefixedName = toolName.replace(/^client_/, '');
      const modelFacingName = nameStyle === 'bare' ? unprefixedName : toolName;

      if (builtInToolNames.has(modelFacingName)) {
        logger.warn(`Client tool '${modelFacingName}' collides with a built-in of the same name — withheld from this session`);
        continue;
      }

      live.push({ modelFacingName, unprefixedName, toolDef });
    }

    return live;
  }

  /**
   * Create MCP server from client tool definitions (for SDK mode)
   * Wraps existing tool collection into SDK MCP server format
   * @returns {Object|null} MCP server instance or null if no tools
   */
  async getMcpServer() {
    if (!this.toolCollection) {
      return null;
    }

    const McpServer = await loadMcpServer();
    const server = new McpServer({ name: 'client', version: '1.0.0' });
    let count = 0;

    // Register client tools via MCP's own registerTool (preserves descriptions)
    for (const [toolName, toolDef] of Object.entries(this.toolCollection.tools)) {
      // Remove 'client_' prefix for SDK (SDK will add 'mcp__client__' prefix)
      const unprefixedName = toolName.replace(/^client_/, '');

      // inputSchema is a zod object (built by StructuredOutputToZodConverter);
      // registerTool takes the raw shape. Fall back to an empty shape for a
      // parameterless tool whose schema isn't a zod object.
      // Wrapped rather than registered raw: MCP must be handed its own image
      // content block, not our internal handle block. This is the one route where
      // bytes are attached at the tool-return boundary instead of at
      // request-build time, because the Agent SDK constructs the request itself --
      // so the base64 travels worker -> claude CLI stdio here. Unavoidable on this
      // route.
      // Never deferred behind ToolSearch — see the same flag in BuiltInToolProvider.
      server.registerTool(unprefixedName, {
        description: toolDef.description,
        inputSchema: toolDef.inputSchema?.shape ?? {},
        _meta: { 'anthropic/alwaysLoad': true }
      }, async (args) => toMcpContentResult(await toolDef.handler(args), this.mediaStore));
      count++;
    }

    if (count === 0) {
      return null;
    }

    logger.log(`Creating client MCP server with ${count} tools`);

    return { type: 'sdk', name: 'client', instance: server };
  }

  /**
   * @param {Set<string>} builtInToolNames  What the built-ins are called on this route.
   *        Client tools are registered unprefixed here — the only route where that is
   *        true — so this is the only route where a client tool can collide with a
   *        built-in, and #liveClientTools is where that is settled. Passed in rather
   *        than reached for because this provider knows nothing of the built-in side.
   */
  async getAdkTools(builtInToolNames) {
    if (!this.toolCollection) return [];

    const FunctionTool = await loadFunctionTool();
    const adkTools = [];

    for (const { modelFacingName, toolDef } of this.#liveClientTools('bare', builtInToolNames)) {
      adkTools.push(new FunctionTool({
        name: modelFacingName,
        description: toolDef.description,
        parameters: sanitizeSchemaForGemini(toolDef.inputSchema.toJSONSchema()),
        execute: async (args) => {
          const result = await toolDef.handler(args);
          if (result.isError) throw new Error(toolResultToText(result));

          // ADK has no way to return an image from a tool at all: its
          // buildResponseEvent puts the returned value in functionResponse.response
          // and never populates parts, and LOAD_ARTIFACTS is not exported from the
          // package. So pictures are queued here and pushed onto the request by the
          // orchestrator's beforeModelCallback instead.
          //
          // `.map(b => b.text)` here used to emit the literal string "undefined"
          // for any block that was not text.
          for (const media of mediaBlocksOf(result)) {
            this.pendingAdkMedia.push(media);
          }

          return toolResultToText(result);
        }
      }));
    }

    // Debug for the same reason as the built-in side — this now runs once per pass.
    logger.debug(`Built ${adkTools.length} ADK client tools`);
    return adkTools;
  }
}
