import { timeout } from 'async';
import { z } from 'zod';
import config from '../../config.js';
import { scrubMediaForClient } from './ToolResultFormatter.js';

/**
 * Message Protocol Schemas
 * Defines all WebSocket message types and their validation schemas
 */

// ============================================================================
// SHARED SCHEMAS
// ============================================================================

/**
 * SD-JSON Model Schema
 * Accepts any model structure (CLD or SFD) with minimal validation
 * Uses catchall to allow additional fields defined by LLMWrapper schemas
 */
const SDVariableSchema = z.object({
  name: z.string(),
  type: z.string()
}).catchall(z.any());

const SDRelationshipSchema = z.object({
  from: z.string(),
  to: z.string()
}).catchall(z.any());

const FeedbackLoopSchema = z.object({
  identifier: z.string(),
  name: z.string(),
  links: z.array(z.object({
    from: z.string(),
    to: z.string(),
    polarity: z.string()
  })),
  polarity: z.string(),
  loopset: z.number().optional(),
  'Percent of Model Behavior Explained By Loop': z.array(z.object({
    time: z.number(),
    value: z.number()
  })).optional(),
  loopScore: z.array(z.object({
    time: z.number(),
    value: z.number()
  })).optional()
});

export const FeedbackContentSchema = z.object({
  feedbackLoops: z.array(FeedbackLoopSchema),
  dominantLoopsByPeriod: z.array(z.object({
    dominantLoops: z.array(z.string()),
    startTime: z.number(),
    endTime: z.number()
  })).optional()
}).describe('Feedback loop analysis data');

const RunSchema = z.object({
  id: z.any().describe('Unique identifier for the run'),
  name: z.string().describe('Display name for the run'),
  isExternal: z.boolean().optional().describe('Whether the run is from an external source'),
  variables: z.array(z.string()).optional().describe('Names of variables available in this run')
}).catchall(z.any());

export const GetRunInfoResponseSchema = z.object({
  runs: z.array(RunSchema).describe('List of simulation runs')
}).catchall(z.any());

export const SDModelSchema = z.object({
  variables: z.array(SDVariableSchema).optional(),
  relationships: z.array(SDRelationshipSchema).optional(),
  specs: z.record(z.string(), z.any()).optional(),
  modules: z.array(z.any()).optional(),
  unitWarnings: z.array(z.any()).optional(),
  errors: z.array(z.any()).optional(),
  explanation: z.string().optional(),
  title: z.string().optional()
}).catchall(z.any()).describe('SD-JSON model structure (CLD or SFD)');

export const GetCurrentModelResponseSchema = SDModelSchema;

export const UpdateModelResponseSchema = SDModelSchema;

export const RunModelResponseSchema = z.object({
  runId: z.any().describe('ID of the completed simulation run')
}).catchall(z.any()).describe('Response from the client after running the model');

// ============================================================================
// CLIENT → SERVER MESSAGES
// ============================================================================

// What a client tool says about the binary media it takes and returns.
//
// A sibling of inputSchema rather than a marker inside its properties, for two
// reasons. Zod strips unknown keys, and inputSchema.properties survives that as
// z.record(z.any()) — but the StructuredOutputToZodConverter -> toJSONSchema
// round trip does not preserve an unknown key, so a marker buried in there would
// be unrecoverable by the time the arguments need resolving. And out here it
// costs the converter nothing: a handle parameter is declared as a plain
// {"type":"string"} and reaches the model, MCP and ADK as one automatically.
const ToolMediaContractSchema = z.object({
  inputs: z.array(z.string()).optional().describe(
    'Names of top-level inputSchema properties whose value is an opaque media handle (med_<16 hex>). '
    + 'For each one present in a call, the server attaches the raw bytes to the tool_call_request in '
    + 'the sibling `media` array. The model only ever sees the handle string.'),
  returnsMedia: z.boolean().optional().describe(
    'True if this tool may answer with a `media` array on tool_call_response. Advisory: the server '
    + 'accepts inbound media regardless, since the caps rather than the declaration are what protect '
    + 'it, but declaring it documents the intent.'),
  maxItems: z.number().optional().describe(
    'How many media items this tool expects to return. Clamped to config.mediaMaxItemsPerCall.')
}).describe('Declares which parameters carry binary media handles and whether results may carry media.');

