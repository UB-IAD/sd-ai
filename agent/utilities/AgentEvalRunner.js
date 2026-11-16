import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { AgentOrchestrator } from '../AgentOrchestrator.js';
import { SessionManager } from './SessionManager.js';
import { RagStore, createGeminiEmbedder } from './RagStore.js';
import SDJsonToXMILE from '../../utilities/SDJsonToXMILE.js';
import PySDSimulator from '../../evals/utilities/simulator/PySDSimulator.js';
import { checkUnits, INCONSISTENCY_KINDS } from '../../evals/utilities/units/unitChecker.js';
import logger from '../../utilities/logger.js';
import utils from '../../utilities/utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_CONFIG_DIR = join(__dirname, '../config');

const EVAL_MODE_INSTRUCTION = `
## EVAL MODE: No User Present
You are running in automated evaluation mode. Nothing you say can be answered before you
finish, so there is no one to wait for. You MUST:
- Never block or stop to wait for input, clarification, or confirmation
- Never end your turn by asking what to do next \u2014 decide, and do it
- Make your best judgment and proceed autonomously
- Iterate until the task is fully complete
- If you are uncertain about a requirement, make a reasonable assumption and continue

This is a rule about waiting, not about rhetoric. When the task itself calls for putting
questions to a learner \u2014 guiding questions, Socratic prompts, questions meant to make the
reader reason \u2014 write them, and leave them genuinely open instead of answering each one
yourself in the following sentence.
`;

/**
 * The eval-mode instruction for a conversation: a user is present and will answer, one message
 * at a time. Used instead of EVAL_MODE_INSTRUCTION when a test scripts follow-up turns, because
 * an agent told that nobody can answer it will never ask the questions the test is measuring.
 */
const CONVERSATION_MODE_INSTRUCTION = `
## EVAL MODE: Conversation
A user is present and will reply to each of your messages. When you need information from them,
ask, and end your turn so they can answer. Do not invent answers to your own questions. Do not
wait for confirmation of things you can decide yourself.
`;

/**
 * Sent as a second turn when a model-building run ends without the agent ever writing a
 * model. Answering in prose and never calling update_model scores as an empty model, which
 * measures nothing about the modeling. A real user would say exactly this and the agent
 * would recover, so the harness says it once too rather than banking the zero.
 */
const MODEL_NOT_WRITTEN_CORRECTION = `Your answer never reached the model. The diagram is still empty \u2014 no variables, no relationships.

Prose describing the model is not the model. Write it now: call get_current_model, edit the session model file so it contains every variable and relationship you just described, then call update_model to push it. Do not restate the explanation; produce the model.`;

/**
 * Client-side model validation, of the kind the real client performs before it echoes a
 * model back.
 *
 * The eval harness stands in for Stella, and Stella does not accept a model silently: it
 * reports undefined references and duplicate names, and SessionManager.updateClientModel
 * already knows how to surface whatever comes back in `errors`. Without this the agent gets
 * an unconditional success for a model whose relationships name variables that do not
 * exist, and it has no way to find out. Structural checks only \u2014 equations are not parsed,
 * because a false "undefined identifier" on a builtin would send the agent chasing ghosts.
 *
 * @param {Object} model An sd-json model
 * @returns {Array<String>} Human-readable errors, empty when the model is clean
 */
