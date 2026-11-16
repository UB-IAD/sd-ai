/**
 * The general rule that makes policyAnalysisMethods cases for every scenario in the library.
 *
 * Each scenario's model is its glossary model, and every question is about its goal measure (the
 * peak of the goal variable, its value at the goal's time, or its overshoot). The constants are
 * ranked by how far a ±20% change moves that measure.
 *   - scenario: "if a constant had been SCENARIO_FACTOR times its value from the start, what would
 *     the measure be?" — the first constant, in order of influence starting from the second (the
 *     first is the which-matters question's answer, tried last), whose change moves the measure by
 *     at least MIN_SCENARIO_CHANGE, so repeating the base value fails, and leaves it at least
 *     MIN_TRUTH_SHARE of the base, since a truth near zero cannot be graded within a relative
 *     tolerance. The truth is simulated.
 *   - sensitivity: "which of two constants, each possibly 20% off, matters more for the measure?" —
 *     the most influential constant and the most influential one whose swing is at most
 *     1/SENSITIVITY_MARGIN of it (and above NOTICEABLE, so neither is idle). The options are listed
 *     alphabetically.
 *   - calibration: the scenario's generated calibration parameters case, if it has one.
 *
 * @module categories/policyAnalysisMethodsData/generate
 */

import { glossaryModel } from '../../utilities/scenarios/renameModel.js';
import { simulateModel } from '../../utilities/simulateModel.js';
import { isNumericEquation, findVariable } from '../../utilities/modelDiff.js';
import { sampleSeries } from '../../utilities/simulator/sensitivity.js';
import { SAMPLE_POINTS } from '../../utilities/analysisTools.js';

export const SCENARIO_FACTOR = 1.5;
export const MIN_SCENARIO_CHANGE = 0.15;
export const MIN_TRUTH_SHARE = 0.1;
export const SENSITIVITY_MARGIN = 2.5;
export const NOTICEABLE = 0.02;
const SHARE = 0.2;

/** The scenario's glossary model over its own run settings. */
export const scenarioModel = (s) => ({ ...glossaryModel(s), specs: s.model.specs });

/** The scenario's goal variable (glossary name) and its measure: a label and a function of a series. */
export const goalMeasure = function(s) {
    const output = Object.entries(s.glossaryToModel).find(([, m]) => m === s.goal.variable)?.[0] ?? s.goal.variable;
    const unit = { months: 'month', weeks: 'week', years: 'year', days: 'day' }[s.timeUnits] ?? 'time';
    const specs = s.model.specs;
    if (s.goal.measure === 'max') return { output, label: `the peak of ${output}`, fn: (x) => Math.max(...x) };
    if (s.goal.measure === 'overshoot') return { output, label: `how far ${output} overshoots its final level`, fn: (x) => Math.max(...x) - x[x.length - 1] };
    return { output, label: `${output} at ${unit} ${s.goal.time}`, fn: (x) => x[Math.min(x.length - 1, Math.round(((s.goal.time - specs.startTime) / (specs.stopTime - specs.startTime)) * (x.length - 1)))] };
};

/** The measure of a run of the model with some overrides, or null. */
export const measureOf = async function(s, overrides) {
    const m = goalMeasure(s);
    const run = await simulateModel(scenarioModel(s), [m.output], overrides);
    return run.ok ? m.fn(run.series[m.output]) : null;
};

/**
 * The measure of a run computed on the SAMPLE_POINTS-point grid that the agents' run_scenario tool
 * returns, or null. An agent reading the tool's output can only see this grid, so a peak between
 * grid points is out of its sight; the hard group accepts either value.
 */
export const sampledMeasureOf = async function(s, overrides) {
    const m = goalMeasure(s);
    const run = await simulateModel(scenarioModel(s), [m.output], overrides);
    if (!run.ok) return null;
    return m.fn(sampleSeries(run.time, run.series[m.output], Math.min(SAMPLE_POINTS, run.time.length)).values);
};

const round = (x) => Number(x.toPrecision(3));

/**
 * The generated cases for one scenario.
 * @param {Object} s A scenario from the library
 * @param {Object} calibrationCases The calibration category's cases, by name
 * @returns {Promise<Array<Object>>} Case data (without the model, which cases.js builds)
 */
