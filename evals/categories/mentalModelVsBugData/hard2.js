/**
 * The general rule behind mentalModelVsBug's second hard group (mentalModelVsBugHard2): every
 * surprise of a report graded together, on held-out scenarios only.
 *
 * generate.js gives a scenario its surprises in pairs: a bug (a planted error that holds a stock's
 * response to a doubled constant back) and a mistaken expectation (a constant whose doubling really
 * moves a stock by only N%). A case here is the scenario's full model with the bugs of its pairs
 * planted, and one report listing every surprise of those pairs — each pair's bug and its mistaken
 * expectation, so the case has exactly as many of each kind and any constant verdict is wrong for
 * half of them. The pairs are tried all at once, then each pair alone, in the order generate.js
 * gives them; the first set where every surprise still holds in the given model makes the case.
 * A surprise holds as in hard.js: re-measured on the model the agent is given, doubling X moves Y
 * by "only" N% (between MIN_CHANGE and MAX_RISE up, or MAX_FALL down); for a bug the same way as the
 * correct model's proportional response, for a mistaken expectation the same way as, and also
 * "only" in, the correct model, so it stays wrong once the bugs are fixed. A set where any surprise
 * fails to hold is not used (none may be dropped, which would unbalance the kinds or leave a bug
 * nobody asked about), and a set whose report is the one the first hard group already asks about is
 * not used either, so every case is a new generation.
 *
 * The lever is in the grading (mentalModelVsBug.js): one test per case, passing only when every
 * surprise is told for what it is, every bug is fixed, every mistaken expectation is left as it is,
 * and the whole model behaves like the correct one — where the first hard group grades each
 * surprise as its own test. The rule's output is frozen in hard2.json by buildGenerated.js; the unit
 * tests re-derive it.
 *
 * @module categories/mentalModelVsBugData/hard2
 */

import { correctModel, plant } from '../guidedCorrectionData/generate.js';
import { doublingRatio, isOnly, report } from './generate.js';

/**
 * A scenario's case for the second hard group, or null.
 * @param {Object} s A scenario from the library
 * @param {Array<Object>} pairs The scenario's generated cases, in generate.js's order (bug, expectation, bug, ...)
 * @param {Array<Object>} firstHard The first hard group's cases (hard.json entries), whose reports are not repeated
 * @returns {Promise<Object|null>} `{name, scenario, description, errors, items}`
 */
export const generateHard2Case = async function(s, pairs, firstHard) {
    const bugs = pairs.filter((c) => c.kind === 'bug');
    const expectations = pairs.filter((c) => c.kind === 'expectation');
    const n = Math.min(bugs.length, expectations.length);
    if (!n) return null;
    const paired = Array.from({ length: n }, (_, i) => [bugs[i], expectations[i]]);
    const correct = correctModel(s);
    const sets = [paired, ...(n > 1 ? paired.map((p) => [p]) : [])];
    const asked = new Set(firstHard.filter((h) => h.scenario === s.id).map((h) => JSON.stringify([h.errors, h.items.map((x) => x.report)])));
    for (const set of sets) {
        const errors = set.map(([b]) => b.error);
        const given = plant(correct, errors);
        const items = [];
        for (const c of set.flat()) {
            const constant = Object.keys(c.check.overrides)[0];
            const stock = c.check.outputs[0];
            const inGiven = await doublingRatio(given, stock, constant);
            const inCorrect = await doublingRatio(correct, stock, constant);
            if (inGiven === null || inCorrect === null || !isOnly(inGiven)) break;
            if (c.kind === 'bug') {
                if ((inGiven > 1) !== (c.check.test.min > 1)) break;
                items.push({ kind: 'bug', constant, stock, variable: c.error.variable, fields: c.plant.fields, report: report(constant, stock, inGiven), band: { min: c.check.test.min, max: c.check.test.max } });
            } else {
                if (!isOnly(inCorrect) || (inGiven > 1) !== (inCorrect > 1)) break;
                items.push({ kind: 'expectation', constant, stock, report: report(constant, stock, inGiven), correctRatio: Number(inCorrect.toFixed(4)) });
            }
        }
        if (items.length !== 2 * set.length) continue;
        items.sort((a, b) => a.constant.localeCompare(b.constant));
        if (asked.has(JSON.stringify([errors, items.map((x) => x.report)]))) continue;
        return { name: `${s.title} (hard 2)`, scenario: s.id, description: `the ${s.title.toLowerCase()}`, errors, items };
    }
    return null;
};
