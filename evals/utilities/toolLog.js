/**
 * Process checks over an agent's tool log.
 *
 * AgentEvalRunner records every tool call an agent makes, in order (see its `toolLog`). Some things
 * a category wants to know are about process, not the final model: did the agent run the model
 * after its last change, did it read the uploaded file, did it run an extreme-conditions test.
 * These helpers answer such questions from the log, so no category has to trust the agent's own
 * account of what it did.
 *
 * Tool names arrive with route-specific prefixes (mcp__server__run_model on the SDK route), so
 * names are compared by their last segment.
 *
 * @module utilities/toolLog
 */

/**
 * The tool name without any route prefix: mcp__server__ on the SDK route, and client_ for tools the
 * client provides (the session registers those as client_<name>).
 */
export const baseToolName = (name) => String(name || '').split('__').pop().toLowerCase().replace(/^client_/, '');

/** Tools that change the model. */
export const MODEL_CHANGING_TOOLS = new Set([
    'update_model', 'edit_variables', 'edit_relationships', 'edit_specs', 'edit_modules',
    'generate_quantitative_model', 'generate_qualitative_model'
]);

/** File tools, which change the model only when they write the session's model file. */
const FILE_TOOLS = new Set(['write_file', 'edit_file', 'write', 'edit']);

/** Whether a log entry changed the model. */
export const changesModel = function(entry) {
    const name = baseToolName(entry.toolName);
    if (MODEL_CHANGING_TOOLS.has(name)) return true;
    return FILE_TOOLS.has(name) && /\.sdjson|model\.json/i.test(JSON.stringify(entry.arguments ?? ''));
};

/**
 * The index of the last call satisfying a predicate, or -1.
 * @param {Array<Object>} log The tool log
 * @param {function(Object): boolean} predicate Test on a log entry
 * @returns {number} The index
 */
export const lastIndexOf = function(log, predicate) {
    for (let i = (log || []).length - 1; i >= 0; i--) if (predicate(log[i])) return i;
    return -1;
};

/**
 * Whether the agent ran the model after its last change to it.
 * @param {Array<Object>} log The tool log
 * @returns {boolean} True when the agent changed the model at least once and a run_model call follows
 *   its last change
 */
export const ranAfterLastChange = function(log) {
    const lastChange = lastIndexOf(log, changesModel);
    const lastRun = lastIndexOf(log, (e) => baseToolName(e.toolName) === 'run_model');
    return lastChange !== -1 && lastRun > lastChange;
};

/**
 * The calls to a tool, by base name.
 * @param {Array<Object>} log The tool log
 * @param {string} name The base tool name
 * @returns {Array<Object>} The matching entries
 */
export const callsTo = function(log, name) {
    return (log || []).filter((e) => baseToolName(e.toolName) === name);
};

/**
 * Whether the log shows an uploaded file was read: a document search (it reaches only uploads), or
 * a file read — the agent's read_file, or the SDK's native Read — whose arguments name an upload
 * (uploads live under the session's rag/<fileId>/ directory, named eval-file-N). Reading some other
 * file does not count.
 * @param {Array<Object>} log The tool log
 * @returns {boolean}
 */
export const readUpload = function(log) {
    return Array.isArray(log) && log.some((entry) => {
        const name = String(entry.toolName || '').toLowerCase();
        if (name.includes('search_documents')) return true;
        const isRead = name.includes('read_file') || /(^|_)read$/.test(name) || name === 'read';
        return isRead && /eval-file-\d+/.test(JSON.stringify(entry.arguments ?? ''));
    });
};