export const generateCases = async function(s, calibrationCases) {
    const model = scenarioModel(s);
    const m = goalMeasure(s);
    const base = await measureOf(s, null);
    if (base === null) return [];
    const constants = model.variables.filter((v) => v.type !== 'stock' && isNumericEquation(v.equation) && Number(v.equation) > 0);
    const swings = [];
    for (const c of constants) {
        const v = Number(c.equation);
        const values = [await measureOf(s, { [c.name]: String(v * (1 - SHARE)) }), await measureOf(s, { [c.name]: String(v * (1 + SHARE)) })];
        if (values.some((x) => x === null)) continue;
        swings.push({ name: c.name, value: v, swing: Math.max(...values.map((x) => Math.abs(x - base))) / Math.max(Math.abs(base), 1e-9) });
    }
    swings.sort((a, b) => b.swing - a.swing || a.name.localeCompare(b.name));
    const out = [];
    const where = `my model of the ${s.title.toLowerCase()}`;

    // The what-if moves another constant than the one the which-matters question is about, where
    // one moves the measure enough, so the two questions test different things.
    for (const c of [...swings.slice(1), ...swings.slice(0, 1)]) {
        const changed = round(c.value * SCENARIO_FACTOR);
        const truth = await measureOf(s, { [c.name]: String(changed) });
        if (truth === null || Math.abs(truth - base) < MIN_SCENARIO_CHANGE * Math.max(Math.abs(base), 1e-9)) continue;
        // A truth near zero cannot be graded within a relative tolerance ("about zero" would fail).
        if (Math.abs(truth) < MIN_TRUTH_SHARE * Math.abs(base)) continue;
        out.push({
            name: `${s.title}: what if`, scenario: s.id, kind: 'scenario',
            prompt: `Here is ${where}. If "${c.name}" had been ${changed} instead of ${c.value} from the start, what would ${m.label} have been? Please work it out with the model and give me the number; don't change the model itself.`,
            overrideNames: [c.name], overrideValue: changed, quantity: m.label, truth
        });
        break;
    }

    const top = swings[0];
    const weak = top && swings.find((x) => x !== top && x.swing >= NOTICEABLE && x.swing * SENSITIVITY_MARGIN <= top.swing);
    if (weak) {
        const options = [top.name, weak.name].sort();
        out.push({
            name: `${s.title}: which matters`, scenario: s.id, kind: 'sensitivity',
            prompt: `Here is ${where}. Neither "${options[0]}" nor "${options[1]}" is known well — either could easily be 20% off. Which of the two matters more for ${m.label}? Please base your answer on the model, and don't change it.`,
            parameters: options, baseValues: { [top.name]: top.value, [weak.name]: weak.value }, answer: top.name, options, measureLabel: m.label
        });
    }

    const cal = Object.entries(calibrationCases).find(([, c]) => c.scenario === s.id && c.kind === 'parameters');
    if (cal) {
        out.push({
            name: `${s.title}: history`, scenario: s.id, kind: 'calibration',
            prompt: `Here is ${where}, and we have the history of "${cal[1].series}", which you can load. The model doesn't match it yet. Please find the values of the model's parameters that make it match our history, and return the model with them in place.`,
            calibrationCase: cal[0]
        });
    }
    return out;
};

/**
 * The hard group's rule: a "how far, and what then" question with two numbers from one search.
 * For each scenario, its first effective single policy that sets one plain constant lever to that
 * lever's realistic limit gives the lever, its current value and the limit. The goal measure must
 * cross the goal's threshold exactly once on the way from the current value to the limit (checked
 * on a grid of HARD_GRID steps), at between HARD_CROSSING[0] and HARD_CROSSING[1] of the way, so
 * neither leaving the lever alone nor jumping to the limit is near the answer, and the measure at
 * the limit must be at least MIN_TRUTH_SHARE of its base value, so it can be graded within a
 * relative tolerance. The crossing is found by bisection; both numbers are simulated.
 */
export const HARD_CROSSING = [0.2, 0.8];
export const HARD_GRID = 20;
/** The lever value must be within this share of the move from the current value to the limit. */
export const HARD_LEVER_TOLERANCE = 0.10;
/** The measure at the limit must be within this share of the simulated one. */
export const HARD_MEASURE_TOLERANCE = 0.05;
const BISECTIONS = 24;

