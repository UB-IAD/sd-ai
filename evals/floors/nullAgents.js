/**
 * Null agents: the score floor of every new agent category, so a category's score can be read
 * against what doing nothing, or answering everything the same way, would get.
 *
 *   - silent: returns nothing — no model, no text, no tool calls, no conversation
 *   - yes: returns the model it was given unchanged and a token answer, and every judge reading of
 *     it comes back as the most assertive option (the first option of each closed list, every item of
 *     every list affirmed)
 *   - no: the same, with every reading the most noncommittal option (the last of each closed list,
 *     nothing affirmed)
 *
 * The judge is replaced by `schemaReading`, which fills any zod schema that way, so no category needs
 * a null agent of its own. A floor is the share of a category's tests that agent passes.
 *
 * @module floors/nullAgents
 */

export const NULL_AGENTS = ['silent', 'yes', 'no'];

/** The categories the floors are computed for: the agent evals added on the agent board. */
export const CATEGORIES = [
    'equilibrium', 'modelToCLD', 'sensitivityInterpretation', 'guidedCorrection', 'unitConsistency', 'referenceModes',
    'sfdFromBoundary', 'elicitation', 'multiplePerspectives', 'cldInterpretation', 'formulationCritique', 'noviceCoaching',
    'extremeConditions', 'policyImplementation', 'mece', 'cldStocksAndLeverage', 'mentalModelVsBug', 'archetypes',
    'analysisSetup', 'transferability', 'aggregationCritique', 'calibration', 'policyAnalysisMethods', 'causalSources'
];

/** How many items an affirmed list of numbered items gets: enough to cover any list a judge is shown. */
const LIST_LENGTH = 30;

/**
 * A reading of a zod (v4) schema: `mode` 'yes' takes the first option of every enum and fills every
 * list; 'no' takes the last option and leaves lists empty.
 */
export const schemaReading = function(schema, mode) {
    if (/^option-\d+$/.test(mode)) {
        const d = schema?._zod?.def ?? schema?.def;
        if (d?.type !== 'enum' && !['object', 'array', 'nullable', 'optional', 'default'].includes(d?.type)) return schemaReading(schema, 'yes');
        if (d?.type === 'nullable') return schemaReading(d.innerType, mode);
    }
    const def = schema?._zod?.def ?? schema?.def;
    switch (def?.type) {
        case 'object': return Object.fromEntries(Object.entries(schema.shape).map(([k, v]) => [k, schemaReading(v, mode)]));
        case 'array': {
            if (mode === 'no') return [];
            // an option-k reading fills lists as a 'yes' reading does
            const element = def.element;
            const elementDef = element?._zod?.def ?? element?.def;
            if (elementDef?.type === 'object') {
                return Array.from({ length: LIST_LENGTH }, (_, i) => {
                    const item = schemaReading(element, mode);
                    if ('number' in item) item.number = i + 1;
                    return item;
                });
            }
            return [schemaReading(element, mode)];
        }
        case 'enum': {
            const options = Object.values(def.entries);
            // 'option-k': every closed question answered with its k-th option (clamped), a constant
            // answer from the middle of a list that the two ends never try.
            const k = /^option-(\d+)$/.exec(mode);
            if (k) return options[Math.min(Number(k[1]), options.length - 1)];
            return mode === 'yes' ? options[0] : options[options.length - 1];
        }
        case 'literal': return def.values?.[0];
        case 'boolean': return mode === 'yes';
        case 'number': return mode === 'yes' ? 1 : 0;
        case 'string': return mode === 'yes' ? 'yes' : '';
        case 'nullable': return mode === 'yes' ? schemaReading(def.innerType, mode) : null;
        case 'optional': case 'default': return schemaReading(def.innerType, mode);
        default: return null;
    }
};

/** The null agent's response to a test. */
export const nullResponse = function(agent, test) {
    if (agent === 'silent') return { model: { variables: [], relationships: [] }, supportingInfo: { explanation: '' }, output: { textContent: '' }, toolLog: [], transcript: [], snapshots: [] };
    const model = structuredClone(test.currentModel || { variables: [], relationships: [] });
    const turns = Math.max(1, (test.additionalParameters?.turns || []).length || test.additionalParameters?.userScript?.turns || 1);
    const transcript = [];
    for (let t = 1; t <= turns; t++) transcript.push({ role: 'user', turn: t, text: 'x' }, { role: 'agent', turn: t, text: 'x' });
    return { model, supportingInfo: { explanation: 'x' }, output: { textContent: 'x' }, toolLog: [], transcript, snapshots: transcript.filter((x) => x.role === 'agent').map((x) => ({ turn: x.turn, model })) };
};
