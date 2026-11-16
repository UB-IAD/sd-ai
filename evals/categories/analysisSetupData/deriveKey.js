/**
 * The general rule that gives the analysis setup key for any scenario, so a new scenario needs no
 * entry of its own. The measure is the scenario's goal measure on its goal variable. Every constant
 * of the glossary model is swept ±50% and ±20%:
 *   - influential: the largest top group (one to four parameters, leaving at least one outside)
 *     whose weakest member moves the measure at least 20% at ±50% and at least STANDOUT times as
 *     much as any parameter outside it, at both sweep sizes
 *   - negligible: moves the measure by under 10% at ±50%
 *   - ungraded: a parameter whose change throws a model that starts in balance out of balance at the
 *     first step (its stocks start at typed-in values computed from no parameter, so changing it
 *     mostly moves the start rather than the response the measure is about)
 * A scenario with no such top group has no influential key and is left out of the category.
 */

import { glossaryModel } from '../../utilities/scenarios/renameModel.js';
import { simulateModel } from '../../utilities/simulateModel.js';
import { runSweep } from '../../utilities/simulator/sensitivity.js';
import { findVariable, isNumericEquation } from '../../utilities/modelDiff.js';

export const STANDOUT = 1.5;
export const NEGLIGIBLE = 0.1;
export const MAX_INFLUENTIAL = 4;
const BALANCE = 1e-6;

/** The goal variable's glossary name, and the goal measure as a function of a series and its times. */
export const measureFor = function(s) {
    const output = Object.entries(s.glossaryToModel).find(([, m]) => m === s.goal.variable)?.[0] ?? s.goal.variable;
    const { measure, time } = s.goal;
    if (measure === 'max') return { output, label: `the peak of the ${output} (the highest it gets over the run)`, of: (series) => Math.max(...series) };
    if (measure === 'overshoot') return { output, label: `how far the ${output} overshoots the level it finally settles at (its peak minus its final value)`, of: (series) => Math.max(...series) - series[series.length - 1] };
    return { output, label: `the ${output} at ${s.timeUnits === 'months' ? 'month' : s.timeUnits === 'weeks' ? 'week' : 'time'} ${time}`, of: (series, times) => series[times.findIndex((t) => t >= time - 1e-9)] };
};

const constantsOf = (model) => model.variables.filter((v) => v.type !== 'stock' && isNumericEquation(v.equation) && Number(v.equation) !== 0).map((v) => ({ name: v.name, value: Number(v.equation) }));

/** Whether a model's stocks barely move over the first few steps. */
const balancedAtStart = async function(model, overrides) {
    const stocks = model.variables.filter((v) => v.type === 'stock').map((v) => v.name);
    const run = await simulateModel(model, stocks, overrides);
    if (!run.ok) return false;
    const k = Math.min(4, run.time.length - 1);
    return stocks.every((n) => Math.abs(run.series[n][k] - run.series[n][0]) <= BALANCE * Math.max(1, Math.abs(run.series[n][0])));
};

export const swingsFor = async function(model, output, of, share) {
    const params = constantsOf(model).map((c) => ({ name: c.name, values: [c.value * (1 - share), c.value * (1 + share)] }));
    const sweep = await runSweep(model, [output], params);
    const base = of(sweep.base.series[output], sweep.base.time);
    const out = {};
    for (const p of params) {
        const values = sweep.runs.filter((r) => r.parameter === p.name && r.ok).map((r) => of(r.series[output], r.time));
        out[p.name] = (Math.max(base, ...values) - Math.min(base, ...values)) / Math.max(Math.abs(base), 1e-12);
    }
    return out;
};

/** The key for one scenario, by the general rule. */
export const deriveKey = async function(s) {
    const model = { ...glossaryModel(s), specs: s.model.specs };
    const m = measureFor(s);
    const output = findVariable(model.variables, m.output).name;
    const ungraded = [];
    if (await balancedAtStart(model, null)) {
        for (const c of constantsOf(model)) if (!(await balancedAtStart(model, { [c.name]: String(c.value * 1.2) }))) ungraded.push(c.name);
    }
    const [w50, w20] = [await swingsFor(model, output, m.of, 0.5), await swingsFor(model, output, m.of, 0.2)];
    const graded = Object.keys(w50).filter((n) => !ungraded.includes(n));
    const ranked = [...graded].sort((a, b) => w50[b] - w50[a]);
    let influential = [];
    // A group must leave something outside it to stand out from.
    for (let k = Math.min(MAX_INFLUENTIAL, ranked.length - 1); k >= 1; k--) {
        const top = ranked.slice(0, k);
        const rest = graded.filter((n) => !top.includes(n));
        const strong = top.every((n) => w50[n] >= 2 * NEGLIGIBLE);
        const stands = strong && [w50, w20].every((w) => Math.min(...top.map((n) => w[n])) >= STANDOUT * Math.max(0, ...rest.map((n) => w[n])));
        if (stands) { influential = top; break; }
    }
    const negligible = graded.filter((n) => w50[n] < NEGLIGIBLE && !influential.includes(n));
    return { output: m.output, label: m.label, influential, negligible, ungraded };
};