export function validateModelLikeClient(model) {
  const variables = model?.variables || [];
  const relationships = model?.relationships || [];
  const errors = [];

  const byExactName = new Set(variables.map((v) => { return v.name }));
  const byFoldedName = new Map();
  for (const variable of variables) {
    const folded = utils.caseFold(variable.name);
    if (!byFoldedName.has(folded)) byFoldedName.set(folded, []);
    byFoldedName.get(folded).push(variable.name);
  }

  // A name that resolves only after folding is the drift this check exists to catch: the
  // agent wrote "Colonial Identity" in variables and "Colonial_Identity" in relationships,
  // and every downstream consumer that compares names literally sees two variables.
  const describeReference = function(reference, usedBy) {
    if (byExactName.has(reference)) return null;
    const folded = byFoldedName.get(utils.caseFold(reference));
    if (folded) {
      return `${usedBy} refers to "${reference}", but the variable is named "${folded[0]}". Names must match exactly \u2014 spaces and underscores are not interchangeable here.`;
    }
    return `${usedBy} refers to "${reference}", which is not a variable in this model.`;
  };

  for (const names of byFoldedName.values()) {
    if (names.length > 1) {
      errors.push(`Duplicate variable names: ${names.map((n) => { return `"${n}"` }).join(', ')} differ only by spacing, underscores or case. Each variable must have one name.`);
    }
  }

  for (const variable of variables) {
    for (const [kind, flows] of [['inflow', variable.inflows], ['outflow', variable.outflows]]) {
      for (const flow of (flows || [])) {
        const problem = describeReference(flow, `Stock "${variable.name}" lists ${kind}`);
        if (problem) errors.push(problem);
      }
    }
  }

  // Relationship endpoints are only checkable against a declared variable list. A model
  // that carries relationships and no variables is a shape some engines legitimately
  // return, and flagging every endpoint there would be noise, not a finding.
  if (variables.length > 0) {
    for (const relationship of relationships) {
      for (const [end, name] of [['from', relationship.from], ['to', relationship.to]]) {
        const problem = describeReference(name, `Relationship ${end}`);
        if (problem) errors.push(problem);
      }
    }
  }

  return [...new Set(errors)];
}

/**
 * Whether a model carries nothing at all. This is what an agent that answered in prose and
 * never called update_model leaves behind, and it is indistinguishable from the empty model
 * the session started with.
 * @param {Object} model An sd-json model
 * @returns {boolean} True when the model holds no variables and no relationships
 */
export function modelIsEmpty(model) {
  return (model?.variables || []).length === 0 && (model?.relationships || []).length === 0;
}

/**
 * Condense a simulator failure into something an agent can act on.
 *
 * PySD reports an XMILE parse failure by printing the entire parse tree, which runs to tens
 * of thousands of characters and buries the one line that matters. The head of the message
 * carries the offending expression; the tree does not add to it.
 * @param {Error} err The error thrown by the simulator
 * @returns {String} A single actionable message
 */
export function summarizeSimulationError(err) {
  const raw = (err?.message || String(err)).replace(/\s+/g, ' ').trim();
  const parseTreeAt = raw.indexOf('Parse tree:');
  const summary = parseTreeAt === -1 ? raw : raw.slice(0, parseTreeAt).trim();
  return `The model failed to simulate: ${summary.slice(0, 600)}`;
}

/**
 * Find all simple cycles in a directed graph using DFS.
 * Each cycle is found exactly once (starting from its lexicographically-smallest node).
 */
export function findFeedbackLoops(relationships) {
  const adj = {};
  for (const rel of (relationships || [])) {
    if (!adj[rel.from]) adj[rel.from] = [];
    adj[rel.from].push({ to: rel.to, polarity: rel.polarity || '+' });
  }

  const allNodes = [...new Set([
    ...Object.keys(adj),
    ...(relationships || []).map(r => r.to)
  ])].sort();

  const nodeIndex = {};
  allNodes.forEach((n, i) => { nodeIndex[n] = i; });

  const loops = [];
  let loopCounter = 0;

  for (let startIdx = 0; startIdx < allNodes.length; startIdx++) {
    const startNode = allNodes[startIdx];
    const path = [startNode];
    const pathPolarities = [];
    const inPath = new Set([startNode]);

    function dfs(node) {
      for (const { to, polarity } of (adj[node] || [])) {
        if (to === startNode && path.length > 1) {
          // Found a cycle back to start — record it
          const cyclePolarities = [...pathPolarities, polarity];
          const negativeCount = cyclePolarities.filter(p => p === '-').length;
          const loopPolarity = negativeCount % 2 === 0 ? '+' : '-';
          loopCounter++;
          const links = [];
          for (let i = 0; i < path.length; i++) {
            links.push({
              from: path[i],
              to: i + 1 < path.length ? path[i + 1] : startNode,
              polarity: cyclePolarities[i]
            });
          }
          loops.push({
            identifier: `L${loopCounter}`,
            name: `Loop ${loopCounter}`,
            links,
            polarity: loopPolarity
          });
        } else if (!inPath.has(to) && nodeIndex[to] > startIdx) {
          inPath.add(to);
          path.push(to);
          pathPolarities.push(polarity);
          dfs(to);
          path.pop();
          pathPolarities.pop();
          inPath.delete(to);
        }
      }
    }

    dfs(startNode);
  }

  return loops;
}