const ToolDefinitionSchema = z.object({
  name: z.string().describe('Unique name identifier for the tool'),
  description: z.string().describe('Human-readable description of what the tool does'),
  timeout: z.number().optional().describe('The number of miliseconds to wait for this tool to execute'),
  inputSchema: z.object({
    type: z.literal('object').describe('Schema type, must be "object"'),
    properties: z.record(z.string(), z.any()).describe('Map of parameter names to their schema definitions'),
    required: z.array(z.string()).optional().describe('Array of required parameter names')
  }).describe('JSON Schema defining the tool input parameters'),
  // Optional, so a client that predates media — or one talking to a server that
  // does — behaves exactly as before.
  media: ToolMediaContractSchema.optional()
});

const HistoricalMessageSchema = z.object({
  type: z.enum(['agent_text', 'visualization', 'agent_complete', 'user_text']).describe('Type of historical message'),
  content: z.string().optional().describe('Text content (for agent_text, agent_complete, and user_text messages)'),
  isThinking: z.boolean().optional().describe('Whether this is thinking text (for agent_text messages)'),
  visualizationId: z.string().optional().describe('Unique ID for the visualization (for visualization messages)'),
  visualizationTitle: z.string().optional().describe('Title of the visualization (for visualization messages)'),
  visualizationDescription: z.string().optional().describe('Description of the visualization (for visualization messages)'),
  svgData: z.string().optional().describe('Image data (for visualization messages)'),
  status: z.string().optional().describe('Status for agent_complete messages')
}).catchall(z.any()).describe('Historical message from a previous session');

export const InitializeSessionMessageSchema = z.object({
  type: z.literal('initialize_session').describe('Message type identifier'),
  sessionId: z.string().optional().describe('Optional session ID to resume an existing session. If not provided, a new session will be created.'),
  authenticationKey: z.string().describe('Authentication key for server access'),
  clientProduct: z.string().describe('Client product name (e.g., "sd-web", "sd-desktop")'),
  clientVersion: z.string().describe('Client version (e.g., "1.0.0")'),
  clientId: z.string().optional().describe('A unique identifier for the end user of this session.  Currently un-used'),
  mode: z.enum(['cld', 'sfd']).describe('Model type: CLD (Causal Loop Diagram) or SFD (Stock Flow Diagram). This cannot be changed during the session.'),
  model: SDModelSchema,
  tools: z.array(ToolDefinitionSchema).describe('Array of client-side tools available for the agent to call'),
  supportsArrays: z.boolean().optional().describe('Whether the client supports arrayed models'),
  supportsModules: z.boolean().optional().describe('Whether the client supports modular models'),
  supportsSubTypes: z.boolean().optional().describe('Whether the client supports queues, conveyors, and ovens'),
  supportsMedia: z.boolean().optional().describe('Whether the client can decode and display binary media (images). Gates the built-in generate_image and view_media tools, which are additionally withheld unless at least one tool in `tools` declares a media contract — a client that can show images but registers nowhere to put them still gets neither tool.'),
  historicalMessages: z.array(HistoricalMessageSchema).optional().describe('Optional array of historical messages from a previous session to provide context'),
  context: z.record(z.string(), z.any()).optional().describe('Optional context information (metadata, user preferences, etc.)'),
  timestamp: z.string().optional().describe('ISO 8601 timestamp of when the message was created')
});

const SelectAgentMessageSchema = z.object({
  type: z.literal('select_agent').describe('Message type identifier'),
  sessionId: z.string().describe('Unique session identifier'),
  agentId: z.string().optional().describe('Agent ID to use (e.g., "merlin", "socrates")'),
  agentConfig: z.string().optional().describe('Custom agent configuration as a markdown string with YAML frontmatter (name, agent_mode, supported_modes, supported_providers, can_write_to_local_sandbox) followed by agent instructions'),
  provider: z.enum(config.agentProviders).optional().default('anthropic').describe('LLM provider to use. anthropic/google reach their vendor APIs directly; ids in config.nativeAgentProviders reach their vendor APIs directly too (e.g. deepseek); every other id is an upstream LLM brand (see config.openRouterAgentProviders) routed via OpenRouter. Ignored if the selected agent supports only one provider.'),
  timestamp: z.string().optional().describe('ISO 8601 timestamp of when the message was created')
}).refine(msg => msg.agentId || msg.agentConfig, {
  message: 'Either agentId or agentConfig must be provided'
});

