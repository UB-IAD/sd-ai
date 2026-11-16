/**
 * The general rule that makes calibration cases for a scenario that has no hand-written ones.
 *
 * Every case is built on the scenario's glossary model and graded on the series of its goal
 * variable, over the scenario's own run settings.
 *
 * A parameters case moves two influential parameters: the constants are ranked by how much a ±50%
 * change moves the series (summed over the run), and pairs are tried in rank order — the first
 * scaled by PARAMETER_FACTORS[0], the second by PARAMETER_FACTORS[1] — until one gives data the
 * given model does not fit (R² below MISFIT) while calibrating the CALIBRATED most influential
 * parameters makes it fit (R² above FIT_MARGIN). In every case the truth itself must fit its data
 * (wobble included) with R² above TRUTH_FIT, so the data are not mostly wobble.
 *
 * A structure case adds one of three generic mechanisms the given model lacks, tried in order:
 *   - growth:   a steady input (a constant measured per unit of time, not a fraction) keeps
 *               growing, doubling over the history
 *   - seasonal: that input rises and falls with the seasons, three cycles over the history
 *   - leak:     the series' stock drains away on its own, through a loss the model leaves out
 * The first mechanism is kept whose data no calibration of the given model can fit (R² below
 * MISFIT after calibrating the same parameters), and whose two other mechanisms, as distractors,
 * the data rule out too: each one added to the given model and calibrated — its own strength
 * included — still fits below MISFIT. A scenario that cannot give two distractors this way gives
 * no structure case.
 *
 * @module categories/calibrationData/generate
 */

import { glossaryModel } from '../../utilities/scenarios/renameModel.js';
import { simulateModel } from '../../utilities/simulateModel.js';
import { findVariable, isNumericEquation } from '../../utilities/modelDiff.js';
import { runAnalysisTool } from '../../utilities/analysisTools.js';
import { runSweep } from '../../utilities/simulator/sensitivity.js';

export const PARAMETER_FACTORS = [1.5, 0.6];
export const CALIBRATED = 4;
export const MISFIT = 0.9;
export const FIT_MARGIN = 0.97;
export const TRUTH_FIT = 0.98;
const GROWTH_DOUBLINGS = 1;
const SEASONAL_SWING = 0.3;
const SEASONAL_CYCLES = 3;
const LEAK_LIFETIMES = 1;
const DATA_POINTS = 25;
const NOISE = 0.02;

const under = (n) => n.replace(/\s+/g, '_');
const singular = (u) => String(u || '').trim().replace(/s$/, '').toLowerCase();

const wobble = (i) => {
    const x = Math.sin(12.9898 * (i + 1) + 78.233) * 43758.5453;
    return 2 * (x - Math.floor(x)) - 1;
};

/** The scenario's glossary model over its own run settings. */
export const baseModel = (s) => ({ ...glossaryModel(s), specs: s.model.specs });

/** The glossary name of the scenario's goal variable. */
export const seriesFor = (s) => Object.entries(s.glossaryToModel).find(([, m]) => m === s.goal.variable)?.[0] ?? s.goal.variable;

const constantsOf = (model) => model.variables.filter((v) => v.type !== 'stock' && isNumericEquation(v.equation) && Number(v.equation) !== 0).map((v) => ({ name: v.name, value: Number(v.equation), units: v.units }));

/** Constants ranked by how much a ±50% change moves the series, summed over the run. */
export const rankedParameters = async function(model, series) {
    const params = constantsOf(model).map((c) => ({ name: c.name, values: [c.value * 0.5, c.value * 1.5] }));
    const sweep = await runSweep(model, [series], params);
    const base = sweep.base.series[series];
    const scale = Math.max(1e-12, ...base.map(Math.abs));
    const swing = {};
    for (const p of params) {
        const runs = sweep.runs.filter((r) => r.parameter === p.name && r.ok);
        swing[p.name] = runs.length ? Math.max(...runs.map((r) => r.series[series].reduce((a, v, i) => a + Math.abs(v - base[i]), 0) / base.length / scale)) : 0;
    }
    return Object.keys(swing).sort((a, b) => swing[b] - swing[a] || a.localeCompare(b));
};

