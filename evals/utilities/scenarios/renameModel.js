/**
 * Rename variables in an sd-json model, rewriting every reference to them.
 *
 * Used to express a hidden scenario model in the glossary names an agent is asked to use, so unit
 * tests can hand a category a reference answer that is exactly what a perfect agent would build.
 *
 * @module utilities/scenarios/renameModel
 */

const underscore = (name) => name.replace(/\s+/g, '_');
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {Object} model An sd-json model
 * @param {Object<string, string>} renames Old name to new name
 * @returns {Object} A renamed copy
 */
export const renameModel = function(model, renames) {
    const copy = structuredClone(model);
    const entries = Object.entries(renames).sort((a, b) => b[0].length - a[0].length);
    const rewrite = (equation) => {
        let text = String(equation ?? '');
        for (const [from, to] of entries) {
            text = text.replace(new RegExp(`(?<![A-Za-z0-9_])${escape(underscore(from))}(?![A-Za-z0-9_])`, 'gi'), underscore(to));
        }
        return text;
    };
    const renameOne = (name) => {
        const hit = entries.find(([from]) => from.toLowerCase() === String(name).toLowerCase());
        return hit ? hit[1] : name;
    };
    for (const v of copy.variables) {
        v.name = renameOne(v.name);
        if (v.equation !== undefined) v.equation = rewrite(v.equation);
        if (v.inflows) v.inflows = v.inflows.map(renameOne);
        if (v.outflows) v.outflows = v.outflows.map(renameOne);
    }
    copy.relationships = (copy.relationships || []).map((r) => ({ ...r, from: renameOne(r.from), to: renameOne(r.to) }));
    return copy;
};

/**
 * A scenario's hidden model in its glossary names.
 * @param {Object} scenario A scenario from library.js
 * @returns {Object} The renamed model
 */
export const glossaryModel = function(scenario) {
    return renameModel(scenario.model, Object.fromEntries(Object.entries(scenario.glossaryToModel).map(([g, m]) => [m, g])));
};
