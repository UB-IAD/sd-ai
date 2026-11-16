/**
 * The analysis setup second hard group's answer (analysisSetupHard2): how low and how high the
 * measure could go if every constant of the model were off by up to JOINT_SHARE either way, all at
 * the same time, in the worst combination.
 *
 * Each end is simulated: every constant is set to whichever end of its ±JOINT_SHARE range pushes the
 * measure that way on its own (the corner), and the corner is then improved coordinate by coordinate
 * over JOINT_STEPS of each range until no single change moves the measure further (at most
 * JOINT_PASSES passes). Both the corner and the improved end are recorded, each from the full run and
 * as the analysis tools show it (hardRange.js). An answer counts when it is within RANGE_TOLERANCE of
 * the band those four values span (of the smallest of them in size), so combining the worst cases
 * counts, and so does searching further.
 *
 * A scenario is taken only when the answer stands clear of easier ones:
 *   - neither end is near zero (under JOINT_MIN_SHARE of the base), where a tolerance that is a
 *     share of the end means nothing
 *   - both ends stand more than JOINT_CLEAR from the base run, and at least one more than JOINT_CLEAR
 *     beyond the one-at-a-time range (each constant moved alone over the same ±JOINT_SHARE), both
 *     measured from the nearer edge of its band, so neither the status quo nor the first hard
 *     group's level of answer comes within tolerance
 *   - every run simulates
 *
 * @module categories/analysisSetupData/jointRange
 */

import { glossaryModel } from '../../utilities/scenarios/renameModel.js';
import { findVariable, isNumericEquation } from '../../utilities/modelDiff.js';
import { measureRun, RANGE_TOLERANCE } from './hardRange.js';
import { measureFor } from './deriveKey.js';

export const JOINT_SHARE = 0.1;
export const JOINT_STEPS = [-1, -0.5, 0, 0.5, 1];
export const JOINT_PASSES = 3;
export const JOINT_MIN_SHARE = 0.1;
/** How far each end must stand from the one-at-a-time range and the base: twice the tolerance. */
export const JOINT_CLEAR = 0.2;

const sig = (x) => Number(Number(x).toPrecision(6));

/** The values an end's band spans: the corner and the improved end, each full and as shown. */
export const bandOf = (end) => [end.exact, end.shown, end.corner, end.cornerShown];

/** Whether a stated end is within tolerance of its band. */
export const jointEndWithin = function(value, end) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    const band = bandOf(end);
    const tolerance = RANGE_TOLERANCE * Math.min(...band.map(Math.abs));
    return value >= Math.min(...band) - tolerance && value <= Math.max(...band) + tolerance;
};

/** How far a value stands from an end's band, as a share of the band's nearer edge. */
export const distanceFromBand = function(value, end) {
    const band = bandOf(end);
    const nearest = band.reduce((a, b) => (Math.abs(b - value) < Math.abs(a - value) ? b : a));
    if (value >= Math.min(...band) && value <= Math.max(...band)) return 0;
    return Math.abs(value - nearest) / Math.max(Math.abs(nearest), 1e-12);
};

/** The constants the question covers: every non-stock variable whose equation is a non-zero number. */
export const jointConstants = (s) => glossaryModel(s).variables.filter((v) => v.type !== 'stock' && isNumericEquation(v.equation) && Number(v.equation) !== 0).map((v) => ({ name: v.name, value: Number(v.equation) }));

/**
 * The joint range for one scenario, and a reason when it is not taken.
 * @param {Object} s A scenario from the library
 * @returns {Promise<{low: Object, high: Object, base: number, oneAtATime: {low: number, high: number}, constants: number, skip?: string}|{skip: string}>}
 *   each end `{exact, shown, corner, cornerShown}`
 */
export const jointRange = async function(s) {
    const m = measureFor(s);
    const output = findVariable(glossaryModel(s).variables, m.output).name;
    const constants = jointConstants(s);
    const run = (factors) => measureRun(s, output, m.of, Object.fromEntries(Object.entries(factors).filter(([, f]) => f !== 1).map(([n, f]) => [n, String(constants.find((c) => c.name === n).value * f)])));
    const base = await run({});
    if (!base) return { skip: 'the model does not simulate' };
    const alone = {};
    for (const c of constants) {
        const [lo, hi] = [await run({ [c.name]: 1 - JOINT_SHARE }), await run({ [c.name]: 1 + JOINT_SHARE })];
        if (!lo || !hi) return { skip: `moving "${c.name}" by ${100 * JOINT_SHARE}% does not simulate` };
        alone[c.name] = [lo.exact, hi.exact];
    }
    const oneAtATime = { low: sig(Math.min(base.exact, ...Object.values(alone).flat())), high: sig(Math.max(base.exact, ...Object.values(alone).flat())) };
    const ends = {};
    for (const want of ['low', 'high']) {
        const further = (a, b) => (want === 'high' ? a > b : a < b) && Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(b));
        let point = Object.fromEntries(constants.map((c) => { const up = alone[c.name][1] >= alone[c.name][0]; return [c.name, (want === 'high') === up ? 1 + JOINT_SHARE : 1 - JOINT_SHARE]; }));
        const corner = await run(point);
        if (!corner) return { skip: 'the worst-case corner does not simulate' };
        let best = corner;
        for (let pass = 0; pass < JOINT_PASSES; pass++) {
            let moved = false;
            for (const c of constants) {
                for (const step of JOINT_STEPS) {
                    const f = 1 + step * JOINT_SHARE;
                    if (f === point[c.name]) continue;
                    const r = await run({ ...point, [c.name]: f });
                    if (r && further(r.exact, best.exact)) { best = r; point = { ...point, [c.name]: f }; moved = true; }
                }
            }
            if (!moved) break;
        }
        ends[want] = { exact: sig(best.exact), shown: sig(best.shown), corner: sig(corner.exact), cornerShown: sig(corner.shown) };
    }
    const out = { low: ends.low, high: ends.high, base: sig(base.exact), oneAtATime, constants: constants.length };
    for (const want of ['low', 'high']) if (bandOf(ends[want]).some((x) => Math.abs(x) < JOINT_MIN_SHARE * Math.abs(base.exact))) return { ...out, skip: `the ${want} end is near zero (under ${100 * JOINT_MIN_SHARE}% of the status quo)` };
    if (distanceFromBand(base.exact, ends.low) <= JOINT_CLEAR || distanceFromBand(base.exact, ends.high) <= JOINT_CLEAR) return { ...out, skip: `an end of the joint range is within ${100 * JOINT_CLEAR}% of the status quo` };
    if (distanceFromBand(oneAtATime.low, ends.low) <= JOINT_CLEAR && distanceFromBand(oneAtATime.high, ends.high) <= JOINT_CLEAR) return { ...out, skip: `neither end of the joint range stands more than ${100 * JOINT_CLEAR}% beyond the one-at-a-time range` };
    return out;
};