/** Apply a case's changes to a model: `set` replaces fields of variables, `add` appends new ones. */
export const applyChanges = function(model, changes) {
    const m = structuredClone(model);
    for (const [name, fields] of Object.entries(changes.set || {})) Object.assign(findVariable(m.variables, name), fields);
    m.variables.push(...structuredClone(changes.add || []));
    return m;
};

/** The truth's run of the series, sampled, with the fixed ±2% wobble the hand-written cases use. */
export const sampledData = async function(model, series) {
    const run = await simulateModel(model, [series], null);
    if (!run.ok) return null;
    const out = [];
    for (let i = 0; i < DATA_POINTS; i++) {
        const k = Math.round((i * (run.time.length - 1)) / (DATA_POINTS - 1));
        out.push({ time: run.time[k], value: Number((run.series[series][k] * (1 + NOISE * wobble(i))).toPrecision(4)) });
    }
    return out;
};

const fitError = (time, values, data) => data.reduce((a, p) => {
    const k = time.findIndex((t) => t >= p.time - 1e-9);
    return a + (values[k] - p.value) ** 2;
}, 0);

/** R² of a model's series against data, with no calibration. */
export const plainFit = async function(model, series, data) {
    const run = await simulateModel(model, [series], null);
    if (!run.ok) return -Infinity;
    const mean = data.reduce((a, p) => a + p.value, 0) / data.length;
    const total = data.reduce((a, p) => a + (p.value - mean) ** 2, 0);
    return 1 - fitError(run.time, run.series[series], data) / Math.max(total, 1e-12);
};

/** R² after calibrating the named constants (each over a fifth to five times its value; an added strength from 0). */
export const calibratedFit = async function(model, series, data, names, fromZero) {
    const parameters = names.map((n) => {
        const v = Number(findVariable(model.variables, n).equation);
        return fromZero?.includes(n) ? { name: n, min: 0, max: Math.max(v * 5, 1e-9) } : { name: n, min: Math.min(v / 5, v * 5), max: Math.max(v / 5, v * 5) };
    });
    const fit = await runAnalysisTool('run_calibration', { parameters, variable: series, series }, model, { series: { [series]: data } });
    return fit.rSquared ?? -Infinity;
};

/** The steady input a growth or seasonal mechanism acts on: the most influential constant measured per unit of time. */
const steadyInput = function(model, ranked) {
    const per = singular(model.specs.timeUnits);
    return ranked.find((n) => {
        const u = String(findVariable(model.variables, n).units || '').toLowerCase().replace(/\s+/g, '');
        const [num, den] = u.split('/');
        return den !== undefined && singular(den) === per && num && num !== '1' && num !== 'dimensionless';
    });
};

/** The three generic mechanisms for a model: each `{id, mechanism, changes, strength}`, or null where it cannot apply. */
export const mechanismsFor = function(model, series, ranked) {
    const horizon = model.specs.stopTime - model.specs.startTime;
    const input = steadyInput(model, ranked);
    const stock = findVariable(model.variables, series);
    const out = {};
    if (input) {
        const v = findVariable(model.variables, input);
        const g = `${input} growth rate`;
        out.growth = {
            id: 'growth', strength: g,
            mechanism: `"${input}" keeps growing over time instead of staying steady.`,
            changes: { set: { [input]: { equation: `${v.equation} * EXP(${under(g)} * (TIME - ${model.specs.startTime}))` } }, add: [{ name: g, type: 'variable', equation: String(Number((GROWTH_DOUBLINGS * Math.LN2 / horizon).toPrecision(4))), units: `1/${singular(model.specs.timeUnits)}` }] }
        };
        const a = `${input} seasonal swing`;
        out.seasonal = {
            id: 'seasonal', strength: a,
            mechanism: `"${input}" rises and falls with the seasons, again and again.`,
            changes: { set: { [input]: { equation: `${v.equation} * (1 + ${under(a)} * SIN(2 * 3.14159 * (TIME - ${model.specs.startTime}) / ${Number((horizon / SEASONAL_CYCLES).toPrecision(4))}))` } }, add: [{ name: a, type: 'variable', equation: String(SEASONAL_SWING), units: 'dimensionless' }] }
        };
    }
    if (stock?.type === 'stock') {
        const f = `${series} loss fraction`;
        const flow = `${series} lost`;
        out.leak = {
            id: 'leak', strength: f,
            mechanism: `"${series}" drains away on its own over time, through a loss the model leaves out.`,
            changes: {
                set: { [stock.name]: { outflows: [...(stock.outflows || []), flow] } },
                add: [
                    { name: flow, type: 'flow', equation: `${under(stock.name)} * ${under(f)}`, units: `${stock.units}/${singular(model.specs.timeUnits)}` },
                    { name: f, type: 'variable', equation: String(Number((LEAK_LIFETIMES / horizon).toPrecision(4))), units: `1/${singular(model.specs.timeUnits)}` }
                ]
            }
        };
    }
    return out;
};