/**
 * Patch a markdown string's frontmatter.
 * Replaces max_iterations and optionally agent_mode, then appends eval instructions: the
 * no-user-present instruction, or, when `userPresent`, the conversation instruction.
 */
export function patchAgentConfig(markdownContent, agentMode, userPresent) {
  // Patch max_iterations to effectively unlimited
  let patched = markdownContent.replace(
    /^max_iterations:\s*\d+/m,
    'max_iterations: 9999'
  );

  // Optionally override agent_mode
  if (agentMode) {
    patched = patched.replace(
      /^agent_mode:\s*.+/m,
      `agent_mode: ${agentMode}`
    );
  }

  // Append eval-mode instruction to the body (after closing ---)
  const frontmatterEnd = patched.indexOf('\n---\n');
  if (frontmatterEnd !== -1) {
    const insertAt = frontmatterEnd + 5; // after '\n---\n'
    patched = patched.slice(0, insertAt) + (userPresent ? CONVERSATION_MODE_INSTRUCTION : EVAL_MODE_INSTRUCTION) + patched.slice(insertAt);
  } else {
    patched += userPresent ? CONVERSATION_MODE_INSTRUCTION : EVAL_MODE_INSTRUCTION;
  }

  return patched;
}

/**
 * Resolve a pending request stored in a Map (pendingModelRequests or pendingFeedbackRequests).
 * Clears the timeout and removes the entry before resolving/rejecting.
 */
function resolvePending(map, requestId, value) {
  const pending = map?.get(requestId);
  if (pending) {
    clearTimeout(pending.timeout);
    map.delete(requestId);
    pending.resolve(value);
  }
}

function rejectPending(map, requestId, error) {
  const pending = map?.get(requestId);
  if (pending) {
    clearTimeout(pending.timeout);
    map.delete(requestId);
    pending.reject(error);
  }
}

/**
 * The MIME type an attachment is uploaded with, from its extension. XMILE and sd-json are text;
 * anything unknown goes up as plain text, which RagStore reads as UTF-8.
 * @param {string} fileName The attachment's file name
 * @returns {string} A MIME type
 */
export function attachmentMimeType(fileName) {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'pdf': return 'application/pdf';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'json': return 'application/json';
    case 'stmx':
    case 'xmile':
    case 'itmx':
    case 'xml': return 'application/xml';
    case 'csv': return 'text/csv';
    default: return 'text/plain';
  }
}

/**
 * Attach files to an eval session the way an upload does: the bytes are written to
 * <tempDir>/rag/<fileId>/original.bin (the main process's half of an upload) and RagStore
 * processes them (the worker's half), so search_documents, the "Attached Files" section of the
 * system prompt and read_file behave exactly as they do for a user's upload.
 *
 * @param {SessionManager} sessionManager The eval session's manager
 * @param {string} sessionId The eval session
 * @param {Array<{path: string, name?: string}>} attachments Files to attach, by absolute path
 * @param {Object} embedder The embedder RagStore uses for large files
 * @returns {Promise<Array<Object>>} The processed files' metadata
 */
export async function attachFiles(sessionManager, sessionId, attachments, embedder) {
  const ragStore = new RagStore(embedder);
  sessionManager.ragStore = ragStore;
  const tempDir = sessionManager.getSessionTempDir(sessionId);
  const processed = [];
  for (const [index, attachment] of attachments.entries()) {
    const name = attachment.name || basename(attachment.path);
    const fileId = `eval-file-${index + 1}`;
    const dir = join(tempDir, 'rag', fileId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'original.bin'), readFileSync(attachment.path));
    processed.push(await ragStore.processFile(sessionManager, sessionId, {
      fileId,
      name,
      mimeType: attachmentMimeType(name),
      addedAt: new Date().toISOString()
    }));
  }
  return processed;
}

