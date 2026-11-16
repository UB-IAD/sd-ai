/**
 * One-at-a-time sensitivity sweeps over an sd-json model.
 *
 * Each parameter is set to each of its values in turn, with everything else at base, and the
 * model is re-run through PySD. Overrides are applied to the sd-json before XMILE conversion
 * (see simulateModel), so PySD itself is never touched.
 *
 * The categories that use this build their answer keys from it offline and commit them, so an
 * eval run never re-simulates the key; the eval-mode analysis tools also call it live when an
 * agent asks for a sweep.
 *
 * @module utilities/simulator/sensitivity
 */

import { simulateModel } from '../simulateModel.js';
import { classifyShape, FLAT_SHARE, TURN_SHARE } from '../shape.js';

/**
 * Sample a series at evenly spaced points so a sweep can be shown compactly.
 * @param {Array<number>} time Run times
 * @param {Array<number>} values Run values
 * @param {number} points How many samples, including both ends
 * @returns {{time: Array<number>, values: Array<number>}} The samples
 */
export const sampleSeries = function(time, values, points) {
    const indices = Array.from({ length: points }, (_, i) => Math.round((i * (time.length - 1)) / (points - 1)));
    return { time: indices.map((i) => time[i]), values: indices.map((i) => values[i]) };
};

/**
 * Run a one-at-a-time sweep.
 *
 * @param {Object} model A bare sd-json model
 * @param {Array<string>} outputs Variables to record
 * @param {Array<{name: string, values: Array<number>}>} parameters Parameters and the values to try
 * @returns {Promise<{base: Object, runs: Array<{parameter: string, value: number, ok: boolean, error?: string, time?: Array<number>, series?: Object}>}>}
 */
export const runSweep = async function(model, outputs, parameters) {
    const base = await simulateModel(model, outputs, null);
    const runs = [];
    for (const parameter of parameters) {
        for (const value of parameter.values) {
            const result = await simulateModel(model, outputs, { [parameter.name]: value });
            runs.push(result.ok
                ? { parameter: parameter.name, value, ok: true, time: result.time, series: result.series }
                : { parameter: parameter.name, value, ok: false, error: result.error });
        }
    }
    return { base, runs };
};

/**
 * Summarize a sweep for one output: how far each parameter moves a metric of the output, and
 * whether any of its values changes the output's shape.
 *
 * @param {Object} sweep A result of {@link runSweep}
 * @param {string} output The output variable to summarize
 * @param {function(Array<number>): number} metric Reduces a series to the number compared (final value, peak, ...)
 * @returns {Array<{parameter: string, swing: number, shapes: Array<string>, shapeChanges: boolean, sameTurns: boolean}>}
 *   One entry per parameter, sorted by swing, largest first. `swing` is the metric's spread over
 *   the parameter's values as a share of the base run's metric.
 */
export const summarizeSweep = function(sweep, output, metric) {
    const baseValue = metric(sweep.base.series[output]);
    const base = classifyShape(sweep.base.series[output], FLAT_SHARE, TURN_SHARE);
    const byParameter = new Map();
    for (const run of sweep.runs.filter((r) => r.ok)) {
        if (!byParameter.has(run.parameter)) byParameter.set(run.parameter, []);
        byParameter.get(run.parameter).push(run);
    }
    return [...byParameter.entries()].map(([parameter, runs]) => {
        const values = [baseValue, ...runs.map((r) => metric(r.series[output]))];
        const labels = runs.map((r) => classifyShape(r.series[output], FLAT_SHARE, TURN_SHARE));
        return {
            parameter,
            swing: (Math.max(...values) - Math.min(...values)) / Math.max(Math.abs(baseValue), 1e-12),
            shapes: labels.map((l) => l.shape),
            // The shape label itself changes: rising becomes rises-then-falls, oscillating becomes rising.
            shapeChanges: labels.some((l) => l.shape !== base.shape),
            // Not even the number of turning points changes. Only then is "only the size changed" a
            // safe answer: an oscillation that damps out or gains a swing is fairly called a change
            // of shape by a modeler, even though its label stays "oscillating".
            sameTurns: labels.every((l) => l.turns === base.turns)
        };
    }).sort((a, b) => b.swing - a.swing);
};