export const ChatMessageSchema = z.object({
  type: z.literal('chat').describe('Message type identifier'),
  sessionId: z.string().describe('Unique session identifier'),
  message: z.string().describe('The user chat message text to send to the agent'),
  timestamp: z.string().optional().describe('ISO 8601 timestamp of when the message was created')
});

// Pictures a client tool answered with, alongside its JSON result rather than
// inside it. A sidecar keeps `result` meaning exactly what it always meant, so
// every existing client and every existing tool is unaffected — and it means a
// tool returning two images does not have to invent a shape for them.
//
// Field names are lifted verbatim from AddFileMessageSchema so a client reuses
// the encode half of the path that already works.
const ToolCallResponseMediaSchema = z.object({
  mediaId: z.string().optional().describe('Optional client-supplied id; the server assigns one if omitted'),
  name: z.string().describe('File name of the image, including its extension'),
  mimeType: z.string().describe('MIME type of the image (e.g. "image/png")'),
  encoding: z.literal('base64').describe('Encoding of the content field'),
  // Coarse guard against an absurd frame; the decoded byte size is validated
  // against config.mediaMaxItemBytes when the message is handled.
  content: z.string().max(config.websocketMaxPayloadBytes).describe('The image bytes, base64 encoded'),
  description: z.string().optional().describe('Short caption shown to the model alongside the image')
});

const ToolCallResponseMessageSchema = z.object({
  type: z.literal('tool_call_response').describe('Message type identifier'),
  sessionId: z.string().describe('Unique session identifier'),
  callId: z.string().describe('The call ID from the tool_call_request being responded to'),
  result: z.any().describe('The result data from executing the tool, or error message if isError is true'),
  media: z.array(ToolCallResponseMediaSchema).max(config.mediaMaxItemsPerCall).optional()
    .describe('Images this tool is answering with, for the model to actually look at'),
  isError: z.boolean().optional().default(false).describe('Whether the tool execution resulted in an error'),
  timestamp: z.string().optional().describe('ISO 8601 timestamp of when the message was created')
});

export const ModelUpdatedNotificationSchema = z.object({
  type: z.literal('model_updated_notification').describe('Message type identifier'),
  sessionId: z.string().describe('Unique session identifier'),
  model: SDModelSchema,
  changeReason: z.string().describe('Human-readable explanation of why the model was updated'),
  timestamp: z.string().optional().describe('ISO 8601 timestamp of when the message was created')
});

const StopIterationMessageSchema = z.object({
  type: z.literal('stop_iteration').describe('Message type identifier'),
  sessionId: z.string().describe('Unique session identifier'),
  timestamp: z.string().optional().describe('ISO 8601 timestamp of when the message was created')
});

const DisconnectMessageSchema = z.object({
  type: z.literal('disconnect').describe('Message type identifier'),
  sessionId: z.string().describe('Unique session identifier for the session to disconnect')
});

export const AddFileMessageSchema = z.object({
  type: z.literal('add_file').describe('Message type identifier'),
  sessionId: z.string().describe('Unique session identifier'),
  fileId: z.string().optional().describe('Optional client-provided file id; the server assigns one if omitted'),
  name: z.string().describe('Display name of the file, including its extension (used as an extraction hint)'),
  mimeType: z.string().describe('MIME type of the file (e.g. "application/pdf", "text/markdown")'),
  encoding: z.enum(['utf8', 'base64']).describe('Encoding of the content field: "utf8" for plain text, "base64" for binary files'),
  // Coarse guard against absurd frames; the decoded byte size is validated
  // against config.ragMaxFileBytes when the message is handled.
  content: z.string().max(config.websocketMaxPayloadBytes).describe('The file content, encoded per the encoding field'),
  timestamp: z.string().optional().describe('ISO 8601 timestamp of when the message was created')
});

const RemoveFileMessageSchema = z.object({
  type: z.literal('remove_file').describe('Message type identifier'),
  sessionId: z.string().describe('Unique session identifier'),
  fileId: z.string().describe('Id of the attached file to remove'),
  timestamp: z.string().optional().describe('ISO 8601 timestamp of when the message was created')
});

const ClientMessageSchema = z.discriminatedUnion('type', [
  InitializeSessionMessageSchema,
  SelectAgentMessageSchema,
  ChatMessageSchema,
  ToolCallResponseMessageSchema,
  ModelUpdatedNotificationSchema,
  StopIterationMessageSchema,
  AddFileMessageSchema,
  RemoveFileMessageSchema,
  DisconnectMessageSchema
]);

