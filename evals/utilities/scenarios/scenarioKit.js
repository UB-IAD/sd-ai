/**
 * Answer keys for hidden scenarios (see library.js), computed by simulation.
 *
 * Two questions recur across the conversation evals:
 *   - what does the hidden system do? Each key variable's shape over the run.
 *   - which facts matter? Ablation: run the hidden model with one mechanism switched off and see
 *     whether the behavior the problem is about changes.
 *
 * "Matters" is decided with a margin, as long_running_experiment insists, so no key rests on a
 * judgment call: a mechanism matters when switching it off changes a key variable's shape, or moves
 * its peak or final value by at least MATTERS_CHANGE; it does not matter when no shape changes and
 * every peak and final value moves by less than IRRELEVANT_CHANGE; anything between is ambiguous,
 * and categories ask nothing about it.
 *
 * @module utilities/scenarios/scenarioKit
 */

import { simulateModel } from '../simulateModel.js';
import { shapeOf } from '../shape.js';

export const MATTERS_CHANGE = 0.25;
export const IRRELEVANT_CHANGE = 0.10;

const peak = (s) => Math.max(...s);
const final = (s) => s[s.length - 1];
const relativeChange = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-9);

/**
 * Compute a scenario's key.
 * @param {Object} scenario A scenario from library.js
 * @returns {Promise<{shapes: Object<string, string>, mechanisms: Object<string, {verdict: string, shapes: Object<string, string>, change: number}>}>}
 *   `shapes` by key-variable model name; each mechanism's verdict is 'matters', 'irrelevant' or 'ambiguous'
 */
export const computeKey = async function(scenario) {
    const names = scenario.keyVariables.map((k) => k.model);
    const base = await simulateModel(scenario.model, names, null);
    if (!base.ok) throw new Error(`${scenario.id}: the hidden model failed to simulate: ${base.error}`);
    const shapes = Object.fromEntries(names.map((n) => [n, shapeOf(base.series[n])]));
    const mechanisms = {};
    for (const mechanism of scenario.mechanisms) {
        const run = await simulateModel(scenario.model, names, mechanism.off);
        if (!run.ok) throw new Error(`${scenario.id}: switching off "${mechanism.id}" broke the model: ${run.error}`);
        const offShapes = Object.fromEntries(names.map((n) => [n, shapeOf(run.series[n])]));
        const shapeChanged = names.some((n) => offShapes[n] !== shapes[n]);
        const change = Math.max(...names.flatMap((n) => [
            relativeChange(peak(run.series[n]), peak(base.series[n])),
            relativeChange(final(run.series[n]), final(base.series[n]))
        ]));
        const verdict = shapeChanged || change >= MATTERS_CHANGE ? 'matters' : change < IRRELEVANT_CHANGE ? 'irrelevant' : 'ambiguous';
        mechanisms[mechanism.id] = { verdict, shapes: offShapes, change };
    }
    return { shapes, mechanisms };
};

/**
 * Whether a policy meets a scenario's goal in the hidden simulation, and by how much.
 * @param {Object} scenario A scenario with `goal`
 * @param {Object<string, string>|null} overrides The policy's equation overrides (null for no policy)
 * @returns {Promise<{value: number, meets: boolean, margin: number}>} The goal measure, whether it
 *   meets the threshold, and its distance from the threshold as a share of the threshold
 */
export const evaluatePolicy = async function(scenario, overrides) {
    const { variable, measure, time, threshold, direction } = scenario.goal;
    const run = await simulateModel(scenario.model, [variable], overrides);
    if (!run.ok) throw new Error(`${scenario.id}: a policy run failed: ${run.error}`);
    const series = run.series[variable];
    let value;
    if (measure === 'max') value = Math.max(...series);
    else if (measure === 'overshoot') value = Math.max(...series) - series[series.length - 1];
    else {
        const index = run.time.findIndex((t) => t >= time - 1e-9);
        value = series[index];
    }
    const meets = direction === 'below' ? value < threshold : value > threshold;
    return { value, meets, margin: Math.abs(value - threshold) / Math.abs(threshold) };
};

/**
 * Resolve an experiment against a variant: values written '*k' multiply that parameter's value as
 * it stands in the variant (or in the hidden model, if the variant leaves it alone).
 * @param {Object} scenario A scenario
 * @param {Object<string, string>} variant The variant's overrides
 * @param {Object<string, string>} experiment The experiment's overrides
 * @returns {Object<string, string>} The combined overrides
 */
export const resolveExperiment = function(scenario, variant, experiment) {
    const out = { ...variant };
    for (const [name, value] of Object.entries(experiment)) {
        if (String(value).startsWith('*')) {
            const factor = Number(String(value).slice(1));
            const current = out[name] ?? scenario.model.variables.find((v) => v.name === name)?.equation;
            if (current === undefined || !Number.isFinite(factor)) throw new Error(`${scenario.id}: cannot scale "${name}" by "${value}"`);
            // A number is scaled; an expression (a ramping campaign, say) is multiplied as a whole.
            out[name] = Number.isFinite(Number(current)) ? String(Number(current) * factor) : `(${current}) * ${factor}`;
        } else out[name] = value;
    }
    return out;
};

/** An experiment discriminates when its effects under the two accounts differ by this much. */
export const DISCRIMINATES = 0.25;
/** ...and clearly does not when they differ by less than this. */
export const DOES_NOT_DISCRIMINATE = 0.10;

/**
 * The effect of an experiment on the goal measure under each perspective's variant.
 * @param {Object} scenario A scenario with `perspectives` and `goal`
 * @param {Object} experiment An experiment
 * @returns {Promise<{effects: Array<number>, difference: number}>} Relative effect per perspective
 */
export const experimentEffects = async function(scenario, experiment) {
    const effects = [];
    for (const p of scenario.perspectives) {
        const base = await evaluatePolicy(scenario, p.variant);
        const run = await evaluatePolicy(scenario, resolveExperiment(scenario, p.variant, experiment.overrides));
        effects.push((run.value - base.value) / Math.max(Math.abs(base.value), 1e-9));
    }
    return { effects, difference: Math.abs(effects[0] - effects[1]) };
};
