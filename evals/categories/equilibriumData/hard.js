/**
 * The general rule behind the equilibrium category's hard group, built on the generated scenario
 * cases: an equilibrium at a stated level, which the constant as it stands cannot give.
 *
 * For each scenario with a generated case (generate.js), one stock is to sit at a stated level that
 * its equilibrium does not have as the model stands: the level it settles at when one of the
 * scenario's management levers — a constant, not a stock — is moved by a factor (FACTORS, tried in
 * order). The stock is the one that lever moves most (relative to the larger of its two levels); it
 * must move by at least MIN_SHIFT and settle at MIN_LEVEL of the largest stock or more (not a
 * collapsed one), and setting the stock to that level with the constant as it stands must not hold
 * (the model must not have a range of resting points). The engine may change every stock's initial
 * value and any one constant of the model (oneConstantOf: every non-stock variable whose equation is
 * a number) — withheld feedback: the prompt does not name the lever, so the engine has to find which
 * constant moves the stock, and the value whose equilibrium puts it at the stated level, and hold
 * every stock there. The first lever and factor (in the
 * scenario's lever order) whose equilibrium is found and holds within SOLUTION_MARGIN qualifies; a
 * scenario with none gets no hard case. The stated level is given to three significant figures and
 * the known solution (every stock's equilibrium, and the constant's new value) to six. Frozen in
 * hardGenerated.json by buildHard.js; the unit tests re-derive it.
 *
 * @module categories/equilibriumData/hard
 */

import { simulateModel } from '../../utilities/simulateModel.js';
import { isNumericEquation } from '../../utilities/modelDiff.js';
import { generateCase, caseModel, HORIZONS, SOLUTION_MARGIN, RELATIVE_TOLERANCE } from './generate.js';

export const FACTORS = [1.5, 0.5];
export const MIN_SHIFT = 0.2;
/** The held stock must settle at no less than this share of the largest stock: not a collapsed one. */
export const MIN_LEVEL = 0.01;

const stocksOf = (m) => m.variables.filter((v) => v.type === 'stock').map((v) => v.name);
const sig = (x, n) => String(Number(Number(x).toPrecision(n)));

/** Every stock's level after a long run, or null when the run fails or a level is not finite. */
const longRunLevels = async function(model) {
    const stocks = stocksOf(model);
    const { startTime, stopTime } = model.specs;
    const run = await simulateModel({ ...model, specs: { ...model.specs, stopTime: startTime + HORIZONS * (stopTime - startTime) } }, stocks, null);
    if (!run.ok) return null;
    const ends = Object.fromEntries(stocks.map((n) => [n, run.series[n][run.series[n].length - 1]]));
    return Object.values(ends).every(Number.isFinite) ? ends : null;
};

/** The largest move of any stock from its start over the model's own run, relative to that start. */
const largestMove = async function(model) {
    const stocks = stocksOf(model);
    const run = await simulateModel(model, stocks, null);
    if (!run.ok) return null;
    let worst = 0;
    for (const n of stocks) {
        const x = run.series[n];
        if (!x.every(Number.isFinite)) return null;
        for (const v of x) worst = Math.max(worst, Math.abs(v - x[0]) / Math.max(Math.abs(x[0]), 1e-9));
    }
    return worst;
};

/**
 * The hard case for one scenario, or null.
 * @param {Object} s A scenario from the library
 * @returns {Promise<Object|null>} A case in the category's format, without its model
 */
export const hardCaseFor = async function(s) {
    const base = await generateCase(s);
    if (!base) return null;
    const model = caseModel(s, base.postStep);
    const stocks = stocksOf(model);
    const levers = (s.levers || []).map((l) => model.variables.find((v) => v.name.toLowerCase() === l.toLowerCase())).filter((v) => v && v.type !== 'stock' && isNumericEquation(v.equation) && Number(v.equation) !== 0);
    for (const lever of levers) {
        for (const factor of FACTORS) {
            const value = sig(Number(lever.equation) * factor, 6);
            const moved = structuredClone(model);
            moved.variables.find((v) => v.name === lever.name).equation = value;
            const ends = await longRunLevels(moved);
            if (!ends) continue;
            const scale = Math.max(...Object.values(ends).map(Math.abs));
            const levels = Object.fromEntries(stocks.map((n) => [n, Math.abs(ends[n]) < 1e-6 * scale ? '0' : sig(ends[n], 6)]));
            if (Object.values(levels).some((v) => Number(v) < 0)) continue;
            const atRest = structuredClone(moved);
            for (const n of stocks) atRest.variables.find((v) => v.name === n).equation = levels[n];
            const move = await largestMove(atRest);
            if (move === null || move > SOLUTION_MARGIN) continue;
            const shift = (n) => Math.abs(Number(levels[n]) - Number(base.solution[n])) / Math.max(Math.abs(Number(levels[n])), Math.abs(Number(base.solution[n])), 1e-12);
            const held = stocks.reduce((a, n) => (shift(n) > shift(a) ? n : a), stocks[0]);
            if (shift(held) < MIN_SHIFT || !(Number(levels[held]) >= MIN_LEVEL * scale)) continue;
            const target = Number(sig(levels[held], 3));
            // Only the moved constant may give that level: with the constant as it stands, the model
            // started at its own equilibrium but with the stock at the stated level must not stay
            // there (a model with a range of resting points, such as chairs that are never scrapped,
            // would let the stock simply be set to the level).
            const forced = structuredClone(model);
            for (const n of stocks) forced.variables.find((v) => v.name === n).equation = n === held ? String(target) : base.solution[n];
            const forcedMove = await largestMove(forced);
            if (forcedMove !== null && forcedMove <= RELATIVE_TOLERANCE) continue;
            return {
                name: `${base.name}, with "${held}" held at ${target}`,
                group: 'scenarioEquilibriumHard',
                scenario: s.id,
                description: base.description,
                ...(base.postStep ? { postStep: true } : {}),
                adjustable: stocks,
                // Withheld: the prompt does not say which constant to move. Any one of the model's
                // constants may change, the lever among them.
                oneConstantOf: model.variables.filter((v) => v.type !== 'stock' && isNumericEquation(v.equation)).map((v) => v.name),
                equilibriumStocks: stocks,
                fixedInitial: { [held]: target },
                frozen: `"${held}" must sit at ${target} in the equilibrium.`,
                solution: { ...levels, [lever.name]: value },
                lever: lever.name,
                factor
            };
        }
    }
    return null;
};