// ============================================================================
// MESSAGE VALIDATION HELPERS
// ============================================================================

export function validateClientMessage(message) {
  try {
    return {
      success: true,
      data: ClientMessageSchema.parse(message)
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      details: error.errors
    };
  }
}

// ============================================================================
// MESSAGE BUILDERS
// ============================================================================

export function createSessionCreatedMessage(sessionId) {
  return {
    type: 'session_created',
    sessionId,
    timestamp: new Date().toISOString()
  };
}

export function createSessionReadyMessage(sessionId, availableAgents, defaults) {
  return {
    type: 'session_ready',
    sessionId,
    availableAgents,
    defaults,
    timestamp: new Date().toISOString()
  };
}

export function createAgentSelectedMessage(sessionId, agentId, agentName, supportedProviders, currentProvider) {
  return {
    type: 'agent_selected',
    sessionId,
    agentId,
    agentName,
    supportedProviders,
    currentProvider,
    timestamp: new Date().toISOString()
  };
}

export function createAgentTextMessage(sessionId, content, isThinking = false) {
  return {
    type: 'agent_text',
    sessionId,
    content,
    isThinking,
    timestamp: new Date().toISOString()
  };
}

export function createToolCallNotificationMessage(sessionId, callId, toolName, args, isBuiltIn) {
  return {
    type: 'tool_call_notification',
    sessionId,
    callId,
    toolName,
    arguments: args,
    isBuiltIn,
    timestamp: new Date().toISOString()
  };
}

// The scrub is here rather than at the eight call sites on purpose: this function
// forwards tool-result content verbatim, including raw Agent-SDK blocks from the
// MCP route, so once a tool answers with an image this is where its base64 would
// otherwise travel back down the WebSocket in the tool log. Guarding the builder
// covers every current caller and every future one. The client still gets enough
// to label the entry — handle, type and size — just not the bytes.
export function createToolCallCompletedMessage(sessionId, callId, toolName, result, isError = false, responseType = null) {
  return {
    type: 'tool_call_completed',
    sessionId,
    callId,
    toolName,
    result: scrubMediaForClient(result),
    isError,
    ...(responseType && { responseType }),
    timestamp: new Date().toISOString()
  };
}

export function createAgentCompleteMessage(sessionId, status, finalMessage) {
  return {
    type: 'agent_complete',
    sessionId,
    finalMessage,
    status,
    timestamp: new Date().toISOString()
  };
}

export function createErrorMessage(sessionId, error, errorCode) {
  return {
    type: 'error',
    sessionId,
    error: typeof error === 'string' ? error : error.message,
    errorCode,
    timestamp: new Date().toISOString()
  };
}

export function createFeedbackRequestMessage(sessionId, requestId, runIds) {
  return {
    type: 'feedback_request',
    sessionId,
    requestId,
    runIds,
    timestamp: new Date().toISOString()
  };
}

export function createGetCurrentModelMessage(sessionId, requestId) {
  return {
    type: 'get_current_model',
    sessionId,
    requestId,
    timestamp: new Date().toISOString()
  };
}

export function createUpdateModelMessage(sessionId, requestId, modelData) {
  return {
    type: 'update_model',
    sessionId,
    requestId,
    modelData,
    timestamp: new Date().toISOString()
  };
}

export function createRunModelMessage(sessionId, requestId) {
  return {
    type: 'run_model',
    sessionId,
    requestId,
    timestamp: new Date().toISOString()
  };
}

export function createGetRunInfoMessage(sessionId, requestId) {
  return {
    type: 'get_run_info',
    sessionId,
    requestId,
    timestamp: new Date().toISOString()
  };
}

export function createGetVariableDataMessage(sessionId, requestId, variableNames, runIds, detailed) {
  return {
    type: 'get_variable_data',
    sessionId,
    requestId,
    variableNames,
    runIds,
    detailed,
    timestamp: new Date().toISOString()
  };
}

// `files` is the full snapshot of currently attached files so the client always
// has authoritative state. Each entry: {fileId, name, mimeType, bytes,
// tokenCount, tier, chunkCount, status}.
export function createFileAddedMessage(sessionId, files) {
  return {
    type: 'file_added',
    sessionId,
    files,
    timestamp: new Date().toISOString()
  };
}

export function createFileRemovedMessage(sessionId, files) {
  return {
    type: 'file_removed',
    sessionId,
    files,
    timestamp: new Date().toISOString()
  };
}
