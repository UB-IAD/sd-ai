/**
 * The analysis setup hard group's second, dependent answer: how far the measure could range if each
 * parameter that matters most were off by up to RANGE_SHARE either way, one at a time.
 *
 * The truth is simulated: each influential parameter of the key is run at RANGE_FACTORS of its value
 * (from 1 - RANGE_SHARE to 1 + RANGE_SHARE in tenths), and the range is the lowest and highest the
 * measure reaches over those runs and the base run. The analysis tools show a run's series at
 * SHOWN_POINTS evenly spaced times, so a peak or a value at a time read off a tool's output can
 * differ a little from the full run; each end is recorded both ways (`exact`, `shown`), and an
 * answer counts when it is within RANGE_TOLERANCE of the end's own size of either. Adding a
 * parameter outside the key's influential ones does not move either end in any scenario (the unit
 * tests check it), so the answer does not hang on exactly which parameters the agent counts as
 * mattering, as long as it counts those that do.
 *
 * @module categories/analysisSetupData/hardRange
 */

import { glossaryModel } from '../../utilities/scenarios/renameModel.js';
import { simulateModel } from '../../utilities/simulateModel.js';
import { sampleSeries } from '../../utilities/simulator/sensitivity.js';
import { findVariable } from '../../utilities/modelDiff.js';

export const RANGE_SHARE = 0.5;
export const RANGE_FACTORS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.1, 1.2, 1.3, 1.4, 1.5];
export const RANGE_TOLERANCE = 0.10;
/** How many evenly spaced points of a run the analysis tools show (utilities/analysisTools.js). */
export const SHOWN_POINTS = 21;

const sig = (x) => Number(Number(x).toPrecision(6));

/**
 * The measure on a run with overrides, from the full run and as the tools show it.
 * @returns {Promise<{exact: number, shown: number}|null>}
 */
export const measureRun = async function(s, output, of, overrides) {
    const m = { ...glossaryModel(s), specs: s.model.specs };
    const run = await simulateModel(m, [output], overrides);
    if (!run.ok) return null;
    const shown = sampleSeries(run.time, run.series[output], Math.min(SHOWN_POINTS, run.time.length));
    return { exact: of(run.series[output], run.time), shown: of(shown.values, shown.time) };
};

/**
 * The range of the measure over some parameters, each varied one at a time.
 * @param {Object} s A scenario from the library
 * @param {string} output The measured variable (glossary name)
 * @param {function} of The measure, of a series and its times
 * @param {Array<string>} parameters The parameters to vary (the key's influential ones, for the truth)
 * @returns {Promise<{low: {exact: number, shown: number}, high: {exact: number, shown: number}, base: number}>}
 */
export const rangeOver = async function(s, output, of, parameters) {
    const m = glossaryModel(s);
    const name = findVariable(m.variables, output).name;
    const base = await measureRun(s, name, of, null);
    const runs = [base];
    for (const p of parameters) {
        const v = findVariable(m.variables, p);
        for (const f of RANGE_FACTORS) {
            const r = await measureRun(s, name, of, { [v.name]: String(Number(v.equation) * f) });
            if (r) runs.push(r);
        }
    }
    const end = (pick) => ({ exact: sig(pick(...runs.map((r) => r.exact))), shown: sig(pick(...runs.map((r) => r.shown))) });
    return { low: end(Math.min), high: end(Math.max), base: sig(base.exact) };
};

/** Whether a stated end is within tolerance of the true one, read either way. */
export const endWithin = function(value, end) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    const [lo, hi] = [Math.min(end.exact, end.shown), Math.max(end.exact, end.shown)];
    const band = RANGE_TOLERANCE * Math.min(Math.abs(end.exact), Math.abs(end.shown));
    return value >= lo - band && value <= hi + band;
};