/**
 * The generated cases for one scenario, by the general rule.
 * @param {Object} s A scenario from the library, with its id
 * @returns {Promise<Array<Object>>} Cases: `{name, scenario, kind, series, changes, calibrated, parameters?, mechanism?, distractors?, distractorModels?}`
 */
export const generateCases = async function(s) {
    const model = baseModel(s);
    const series = seriesFor(s);
    if (!findVariable(model.variables, series)) return [];
    const ranked = await rankedParameters(model, series);
    const calibrated = ranked.slice(0, CALIBRATED);
    const out = [];

    pairs: for (let i = 0; i < Math.min(CALIBRATED, ranked.length); i++) {
        for (let j = i + 1; j < Math.min(CALIBRATED, ranked.length); j++) {
            const [p, q] = [ranked[i], ranked[j]];
            const value = (n, f) => String(Number((Number(findVariable(model.variables, n).equation) * f).toPrecision(4)));
            const changes = { set: { [p]: { equation: value(p, PARAMETER_FACTORS[0]) }, [q]: { equation: value(q, PARAMETER_FACTORS[1]) } } };
            const truth = applyChanges(model, changes);
            const data = await sampledData(truth, series);
            if (!data || (await plainFit(truth, series, data)) <= TRUTH_FIT || (await plainFit(model, series, data)) >= MISFIT) continue;
            if ((await calibratedFit(model, series, data, calibrated)) <= FIT_MARGIN) continue;
            out.push({ name: `${s.title}, parameters`, scenario: s.id, kind: 'parameters', series, changes, parameters: [p, q], calibrated });
            break pairs;
        }
    }

    const mechanisms = mechanismsFor(model, series, ranked);
    for (const id of ['growth', 'seasonal', 'leak']) {
        const m = mechanisms[id];
        if (!m) continue;
        const truth = applyChanges(model, m.changes);
        const data = await sampledData(truth, series);
        if (!data || (await plainFit(truth, series, data)) <= TRUTH_FIT || (await calibratedFit(model, series, data, calibrated)) >= MISFIT) continue;
        const others = Object.values(mechanisms).filter((x) => x.id !== id);
        if (others.length < 2) continue;
        let ruledOut = true;
        for (const d of others) {
            const dm = applyChanges(model, d.changes);
            if ((await calibratedFit(dm, series, data, [...calibrated, d.strength], [d.strength])) >= MISFIT) { ruledOut = false; break; }
        }
        if (!ruledOut) continue;
        out.push({ name: `${s.title}, ${id === 'leak' ? `${series} draining away` : id === 'growth' ? `growing ${m.strength.replace(/ growth rate$/, '')}` : `seasonal ${m.strength.replace(/ seasonal swing$/, '')}`}`, scenario: s.id, kind: 'structure', series, changes: m.changes, mechanism: m.mechanism, distractors: others.map((d) => d.mechanism), calibrated, distractorModels: others.map((d) => ({ mechanism: d.mechanism, strength: d.strength, changes: d.changes })) });
        break;
    }
    return out;
};
