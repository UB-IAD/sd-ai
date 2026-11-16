/**
 * The general rule that makes mentalModelVsBug's hard cases, for every scenario in the library.
 *
 * generate.js gives a scenario up to PAIRS bug cases and as many mistaken-expectation cases, one
 * surprise each. A hard case puts them together: the scenario's full model with its bugs planted,
 * and one report listing every surprise — the bugs' and the mistaken expectations' — so the agent has to tell, surprise by surprise, which is a bug to fix and which an
 * expectation to correct, in a model where both kinds are present. Every report is re-measured on
 * the model the agent is given (doubling X there moves Y by N%), and an item is kept only if:
 *   - for a bug: doubling X still moves Y by "only" N% in the given model (between MIN_CHANGE and
 *     MAX_RISE up, or MAX_FALL down) the same way, while in the correct model it roughly doubles
 *     (halves) Y — generate.js's check
 *   - for a mistaken expectation: doubling X moves Y by "only" N% in the given model and, the same
 *     way, in the correct model too, so the expectation stays wrong once the bugs are fixed
 * Every planted bug must give an item (an unreported bug would be a fault nobody asked about); the
 * scenario's bugs are tried all at once, then each alone, the first set that works making the case,
 * which needs at least one bug, one mistaken expectation and HARD_ITEMS surprises in all. Items are
 * listed in order of the constant doubled, so their kinds follow no fixed pattern.
 *
 * The clean control is the same request on the correct model, listing only the mistaken
 * expectations, with their reports as generate.js measured them there.
 *
 * @module categories/mentalModelVsBugData/hard
 */

import { correctModel, plant } from '../guidedCorrectionData/generate.js';
import { generateCases, doublingRatio, isOnly, report } from './generate.js';

export const HARD_ITEMS = 3;

/**
 * The hard case for one scenario, or null.
 * @param {Object} s A scenario from the library
 * @returns {Promise<Object|null>} `{name, scenario, description, errors, items}`
 */
export const generateHardCase = async function(s) {
    const pairs = await generateCases(s);
    const bugs = pairs.filter((c) => c.kind === 'bug');
    const expectations = pairs.filter((c) => c.kind === 'expectation');
    if (!bugs.length || !expectations.length) return null;
    const correct = correctModel(s);
    // Every bug at once first, then each bug alone.
    const sets = [bugs, ...(bugs.length > 1 ? bugs.map((b) => [b]) : [])];
    for (const set of sets) {
        const errors = set.map((b) => b.error);
        const given = plant(correct, errors);
        const items = [];
        for (const c of [...set, ...expectations]) {
            const constant = Object.keys(c.check.overrides)[0];
            const stock = c.check.outputs[0];
            const inGiven = await doublingRatio(given, stock, constant);
            const inCorrect = await doublingRatio(correct, stock, constant);
            if (inGiven === null || inCorrect === null || !isOnly(inGiven)) continue;
            if (c.kind === 'bug') {
                if ((inGiven > 1) !== (c.check.test.min > 1)) continue;
                items.push({ kind: 'bug', constant, stock, variable: c.error.variable, fields: c.plant.fields, report: report(constant, stock, inGiven), band: { min: c.check.test.min, max: c.check.test.max } });
            } else {
                if (!isOnly(inCorrect) || (inGiven > 1) !== (inCorrect > 1)) continue;
                items.push({ kind: 'expectation', constant, stock, report: report(constant, stock, inGiven), correctRatio: Number(inCorrect.toFixed(4)), cleanReport: c.report });
            }
        }
        // Every planted bug must be reported: an unreported one would be a fault nobody asked about.
        if (items.filter((x) => x.kind === 'bug').length !== set.length || !items.some((x) => x.kind === 'expectation') || items.length < HARD_ITEMS) continue;
        items.sort((a, b) => a.constant.localeCompare(b.constant));
        return { name: `${s.title} (hard)`, scenario: s.id, description: `the ${s.title.toLowerCase()}`, errors, items };
    }
    return null;
};
