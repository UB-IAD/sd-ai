/**
 * The general rule that makes guidedCorrection's hard cases, for every scenario in the library.
 *
 * The correct model is the scenario's full glossary model, as for the generated cases. A hard case
 * plants HARD_ERRORS errors at once, each of a different kind of the four generate.js knows
 * (timeConstant, reversedGap, disconnected, missingOutflow) and each in a different variable; each
 * alone moves some stock by at least MIN_DEVIATION of its largest value, and all of them together
 * still run with finite values and move some stock by at least MIN_DEVIATION (they do not cancel
 * out). Kind combinations are tried in KINDS order, each kind's candidates
 * in model order; the first combination that works makes the case. Then one more error
 * (EXTRA_ERRORS) is added where the model admits one: the first valid candidate, of a kind not yet
 * planted first, else a second of a planted kind, in a variable no error lives in or names, with the
 * whole planted model still running and moving some stock by MIN_DEVIATION — four errors at once.
 * Distractors are false claims
 * about variables no error lives in or names, kinds not planted first, as for the generated cases.
 *
 * @module categories/guidedCorrectionData/hard
 */

import { correctModel, candidatesFor, plant, deviation, MIN_DEVIATION, KINDS } from './generate.js';

export const HARD_ERRORS = 3;

/**
 * The hard group's added lever: more faults at once. After the HARD_ERRORS errors of different kinds
 * are chosen, up to EXTRA_ERRORS more are planted by the rule in generateHardCase.
 */
export const EXTRA_ERRORS = 1;

const combinations = function(list, k) {
    if (k === 0) return [[]];
    return list.flatMap((x, i) => combinations(list.slice(i + 1), k - 1).map((rest) => [x, ...rest]));
};

/**
 * The hard case for one scenario, or null.
 * @param {Object} s A scenario from the library
 * @returns {Promise<Object|null>} `{name, scenario, description, errors, distractors}`
 */
export const generateHardCase = async function(s) {
    const correct = correctModel(s);
    const all = candidatesFor(correct);
    const valid = [];
    for (const c of all) {
        const d = await deviation(plant(correct, [c]), correct);
        if (d !== null && d >= MIN_DEVIATION) valid.push(c);
    }
    let errors = null;
    const pick = async function(kinds, chosen) {
        if (!kinds.length) {
            const together = await deviation(plant(correct, chosen), correct);
            return together !== null && together >= MIN_DEVIATION ? chosen : null;
        }
        for (const c of valid.filter((x) => x.kind === kinds[0] && !chosen.some((e) => e.variable === x.variable))) {
            const found = await pick(kinds.slice(1), [...chosen, c]);
            if (found) return found;
        }
        return null;
    };
    for (const kinds of combinations(KINDS, HARD_ERRORS)) {
        errors = await pick(kinds, []);
        if (errors) break;
    }
    if (!errors) return null;
    const distractorsFor = function(chosen) {
        const planted = new Set(chosen.map((e) => e.kind));
        const touched = new Set(chosen.map((e) => e.variable));
        // A claim about a variable an error names (the flow a disconnection is about, say) would read as
        // part of that error, so only variables no error mentions are used.
        const named = (v) => chosen.some((e) => e.id.includes(v));
        const claims = all.filter((c) => !touched.has(c.variable) && !named(c.variable) && !chosen.some((e) => e.id === c.id));
        return [...new Set([...claims.filter((c) => !planted.has(c.kind)), ...claims.filter((c) => planted.has(c.kind))].map((c) => c.falseClaim))].slice(0, 2);
    };
    if (distractorsFor(errors).length < 2) return null;
    // The extra error (EXTRA_ERRORS): the first valid candidate — a kind not yet planted first, then
    // the planted kinds, each in KINDS order and model order — in a variable no error lives in or
    // names, that keeps the whole planted model running and moving some stock by MIN_DEVIATION, and
    // leaves two distractors. A model with none keeps its three; the case set does not change.
    const named = (v) => errors.some((e) => e.id.includes(v));
    const planted = new Set(errors.map((e) => e.kind));
    const kindOrder = [...KINDS.filter((k) => !planted.has(k)), ...KINDS.filter((k) => planted.has(k))];
    for (let n = 0; n < EXTRA_ERRORS; n++) {
        for (const extra of kindOrder.flatMap((k) => valid.filter((x) => x.kind === k))) {
            if (errors.some((e) => e.variable === extra.variable || e.id === extra.id) || named(extra.variable)) continue;
            const chosen = [...errors, extra];
            const together = await deviation(plant(correct, chosen), correct);
            if (together === null || together < MIN_DEVIATION || distractorsFor(chosen).length < 2) continue;
            errors = chosen;
            break;
        }
    }
    const distractors = distractorsFor(errors);
    return {
        name: `${s.title} (hard)`,
        scenario: s.id,
        description: `the ${s.title.toLowerCase()}`,
        errors: errors.map(({ kind, id, variable, change, text }) => ({ kind, id, variable, change, text })),
        distractors
    };
};