const meetsGoal = (s, x) => (s.goal.direction === 'below' ? x < s.goal.threshold : x > s.goal.threshold);

/**
 * The hard question, the same for a goal within reach and one out of reach: whether the goal can be
 * met by taking the lever no further than its realistic limit, how far if so, and the goal measure
 * at the limit.
 */
export const hardPrompt = (s, lever, current, limit) => `Here is my model of the ${s.title.toLowerCase()}. Our goal is to ${s.goal.label}, and as things stand we miss it. One thing we control is "${lever}", now ${current}; realistically we could take it as far as ${limit}. Could we meet the goal by taking it no further than that — and if so, how far would we have to take it, to what value? And what would ${goalMeasure(s).label} be if we took it all the way to ${limit}? Please work these out with the model and give me the answers; don't change the model itself.`;

/** How much of the gap to the goal an out-of-reach lever must close at its limit. */
export const REACH_MOVE = 0.25;

/**
 * The hard group's balancing rule: a goal out of reach. For each scenario, the first lever in its
 * realistic bounds — a plain constant, not the reachable case's lever — that, taken from its value
 * to its realistic limit on the side that helps, never meets the goal (on a grid of HARD_GRID
 * steps), though at the limit it closes at least REACH_MOVE of the gap between the measure and the
 * threshold (so it is a lever worth asking about), leaving the measure at least MIN_TRUTH_SHARE of
 * its base and more than HARD_MEASURE_TOLERANCE away from it. The right answer is that the goal
 * cannot be met that way, with the measure at the limit (simulated). Alongside the reachable cases
 * it balances the group: answering every question with a value, or every one with "it cannot be
 * done", fails half of it.
 * @param {Object} s A scenario from the library
 * @param {string|null} taken The reachable case's lever, if the scenario has one
 * @returns {Promise<Object|null>}
 */
export const generateUnreachableCase = async function(s, taken) {
    if (!s.goal || !s.realistic?.bounds) return null;
    const model = scenarioModel(s);
    const m = goalMeasure(s);
    const base0 = await measureOf(s, null);
    if (base0 === null || meetsGoal(s, base0)) return null;
    for (const [name, bound] of Object.entries(s.realistic.bounds)) {
        const v = findVariable(model.variables, name);
        if (!v || v.type === 'stock' || !isNumericEquation(v.equation) || v.name === taken) continue;
        const current = Number(v.equation);
        for (const limit of [bound.max, bound.min]) {
            if (limit === undefined || limit === current) continue;
            const at = async (f) => measureOf(s, { [v.name]: String(current + (limit - current) * f) });
            const atLimit = await at(1);
            if (atLimit === null) continue;
            const closed = (s.goal.direction === 'below' ? base0 - atLimit : atLimit - base0) / Math.abs(base0 - s.goal.threshold);
            if (closed < REACH_MOVE) continue;
            if (Math.abs(atLimit) < MIN_TRUTH_SHARE * Math.abs(base0) || Math.abs(atLimit - base0) <= HARD_MEASURE_TOLERANCE * Math.abs(atLimit)) continue;
            let ever = false;
            for (let k = 0; k <= HARD_GRID && !ever; k++) { const x = await at(k / HARD_GRID); ever = x === null || meetsGoal(s, x); }
            if (ever) continue;
            return {
                name: `${s.title}: how far, out of reach`, scenario: s.id, kind: 'threshold', lever: v.name, current, limit,
                prompt: hardPrompt(s, v.name, current, limit),
                reachable: false,
                quantity: m.label, truth: atLimit, sampledTruth: await sampledMeasureOf(s, { [v.name]: String(limit) })
            };
        }
    }
    return null;
};

/**
 * The hard case for one scenario, or null when no policy qualifies.
 * @param {Object} s A scenario from the library
 * @returns {Promise<Object|null>}
 */
