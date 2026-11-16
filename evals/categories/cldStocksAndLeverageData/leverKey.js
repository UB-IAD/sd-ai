/**
 * The general rule behind the second hard leverage group (leverageHard2): for every lever a held-out
 * scenario gives realistic limits for, whether moving it toward a limit, on its own, meets the goal,
 * and which way. No change is listed for the agent; the levers and their limits are all it gets.
 *
 * For each lever (glossary name, in the order of the scenario's realistic bounds) and each side with
 * a limit other than its current value, the goal measure is simulated at LEVER_GRID evenly spaced
 * points from the current value to the limit. A side meets the goal when some point clears the
 * threshold by at least LEVER_MARGIN of it, and fails when no point comes within LEVER_MARGIN of
 * it; anything between is too close to call. A lever's verdict:
 *   - 'raised' or 'lowered': exactly one side meets the goal, and the other side, if it has one, fails
 *   - 'no': every side fails
 *   - null (ungraded, still listed to the agent): a side too close to call, both sides meeting, or no
 *     side to move (its current value is its only limit)
 * A scenario is taken when at least one graded lever meets the goal and at least one does not, so a
 * constant verdict fails, and when the verdicts are more than what its listed changes already say —
 * some graded lever is set by none of its single policies, or its verdict differs from theirs (a
 * lever whose policy pushes it the wrong way, say) — so judging only the first hard group's list of
 * changes cannot pass.
 *
 * @module categories/cldStocksAndLeverageData/leverKey
 */

import { glossaryModel } from '../../utilities/scenarios/renameModel.js';
import { findVariable, isNumericEquation } from '../../utilities/modelDiff.js';
import { evaluatePolicy } from '../../utilities/scenarios/scenarioKit.js';

export const LEVER_GRID = 10;
export const LEVER_MARGIN = 0.05;

const hiddenName = (s, g) => s.glossaryToModel[g] ?? g;

/** What a scenario's single policies say about a lever: 'raised', 'lowered', 'no', or undefined when none sets it alone. */
export const policyVerdict = function(s, lever, current) {
    const own = (s.policies || []).filter((p) => !p.parts && Object.keys(p.overrides).length === 1 && Object.keys(p.overrides)[0] === hiddenName(s, lever));
    if (!own.length) return undefined;
    const works = own.find((p) => p.effective);
    if (!works) return 'no';
    return Number(Object.values(works.overrides)[0]) > current ? 'raised' : 'lowered';
};

/**
 * The lever key for one scenario.
 * @param {Object} s A scenario from the library
 * @returns {Promise<{levers: Array<{lever: string, current: number, min?: number, max?: number, verdict: string|null, best: Object<string, number>, why?: string}>, taken: boolean, why?: string}>}
 */
export const leverKey = async function(s) {
    if (!s.goal || !s.realistic?.bounds) return { levers: [], taken: false, why: 'no goal or no realistic limits' };
    const model = glossaryModel(s);
    const levers = [];
    for (const [lever, bound] of Object.entries(s.realistic.bounds)) {
        const v = findVariable(model.variables, lever);
        if (!v || !isNumericEquation(v.equation)) continue;
        const current = Number(v.equation);
        const best = {};
        for (const [side, limit] of [['max', bound.max], ['min', bound.min]]) {
            if (limit === undefined || limit === current) continue;
            let top = -Infinity;
            for (let k = 1; k <= LEVER_GRID; k++) {
                const r = await evaluatePolicy(s, { [hiddenName(s, lever)]: String(current + ((limit - current) * k) / LEVER_GRID) });
                const signed = (s.goal.direction === 'below' ? s.goal.threshold - r.value : r.value - s.goal.threshold) / Math.abs(s.goal.threshold);
                top = Math.max(top, signed);
            }
            best[side] = Number(top.toFixed(4));
        }
        const sides = Object.keys(best);
        const meets = sides.filter((x) => best[x] >= LEVER_MARGIN);
        const fails = sides.filter((x) => best[x] <= -LEVER_MARGIN);
        let verdict = null;
        let why;
        if (!sides.length) why = 'its current value is its only realistic limit';
        else if (meets.length + fails.length < sides.length) why = 'a side comes within the margin of the goal';
        else if (meets.length > 1) why = 'both sides meet the goal';
        else verdict = meets.length ? (meets[0] === 'max' ? 'raised' : 'lowered') : 'no';
        levers.push({ lever, current, ...(bound.min !== undefined ? { min: bound.min } : {}), ...(bound.max !== undefined ? { max: bound.max } : {}), verdict, best, ...(why ? { why } : {}) });
    }
    const graded = levers.filter((l) => l.verdict !== null);
    if (!graded.some((l) => l.verdict !== 'no')) return { levers, taken: false, why: 'no lever with a realistic limit meets the goal on its own' };
    if (!graded.some((l) => l.verdict === 'no')) return { levers, taken: false, why: 'every graded lever meets the goal on its own' };
    if (graded.every((l) => policyVerdict(s, l.lever, l.current) === l.verdict)) return { levers, taken: false, why: 'every graded lever\'s verdict is what its listed changes already say' };
    return { levers, taken: true };
};

/**
 * The order the levers of each taken scenario are listed in, so that, position by position across
 * the group, no verdict is the right reading of a listed lever in more of the tests than the
 * scenarios allow: a greedy pass over the positions, each scenario in turn (in the group's order)
 * taking from its remaining levers one whose verdict has been least used at that position so far,
 * the first such in its realistic bounds' order. A closed field is read by position (q1, q2, …), so
 * a constant reading of one position cannot ride on every scenario listing a working lever first.
 * @param {Object<string, {levers: Array<Object>}>} keys The lever keys, by scenario
 * @param {Array<string>} ids The group's scenarios, in order
 * @returns {Object<string, Array<Object>>} Each scenario's levers, in listing order
 */
export const balancedOrder = function(keys, ids) {
    const remaining = Object.fromEntries(ids.map((id) => [id, [...keys[id].levers]]));
    const out = Object.fromEntries(ids.map((id) => [id, []]));
    for (let p = 0; ids.some((id) => remaining[id].length); p++) {
        const used = {};
        for (const id of ids) {
            if (!remaining[id].length) continue;
            const least = Math.min(...remaining[id].map((l) => used[l.verdict] ?? 0));
            const pick = remaining[id].find((l) => (used[l.verdict] ?? 0) === least);
            remaining[id].splice(remaining[id].indexOf(pick), 1);
            out[id].push(pick);
            used[pick.verdict] = (used[pick.verdict] ?? 0) + 1;
        }
    }
    return out;
};
