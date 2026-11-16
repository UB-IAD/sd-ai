/**
 * The general rule that makes equilibrium cases for every scenario in the library.
 *
 * The model is the scenario's glossary model over its own run settings — or, for a scenario whose
 * only time functions are STEPs, its post-step model (every STEP(height, time) replaced by its
 * height, the model as it stands once every step has happened). A scenario with any other time
 * function (TIME, RAMP, PULSE, DELAY, SMOOTH) gets no case, since nothing can be held still. The equilibrium is found by running the model
 * HORIZONS times as long and taking where every stock ends up; it is kept only if:
 *   - starting every stock there holds each within SOLUTION_MARGIN of its start over the whole run
 *     (well inside the category's tolerance), and
 *   - the model as given is out of equilibrium (some stock moves by more than the tolerance), and
 *   - the equilibrium is not trivial: some stock sits above zero there.
 * The engine may change the stocks' initial values only, every stock must be held, and the largest
 * stock must keep at least NON_TRIVIAL of its equilibrium value, so emptying the model fails.
 *
 * @module categories/equilibriumData/generate
 */

import { glossaryModel } from '../../utilities/scenarios/renameModel.js';
import { simulateModel } from '../../utilities/simulateModel.js';

/** The category's tolerance (equilibrium.js RELATIVE_TOLERANCE; a unit test keeps them equal). */
export const RELATIVE_TOLERANCE = 0.02;
export const HORIZONS = 20;
export const SOLUTION_MARGIN = 0.005;
export const NON_TRIVIAL = 0.5;
const TIME_FUNCTIONS = /\b(TIME|STEP|RAMP|PULSE|DELAY\w*|SMTH\w*|SMOOTH\w*)\b/i;

/** The scenario's glossary model over its own run settings. */
export const scenarioModel = (s) => ({ ...glossaryModel(s), specs: s.model.specs });

const STEP_CALL = /\bSTEP\s*\(\s*([^,()]+?)\s*,\s*([^()]+?)\s*\)/gi;

/**
 * A model whose only time functions are STEPs, with every STEP(height, time) replaced by its height:
 * the model as it stands after every step has happened. Null if it has other time functions.
 */
export const postStepModel = function(model) {
    const m = structuredClone(model);
    for (const v of m.variables) v.equation = String(v.equation ?? '').replace(STEP_CALL, '($1)');
    return m.variables.some((v) => TIME_FUNCTIONS.test(String(v.equation))) ? null : m;
};

/** The model a case is built on: the scenario's, or its post-step model. */
export const caseModel = (s, postStep) => (postStep ? postStepModel(scenarioModel(s)) : scenarioModel(s));

const stocksOf = (m) => m.variables.filter((v) => v.type === 'stock').map((v) => v.name);

/** The largest move of any stock from its start, relative to that start. */
const largestMove = async function(model) {
    const stocks = stocksOf(model);
    const run = await simulateModel(model, stocks, null);
    if (!run.ok) return null;
    let worst = 0;
    for (const n of stocks) {
        const x = run.series[n];
        if (!x.every(Number.isFinite)) return null;
        const band = Math.max(Math.abs(x[0]), 1e-9);
        for (const v of x) worst = Math.max(worst, Math.abs(v - x[0]) / band);
    }
    return worst;
};

/**
 * The generated case for one scenario, or null.
 * @param {Object} s A scenario from the library
 * @returns {Promise<Object|null>} `{name, group, scenario, description, adjustable, equilibriumStocks, solution, nonTrivial}`
 */
export const generateCase = async function(s) {
    const steps = scenarioModel(s).variables.some((v) => TIME_FUNCTIONS.test(String(v.equation ?? '')));
    const model = caseModel(s, steps);
    if (!model) return null;
    const stocks = stocksOf(model);
    const given = await largestMove(model);
    if (given === null || given <= RELATIVE_TOLERANCE) return null;

    const { startTime, stopTime } = model.specs;
    const long = await simulateModel({ ...model, specs: { ...model.specs, stopTime: startTime + HORIZONS * (stopTime - startTime) } }, stocks, null);
    if (!long.ok) return null;
    const ends = Object.fromEntries(stocks.map((n) => [n, long.series[n][long.series[n].length - 1]]));
    const scale = Math.max(...Object.values(ends).map(Math.abs));
    // A stock that has all but emptied is written as zero, not 1e-45.
    const solution = Object.fromEntries(stocks.map((n) => [n, Math.abs(ends[n]) < 1e-6 * scale ? '0' : String(Number(ends[n].toPrecision(6)))]));
    if (Object.values(solution).some((v) => !Number.isFinite(Number(v)) || Number(v) < 0)) return null;

    const held = structuredClone(model);
    for (const n of stocks) held.variables.find((v) => v.name === n).equation = solution[n];
    const move = await largestMove(held);
    if (move === null || move > SOLUTION_MARGIN) return null;

    const biggest = stocks.reduce((a, n) => (Number(solution[n]) > Number(solution[a]) ? n : a), stocks[0]);
    if (!(Number(solution[biggest]) > 0)) return null;
    return {
        name: steps ? `${s.title} (after its steps)` : `${s.title}`,
        group: 'scenarioEquilibrium',
        scenario: s.id,
        description: `the ${s.title.toLowerCase()}`,
        ...(steps ? { postStep: true } : {}),
        adjustable: stocks,
        equilibriumStocks: stocks,
        solution,
        nonTrivial: { [biggest]: Number((NON_TRIVIAL * Number(solution[biggest])).toPrecision(4)) }
    };
};
