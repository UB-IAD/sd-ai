/**
 * The general rule behind the policy implementation category's hard group: a tighter goal that no
 * change on the scenario's list meets — not its single policies, and not its combined policy —
 * but that what the organization could realistically do still reaches.
 *
 * A scenario qualifies when it lists a combined policy (`parts`) whose goal measure, in the hidden
 * simulation, beats every single policy it lists by at least MIN_GAP of the goal's threshold. The
 * best realistic setting is then found by simulation: every one of the scenario's levers at its
 * current value, at either realistic limit, or at the value the best combination gives it, in every
 * mix. The hard threshold is the midpoint between the best combination and that best realistic
 * setting, to three significant figures (`tighterThreshold`), so the combination misses it and the
 * best realistic setting meets it: the agent has to go past every change on the list, using what the
 * prompt says is realistic. `threshold` keeps the earlier rule — the midpoint between the best single
 * policy and the best combination, which only a combination meets — for the novice coaching
 * category, which shares this file. Nothing is written per scenario; the unit tests re-derive every
 * threshold by simulation.
 *
 * @module categories/policyImplementationData/hardGoals
 */

import { evaluatePolicy } from '../../utilities/scenarios/scenarioKit.js';

/** How much better the best combination must do than every single policy, as a share of the threshold. */
export const MIN_GAP = 0.02;

const round3 = (x) => Number(x.toPrecision(3));

/** A lever's model name. */
const modelName = (s, lever) => s.glossaryToModel?.[lever] ?? lever;

/**
 * The values each lever is tried at: its current value, its realistic limits, and the value the
 * given policy sets it to — those within the limits.
 * @returns {Array<{name: string, values: number[]}>}
 */
export const leverOptions = function(s, policy) {
    return s.levers.map((lever) => {
        const name = modelName(s, lever);
        const base = Number(s.model.variables.find((v) => v.name === name)?.equation);
        const { min, max } = s.realistic.bounds[lever] || s.realistic.bounds[name] || {};
        const candidates = [base, min, max, policy?.overrides?.[name] !== undefined ? Number(policy.overrides[name]) : undefined];
        const ok = (x) => x !== undefined && Number.isFinite(x) && (min === undefined || x >= min - 1e-9) && (max === undefined || x <= max + 1e-9);
        return { name, values: [...new Set(candidates.filter(ok))] };
    });
};

/**
 * The best realistic setting: every mix of the lever options, simulated.
 * @returns {Promise<{overrides: Object<string, string>, value: number}>}
 */
export const bestRealistic = async function(s, policy) {
    const better = (a, b) => (s.goal.direction === 'below' ? a < b : a > b);
    const options = leverOptions(s, policy);
    let best = null;
    const visit = async (i, overrides) => {
        if (i === options.length) {
            const { value } = await evaluatePolicy(s, overrides);
            if (!best || better(value, best.value)) best = { overrides: { ...overrides }, value };
            return;
        }
        for (const v of options[i].values) await visit(i + 1, { ...overrides, [options[i].name]: String(v) });
    };
    await visit(0, {});
    return best;
};

/**
 * The hard goal for a scenario, or null when it does not qualify.
 * @param {Object} s A scenario from the library
 * @returns {Promise<{threshold: number, tighterThreshold: number, bestSingle: string, bestSingleValue: number, combination: string, combinationValue: number, reference: Object<string, string>, referenceValue: number}|null>}
 */
export const hardGoal = async function(s) {
    if (!s.goal || !s.protected || !s.policies?.some((p) => p.parts)) return null;
    const better = (a, b) => (s.goal.direction === 'below' ? a < b : a > b);
    const best = async (policies) => {
        let out = null;
        for (const p of policies) {
            const { value } = await evaluatePolicy(s, p.overrides);
            if (!out || better(value, out.value)) out = { id: p.id, value };
        }
        return out;
    };
    const single = await best(s.policies.filter((p) => !p.parts));
    const combination = await best(s.policies.filter((p) => p.parts));
    if (!single || !combination) return null;
    if (!better(combination.value, single.value) || Math.abs(combination.value - single.value) < MIN_GAP * Math.abs(s.goal.threshold)) return null;
    const reference = await bestRealistic(s, s.policies.find((p) => p.id === combination.id));
    const threshold = round3((single.value + combination.value) / 2);
    const midpoint = round3((combination.value + reference.value) / 2);
    // The tighter goal only where it leaves the best realistic setting a clear margin (MIN_GAP of the
    // goal's threshold), as the combination's own margin does: a goal only the corner of the lever box
    // meets by under 1% cannot be checked with the agent's own runs. Otherwise the goal stays.
    const tighterThreshold = Math.abs(midpoint - reference.value) >= MIN_GAP * Math.abs(s.goal.threshold) ? midpoint : threshold;
    return {
        threshold,
        tighterThreshold,
        bestSingle: single.id,
        bestSingleValue: round3(single.value),
        combination: combination.id,
        combinationValue: round3(combination.value),
        reference: reference.overrides,
        referenceValue: round3(reference.value)
    };
};