export const generateHardCase = async function(s) {
    if (!s.goal || !s.policies || !s.realistic?.bounds) return null;
    const model = scenarioModel(s);
    const m = goalMeasure(s);
    const toGlossary = (name) => Object.entries(s.glossaryToModel).find(([, x]) => x === name)?.[0] ?? name;
    const base0 = await measureOf(s, null);
    if (base0 === null) return null;
    for (const p of s.policies.filter((x) => x.effective && !x.parts)) {
        const entries = Object.entries(p.overrides);
        if (entries.length !== 1) continue;
        const lever = toGlossary(entries[0][0]);
        const v = findVariable(model.variables, lever);
        const bound = s.realistic.bounds[lever];
        if (!v || v.type === 'stock' || !isNumericEquation(v.equation) || !bound) continue;
        const current = Number(v.equation);
        const limit = Number(entries[0][1]) > current ? bound.max : bound.min;
        if (limit === undefined || Number(entries[0][1]) !== limit) continue;
        const at = async (f) => measureOf(s, { [lever]: String(current + (limit - current) * f) });
        const grid = [];
        for (let k = 0; k <= HARD_GRID; k++) grid.push(meetsGoal(s, await at(k / HARD_GRID)));
        const flips = grid.slice(1).filter((x, k) => x !== grid[k]).length;
        if (flips !== 1 || grid[0] || !grid[HARD_GRID]) continue;
        let [lo, hi] = [0, 1];
        for (let i = 0; i < BISECTIONS; i++) {
            const mid = (lo + hi) / 2;
            if (meetsGoal(s, await at(mid))) hi = mid; else lo = mid;
        }
        const share = (lo + hi) / 2;
        if (share < HARD_CROSSING[0] || share > HARD_CROSSING[1]) continue;
        const atLimit = await at(1);
        if (Math.abs(atLimit) < MIN_TRUTH_SHARE * Math.abs(base0)) continue;
        const crossing = Number((current + (limit - current) * share).toPrecision(6));
        return {
            name: `${s.title}: how far`, scenario: s.id, kind: 'threshold', lever, current, limit,
            prompt: hardPrompt(s, lever, current, limit),
            reachable: true,
            quantity: m.label, crossing, crossingShare: share, truth: atLimit, sampledTruth: await sampledMeasureOf(s, { [lever]: String(limit) })
        };
    }
    return null;
};

/**
 * The second hard group's rule (policyAnalysisMethodsHard2): a lever setting that must hold up
 * under an uncertain number, a second answer that depends on the first. For each scenario, the
 * first lever in its realistic bounds (a plain constant, on either side with a limit) whose goal is
 * crossed once on the way to the limit, between HARD_CROSSING[0] and HARD_CROSSING[1] of the way,
 * as the first hard group asks; then the first of the quantities management does not control (its
 * protected variables that are plain constants), in order of how far a ±ROBUST_SHARE change moves
 * the goal measure, such that:
 *   - with that quantity anywhere in ±ROBUST_SHARE (checked at ROBUST_FACTORS), the goal is still
 *     crossed once on the way to the limit (or met all the way from the current value, a crossing
 *     at no move), and the furthest crossing is at one end of the range
 *     (so "however it turns out" has one answer, found by trying both ends)
 *   - the furthest crossing is more than 2 × HARD_LEVER_TOLERANCE of the move beyond the first
 *     answer, and beyond the crossing at the other end, so repeating the first answer, or taking
 *     the uncertainty the wrong way, fails
 *   - it is at most ROBUST_MAX_SHARE of the way to the limit (twice the tolerance short of it), so
 *     answering with the limit itself fails
 * The direction in which the quantity hurts is not told. Both crossings are found by bisection.
 */
export const ROBUST_SHARE = 0.2;
export const ROBUST_FACTORS = [0.8, 0.9, 1.1, 1.2];
export const ROBUST_MAX_SHARE = 1 - 2 * HARD_LEVER_TOLERANCE;