/**
 * Run the agent to completion for eval purposes.
 *
 * @param {string} prompt - The user prompt
 * @param {Object} currentModel - The current SD model (sdjson)
 * @param {Object} parameters - Engine parameters including agentName, agentMode, provider,
 *                              intelligence, toolModels, mode, problemStatement,
 *                              backgroundKnowledge, feedbackContent
 * @returns {{ lastModel: Object|null, explanation: string, toolLog: Array<Object>, transcript?: Array<Object>, snapshots?: Array<Object> }}
 *   `transcript` and `snapshots` are returned for conversations (`turns` or `userScript`).
 */
export async function runAgent(prompt, currentModel, parameters) {
  const {
    agentName = 'merlin',
    agentMode,
    provider = 'anthropic',
    intelligence,
    toolModels,
    mode = 'sfd',
    problemStatement,
    backgroundKnowledge,
    feedbackContent,
    attachments,
    unitChecking,
    turns,
    userScript,
    analysisTools,
    calibrationData
  } = parameters;

  // A conversation: fixed follow-up messages, or a scripted user who answers the agent's questions
  // from a fact bank. Either way the agent is told a user is present.
  const isConversation = (Array.isArray(turns) && turns.length > 0) || Boolean(userScript);
  // A bad script is rejected before any agent turn is paid for.
  if (userScript) {
    for (const field of ['maxQuestionTurns', 'maxFactsPerTurn']) {
      if (!Number.isInteger(userScript[field]) || userScript[field] < 1) {
        throw new Error(`userScript.${field} must be a positive integer; got ${userScript[field]}`);
      }
    }
  }

  // Derive base session mode (strip -discuss suffix)
  const baseMode = mode.replace(/-discuss$/, '');

  // 1. Load and patch agent config
  const configPath = join(AGENT_CONFIG_DIR, `${agentName}.md`);
  let markdownContent;
  try {
    markdownContent = readFileSync(configPath, 'utf-8');
  } catch (err) {
    throw new Error(`Agent config not found: ${configPath}`);
  }
  markdownContent = patchAgentConfig(markdownContent, agentMode, isConversation);

  // 2. Set up session
  const sessionManager = new SessionManager({ disableCleanup: true });
  const sessionId = sessionManager.createSession({ readyState: 1, send: () => {} });
  // With `analysisTools`, the agent also gets the evals' scenario, sensitivity, calibration and
  // optimization tools as client tools (evals/utilities/analysisTools.js).
  const { ANALYSIS_TOOL_DEFINITIONS, runAnalysisTool } = analysisTools ? await import('../../evals/utilities/analysisTools.js') : {};
  sessionManager.initializeSession(
    sessionId,
    baseMode,
    currentModel || { variables: [], relationships: [] },
    analysisTools ? ANALYSIS_TOOL_DEFINITIONS : [],
    {
      supportsArrays: true,
      supportsModules: true,
      supportsSubTypes: false
    },
    'eval-client'
  );

  if (Array.isArray(attachments) && attachments.length > 0) {
    await attachFiles(sessionManager, sessionId, attachments, createGeminiEmbedder(sessionManager, sessionId, 'eval-client'));
  }

  // 3. In-memory run storage
  const storedRuns = new Map();
  const failedRuns = new Map();
  let runCounter = 0;

  const textParts = [];

  // Every tool the agent called, in order, with its arguments and whether it errored. Graders
  // that check process (did it read the uploaded file, did it run the model after a warning)
  // read this rather than the prose, which can claim a step that never happened.
  const toolLog = [];
  const toolLogByCallId = new Map();

  // A run can take more than one turn (see MODEL_NOT_WRITTEN_CORRECTION), so completion is
  // armed per turn rather than once. turnInFlight gates the resolver: some orchestrator
  // error paths send agent_complete more than once, and a straggler from a finished turn
  // must not end the next one before it has started working.
  let resolveComplete;
  let rejectComplete;
  let completionPromise;
  let turnInFlight = false;
  let turnNumber = 0;
  const armCompletion = function() {
    turnInFlight = true;
    completionPromise = new Promise((res, rej) => {
      resolveComplete = (value) => { if (turnInFlight) { turnInFlight = false; res(value); } };
      rejectComplete = (error) => { if (turnInFlight) { turnInFlight = false; rej(error); } };
    });
  };

  // A model echoed back to the agent carries the client's verdict on it, the same way a
  // real client's does. Recomputed on every echo so a stale `errors` array read back off
  // the session model file is replaced rather than repeated.
  //
  // With `unitChecking` on, the echo also carries the unit checker's verdict as `unitWarnings`,
  // the field Stella fills from its own unit checker and the session presents to the agent as
  // authoritative. Off by default, so categories that predate it run in the environment their
  // results were measured in.
  const withClientErrors = function(model) {
    if (!model) return model;
    const errors = validateModelLikeClient(model);
    const { errors: _discarded, ...rest } = model;
    const echoed = errors.length ? { ...rest, errors } : rest;
    if (unitChecking) {
      // Only real inconsistencies: "could not read this equation" is a limit of the checker, and
      // presented as an authoritative unit warning it would send the agent chasing a ghost.
      try {
        echoed.unitWarnings = checkUnits(model).filter((w) => INCONSISTENCY_KINDS.has(w.kind)).map((w) => w.message);
      } catch (err) {
        logger.warn(`[AgentEvalRunner] Unit check failed: ${err.message}`);
      }
    }
    return echoed;
  };

  // 4. Mock sendToClient
  const sendToClient = async (message) => {
    const session = sessionManager.getSession(sessionId);

    switch (message.type) {
      case 'get_current_model': {
        // setImmediate: sendToClient is awaited BEFORE the tool stores its resolver in the
        // pending Map, so we must defer resolution until after the current call stack unwinds.
        // Read from session (not the closure) so updates pushed via update_model are visible.
        const gcmReqId = message.requestId;
        setImmediate(() => {
          const latestModel = sessionManager.getClientModel(sessionId) || { variables: [], relationships: [] };
          resolvePending(sessionManager.getSession(sessionId)?.pendingModelRequests, gcmReqId, withClientErrors(latestModel));
        });
        break;
      }

      case 'update_model': {
        const modelData = message.modelData;
        const umReqId = message.requestId;
        setImmediate(() => resolvePending(sessionManager.getSession(sessionId)?.pendingModelRequests, umReqId, withClientErrors(modelData)));
        break;
      }

      case 'run_model': {
        const model = sessionManager.getClientModel(sessionId);
        let runId = `eval-run-${++runCounter}`;
        try {
          const xmileContent = SDJsonToXMILE(model, {
            modelName: 'eval-model',
            vendor: 'sd-ai-evals',
            product: 'sd-ai-evals',
            version: '1.0'
          });
          
          const varNames = (model?.variables || [])
            .map(v => v.name?.replace(/\s+/g, '_'))
            .filter(Boolean);

          if (varNames.length > 0) {
            const sim = new PySDSimulator(xmileContent);
            const results = await sim.simulate(varNames);
            storedRuns.set(runId, results);
          } else {
            storedRuns.set(runId, {});
          }
        } catch (err) {
          logger.warn(`[AgentEvalRunner] Simulation failed for run ${runId}: ${err.message}`);
          runId = `eval-run-failed-${runCounter}`;
          storedRuns.set(runId, {});
          // A real client reports why a run failed; swallowing it and handing back a runId
          // for an empty run tells the agent the model simulates when it does not, and it
          // cannot fix an error it is never shown. RunModelResponseSchema is a catchall, so
          // the extra field reaches the tool result untouched.
          failedRuns.set(runId, summarizeSimulationError(err));
        }
        // run_model awaits simulation above, so sendToClient returns after the async work.
        // The tool creates its promise immediately after sendToClient returns, so
        // setImmediate fires after the resolver is in the Map.
        const rmRunId = runId;
        const rmReqId = message.requestId;
        const rmError = failedRuns.get(rmRunId);
        setImmediate(() => resolvePending(
          sessionManager.getSession(sessionId)?.pendingModelRequests,
          rmReqId,
          rmError ? { runId: rmRunId, error: rmError, simulated: false } : { runId: rmRunId, simulated: true }
        ));
        break;
      }

      case 'get_run_info': {
        const runs = Array.from(storedRuns.entries()).map(([id, data]) => ({
          id,
          name: id,
          variables: Object.keys(data).filter(k => k !== 'time')
        }));
        const griReqId = message.requestId;
        setImmediate(() => resolvePending(sessionManager.getSession(sessionId)?.pendingModelRequests, griReqId, { runs }));
        break;
      }

      case 'get_variable_data': {
        const { variableNames = [], runIds = [], detailed = false } = message;
        const targetPoints = detailed ? 200 : 50;
        const result = {};
        for (const runId of runIds) {
          // A failed run holds no data. Returning it as an empty object reads as "this run
          // has no values for those variables", which is a different and much less
          // actionable statement than "this run never happened, and here is why".
          if (failedRuns.has(runId)) {
            result[runId] = { error: failedRuns.get(runId) };
            continue;
          }
          const runData = storedRuns.get(runId);
          if (runData) {
            result[runId] = {};
            const timeArr = runData.time;
            if (timeArr && timeArr.length > targetPoints) {
              const indices = Array.from({ length: targetPoints }, (_, i) =>
                Math.round(i * (timeArr.length - 1) / (targetPoints - 1))
              );
              result[runId].time = indices.map(i => timeArr[i]);
              for (const varName of variableNames) {
                const arr = runData[varName];
                if (arr !== undefined) result[runId][varName] = indices.map(i => arr[i]);
              }
            } else {
              if (timeArr) result[runId].time = timeArr;
              for (const varName of variableNames) {
                if (runData[varName] !== undefined) result[runId][varName] = runData[varName];
              }
            }
          }
        }
        const gvdReqId = message.requestId;
        setImmediate(() => resolvePending(sessionManager.getSession(sessionId)?.pendingModelRequests, gvdReqId, result));
        break;
      }

      case 'feedback_request': {
        let resolvedFeedbackContent;
        if (feedbackContent) {
          resolvedFeedbackContent = feedbackContent;
        } else {
          const model = sessionManager.getClientModel(sessionId);
          resolvedFeedbackContent = { feedbackLoops: findFeedbackLoops(model?.relationships) };
        }
        const frReqId = message.requestId;
        const frPayload = { feedbackContent: resolvedFeedbackContent, runIds: message.runIds };
        setImmediate(() => resolvePending(sessionManager.getSession(sessionId)?.pendingFeedbackRequests, frReqId, frPayload));
        break;
      }

      case 'agent_text': {
        // isProgress marks the harness's own "Running model simulation..." notices rather
        // than anything the agent said. Only some provider loops emit them, so leaving them
        // in would make an engine's graded answer depend on which loop ran it.
        if (!message.isThinking && !message.isProgress && message.content) {
          textParts.push(message.content);
        }
        break;
      }

      case 'tool_call_request': {
        // Only the analysis tools are client tools in eval runs; anything else is answered with an
        // error rather than left to time out.
        const requestCallId = message.callId;
        let result;
        let isError = false;
        try {
          result = runAnalysisTool
            ? await runAnalysisTool(message.toolName, message.arguments || {}, sessionManager.getClientModel(sessionId), calibrationData || null)
            : { error: `No client tool ${message.toolName} in this eval run.` };
          if (result?.error) isError = true;
        } catch (err) {
          result = { error: err.message };
          isError = true;
        }
        setImmediate(() => sessionManager.resolvePendingToolCall(sessionId, requestCallId, isError ? result.error : result, isError));
        break;
      }

      case 'tool_call_notification': {
        const entry = { toolName: message.toolName, arguments: message.arguments ?? null, isBuiltIn: message.isBuiltIn ?? null, isError: null, turn: turnNumber };
        toolLog.push(entry);
        if (message.callId) toolLogByCallId.set(message.callId, entry);
        break;
      }

      case 'tool_call_completed': {
        const entry = toolLogByCallId.get(message.callId);
        if (entry) entry.isError = Boolean(message.isError);
        break;
      }

      case 'agent_complete': {
        resolveComplete(message.status);
        break;
      }

      case 'error': {
        rejectComplete(new Error(message.error || 'Agent error'));
        break;
      }

      default:
        break;
    }
  };

  // 5. Compose user message (problemStatement → backgroundKnowledge → prompt)
  const parts = [];
  if (problemStatement) {
    parts.push(
      `The user has stated that they are conducting this modeling exercise to understand the following problem better.\n\n${problemStatement}`
    );
  }
  if (backgroundKnowledge) {
    parts.push(
      `Please be sure to consider the following critically important background information when you give your answer. You MUST use ONLY this background information to answer — do not draw on your own training knowledge or make assumptions beyond what is explicitly stated here. You MUST use the exact variable names as written — do not rename, paraphrase, or substitute any variable name that is explicitly referenced in this information.

NAMING RULE — the term goes in the NAME, not only the units. When the background information names the thing being accumulated, counted or measured — especially an unusual, invented or domain-specific word — that word MUST appear in the NAME of the variable representing it. Recording the term only as the variable's unit and giving the variable a generic name instead is incorrect. For example, if the background says an inventory holds twenty widgets, the stock must be named for the widgets (\"widgets\", or \"widget inventory\") and NOT named \"Inventory\" with units of widgets. Prefer the background's own distinctive wording over a generic label every time; units are additional to that name, never a substitute for it.\n\n${backgroundKnowledge}`
    );
  }
  parts.push(prompt);
  const userMessage = parts.join('\n\n');

  // 6. Run the agent
  // `intelligence` picks the conversation model off the provider's ladder; `toolModels`
  // pins what the engine tools run on. An experiment sets both so a result row is
  // attributable to one model rather than to a Claude agent calling Gemini engines,
  // which is what the shared config.agentToolModels default lane would give it.
  const orchestrator = new AgentOrchestrator(
    sessionManager,
    sessionId,
    sendToClient,
    { markdownContent },
    provider,
    intelligence ?? null,
    toolModels
  );

  const runTurn = async function(message) {
    turnNumber++;
    armCompletion();
    const finished = completionPromise;
    await Promise.all([orchestrator.startConversation(message), finished]);
  };

  // The whole exchange, turn by turn, with the model as it stood after each agent turn.
  const transcript = [];
  const snapshots = [];
  const converse = async function(message, synthetic) {
    transcript.push({ role: 'user', turn: turnNumber + 1, text: message, ...(synthetic ? { synthetic } : {}) });
    const before = textParts.length;
    await runTurn(message);
    const reply = textParts.slice(before).join('\n\n');
    transcript.push({ role: 'agent', turn: turnNumber, text: reply });
    snapshots.push({ turn: turnNumber, model: structuredClone(sessionManager.getClientModel(sessionId) || { variables: [], relationships: [] }) });
    return reply;
  };

  let reply = await converse(userMessage, null);

  if (Array.isArray(turns)) {
    for (const turn of turns) reply = await converse(turn, null);
  }

  // A scripted user: after each agent turn, the user answers whatever the agent asked about from
  // its fact bank, and nothing else. The router decides which facts were asked for; the replies
  // are fixed sentences, so the same question always gets the same answer.
  if (userScript) {
    const { answerFromScript } = await import('../../evals/utilities/scriptedUser.js');
    const released = new Set();
    for (let i = 0; i < userScript.maxQuestionTurns; i++) {
      const answer = await answerFromScript(userScript, reply, released);
      if (answer.done) break;
      answer.factIds.forEach((id) => released.add(id));
      transcript[transcript.length - 1].factsReleasedAfter = answer.factIds;
      reply = await converse(answer.text, null);
    }
    if (userScript.closingMessage) reply = await converse(userScript.closingMessage, null);
  }

  // A build run that produced no model has not been measured, it has been forfeited. Say so
  // once and let the agent write what it already worked out; a second forfeit is a real
  // result and is scored as one.
  const buildsAModel = !mode.endsWith('-discuss');
  if (buildsAModel && modelIsEmpty(sessionManager.getClientModel(sessionId))) {
    logger.warn(`[AgentEvalRunner] Agent finished without writing a model; sending one correction.`);
    // Tagged, so a grader counting the user's turns does not count the harness's own nudge.
    await converse(MODEL_NOT_WRITTEN_CORRECTION, 'modelNotWritten');
  }

  return {
    lastModel: sessionManager.getClientModel(sessionId),
    explanation: textParts.join('\n\n'),
    toolLog,
    ...(isConversation ? { transcript, snapshots } : {})
  };
}