/**
 * Every realistic setting the best-realistic search tries (every mix of the lever options), with its
 * goal measure, in the search's order.
 * @returns {Promise<Array<{overrides: Object<string, string>, value: number}>>}
 */
export const realisticSettings = async function(s, policy) {
    const options = leverOptions(s, policy);
    const out = [];
    const visit = async (i, overrides) => {
        if (i === options.length) {
            out.push({ overrides: { ...overrides }, value: (await evaluatePolicy(s, overrides)).value });
            return;
        }
        for (const v of options[i].values) await visit(i + 1, { ...overrides, [options[i].name]: String(v) });
    };
    await visit(0, {});
    return out;
};

/** A number rounded to three significant figures, up when `up`, else down. */
const round3Out = function(x, up) {
    if (x === 0) return 0;
    const step = 10 ** (Math.floor(Math.log10(Math.abs(x))) - 2);
    return Number(((up ? Math.ceil(x / step - 1e-9) : Math.floor(x / step + 1e-9)) * step).toPrecision(12));
};

/**
 * The second hard group's goal (policyImplementationHard2), the tighter-tolerance lever: the goal is
 * set as close to the best realistic setting as the rule's margin allows — MIN_GAP of the scenario's
 * own threshold short of it, rounded outward to three significant figures — rather than midway
 * between it and the best combination. A scenario qualifies when its first hard goal is the tighter
 * one (not the fallback), the new goal is tighter still, and some realistic setting — a mix the
 * best-realistic search tries, or a point every tenth of the way along the straight line from the
 * combination's setting to the best realistic one — meets the first hard goal but misses the new one
 * (`earlier`: of those, the one farthest from both goals), so going as far as the first hard group
 * asks is not enough. Nothing is written per scenario; the unit tests
 * re-derive every value by simulation.
 * @param {Object} s A scenario from the library
 * @param {Object} g Its first hard goal (hardGoal's result)
 * @returns {Promise<{threshold: number, earlier: Object<string, string>, earlierValue: number}|null>}
 */
export const hard2Goal = async function(s, g) {
    if (!g || g.tighterThreshold === g.threshold) return null;
    const below = s.goal.direction === 'below';
    const threshold = round3Out(g.referenceValue + (below ? 1 : -1) * MIN_GAP * Math.abs(s.goal.threshold), below);
    if (!(below ? threshold < g.tighterThreshold : threshold > g.tighterThreshold)) return null;
    const combination = s.policies.find((p) => p.id === g.combination);
    const settings = await realisticSettings(s, combination);
    // And the settings on the straight line from the combination's to the best realistic one, every
    // tenth of the way: each lever between two values within its limits is within them too.
    const base = (name) => s.model.variables.find((v) => v.name === name)?.equation;
    const names = [...new Set([...Object.keys(combination.overrides), ...Object.keys(g.reference)])];
    for (let k = 1; k < 10; k++) {
        const overrides = Object.fromEntries(names.map((n) => {
            const [a, b] = [Number(combination.overrides[n] ?? base(n)), Number(g.reference[n] ?? base(n))];
            return [n, String(Number((a + (k / 10) * (b - a)).toPrecision(4)))];
        }));
        settings.push({ overrides, value: (await evaluatePolicy(s, overrides)).value });
    }
    const between = settings.filter((x) => (below ? x.value < g.tighterThreshold && x.value >= threshold : x.value > g.tighterThreshold && x.value <= threshold));
    if (!between.length) return null;
    const room = (x) => Math.min(Math.abs(x.value - g.tighterThreshold), Math.abs(x.value - threshold));
    const earlier = between.reduce((a, b) => (room(b) > room(a) ? b : a));
    return { threshold, earlier: earlier.overrides, earlierValue: round3(earlier.value) };
};