/** Where, as a share of the move from current to limit, the goal is first met: 0 when it is met all the way from the current value, null unless it is that or flips exactly once. */
export const crossingShare = async function(s, lever, current, limit, extra) {
    const at = async (f) => measureOf(s, { ...extra, [lever]: String(current + (limit - current) * f) });
    const grid = [];
    for (let k = 0; k <= HARD_GRID; k++) {
        const x = await at(k / HARD_GRID);
        if (x === null) return null;
        grid.push(meetsGoal(s, x));
    }
    const flips = grid.slice(1).filter((x, k) => x !== grid[k]).length;
    if (grid.every(Boolean)) return 0;
    if (flips !== 1 || grid[0] || !grid[HARD_GRID]) return null;
    let [lo, hi] = [0, 1];
    for (let i = 0; i < BISECTIONS; i++) {
        const mid = (lo + hi) / 2;
        if (meetsGoal(s, await at(mid))) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
};

export const robustPrompt = (s, lever, current, limit, uncertain, value) => `Here is my model of the ${s.title.toLowerCase()}. Our goal is to ${s.goal.label}, and as things stand we miss it. One thing we control is "${lever}", now ${current}; realistically we could take it as far as ${limit}. How far would we have to take it, to what value, to just meet the goal? And "${uncertain}", now ${value}, is not known well: it could easily be ${100 * ROBUST_SHARE}% off either way. How far would we have to take "${lever}" to be sure of meeting the goal however "${uncertain}" turns out, within that ${100 * ROBUST_SHARE}%? Please work these out with the model and give me the answers; don't change the model itself.`;

/**
 * The second hard group's case for one scenario, or null when no lever and uncertain quantity qualify.
 * @param {Object} s A scenario from the library
 * @returns {Promise<Object|null>}
 */
export const generateRobustCase = async function(s) {
    if (!s.goal || !s.realistic?.bounds || !s.protected) return null;
    const model = scenarioModel(s);
    const base0 = await measureOf(s, null);
    if (base0 === null || meetsGoal(s, base0)) return null;
    const uncertain = [];
    for (const name of s.protected.variables) {
        const v = findVariable(model.variables, name);
        if (!v || v.type === 'stock' || !isNumericEquation(v.equation) || Number(v.equation) === 0) continue;
        if (uncertain.some((u) => u.name === v.name)) continue;
        const value = Number(v.equation);
        const moved = [await measureOf(s, { [v.name]: String(value * (1 - ROBUST_SHARE)) }), await measureOf(s, { [v.name]: String(value * (1 + ROBUST_SHARE)) })];
        if (moved.some((x) => x === null)) continue;
        uncertain.push({ name: v.name, value, swing: Math.max(...moved.map((x) => Math.abs(x - base0))) / Math.max(Math.abs(base0), 1e-9) });
    }
    uncertain.sort((a, b) => b.swing - a.swing || a.name.localeCompare(b.name));
    for (const [name, bound] of Object.entries(s.realistic.bounds)) {
        const v = findVariable(model.variables, name);
        if (!v || v.type === 'stock' || !isNumericEquation(v.equation)) continue;
        const current = Number(v.equation);
        for (const limit of [bound.max, bound.min]) {
            if (limit === undefined || limit === current) continue;
            const share = await crossingShare(s, v.name, current, limit, {});
            if (share === null || share < HARD_CROSSING[0] || share > HARD_CROSSING[1]) continue;
            for (const u of uncertain) {
                if (u.name === v.name) continue;
                const shares = [];
                for (const f of ROBUST_FACTORS) shares.push(await crossingShare(s, v.name, current, limit, { [u.name]: String(u.value * f) }));
                if (shares.some((x) => x === null)) continue;
                const [lowEnd, highEnd] = [shares[0], shares[shares.length - 1]];
                const robust = Math.max(...shares);
                if (robust !== lowEnd && robust !== highEnd) continue;
                const other = robust === lowEnd ? highEnd : lowEnd;
                if (robust - share <= 2 * HARD_LEVER_TOLERANCE || robust - other <= 2 * HARD_LEVER_TOLERANCE || robust > ROBUST_MAX_SHARE) continue;
                const value = (f) => Number((current + (limit - current) * f).toPrecision(6));
                return {
                    name: `${s.title}: how far, and how far to be sure`, scenario: s.id, kind: 'robust', lever: v.name, current, limit,
                    uncertain: u.name, uncertainValue: u.value, adverseFactor: robust === lowEnd ? ROBUST_FACTORS[0] : ROBUST_FACTORS[ROBUST_FACTORS.length - 1],
                    prompt: robustPrompt(s, v.name, current, limit, u.name, u.value),
                    crossing: value(share), crossingShare: share, robustCrossing: value(robust), robustShare: robust, otherCrossing: value(other), otherShare: other
                };
            }
        }
    }
    return null;
};
