/**
 * The general rule that makes mentalModelVsBug cases for every scenario in the library.
 *
 * Both kinds of case use the same report, so its wording says nothing about which it is: "When I
 * double X, Y ends the run only about N% higher (lower) than before. I expected doubling X to
 * roughly double (halve) Y." The difference is in the model:
 *   - expectation: the correct model, in which doubling the constant X really moves the stock Y's
 *     end value by only N% (between MIN_CHANGE and MAX_RISE up, or MIN_CHANGE and MAX_FALL down).
 *   - bug: the correct model with one error planted by the guidedCorrection rule, in which doubling
 *     X moves Y by only N%, while in the correct model it really does roughly double (halve) Y
 *     (the end ratio within PROPORTIONAL of 2, or of 0.5).
 * Stocks are tried goal's stock first, then in model order; constants by how far doubling them
 * moves the stock; planted errors in model order. A scenario gives up to PAIRS pairs — each bug a
 * different planted variable and reports doubling a different constant, each expectation a constant no bug
 * of the scenario reports — and always as many bugs as expectations, so the two kinds stay balanced. Each check is an end-ratio band, stored as data (see holdsFor): for the
 * expectation, around the reported N%, holding in the correct model; for the bug, around the
 * proportional ratio, holding in the correct model and failing in the planted one.
 *
 * @module categories/mentalModelVsBugData/generate
 */

import { simulateModel } from '../../utilities/simulateModel.js';
import { findVariable, isNumericEquation } from '../../utilities/modelDiff.js';
import { correctModel, candidatesFor, plant, deviation, MIN_DEVIATION } from '../guidedCorrectionData/generate.js';

export const MIN_CHANGE = 0.05;
export const MAX_RISE = 0.6;
export const MAX_FALL = 0.4;
const spaced = (id) => id.replace(/_/g, ' ');

const reading = (series, time) => ({
    series,
    last: (n) => series[n][series[n].length - 1],
    at: (n, t) => series[n][time.findIndex((x) => x >= t - 1e-9)]
});

/**
 * The `holds(run, base)` function of a check written as data. Tests:
 *   - startsLower {variable}: the variable starts lower in the run than in the base run
 *   - endsBelow / endsAbove {variable, value}: the variable ends below or above a value
 *   - endRatio {variable, min, max}: the variable's end in the run over its end in the base run
 */
export const holdsFor = function(test) {
    switch (test.type) {
        case 'startsLower': return (r, base) => r.at(test.variable, 0) < base.at(test.variable, 0);
        case 'endsBelow': return (r) => r.last(test.variable) < test.value;
        case 'endsAbove': return (r) => r.last(test.variable) > test.value;
        case 'endRatio': return (r, base) => { const x = r.last(test.variable) / base.last(test.variable); return x >= test.min && x <= test.max; };
        default: throw new Error(`Unknown check ${test.type}`);
    }
};

/** Whether a check written as data holds in a model. */
export const checkHolds = async function(model, check) {
    const r = await simulateModel(model, check.outputs, check.overrides || null);
    const base = await simulateModel(model, check.outputs, null);
    return r.ok && base.ok && holdsFor(check.test)(reading(r.series, r.time), reading(base.series, base.time));
};

const endOf = async (model, name, overrides) => {
    const r = await simulateModel(model, [name], overrides || null);
    return r.ok && Number.isFinite(r.series[name][r.series[name].length - 1]) ? r.series[name][r.series[name].length - 1] : null;
};

export const PROPORTIONAL = 0.15;
export const PAIRS = 2;
export const isOnly = (ratio) => (ratio - 1 >= MIN_CHANGE && ratio - 1 <= MAX_RISE) || (1 - ratio >= MIN_CHANGE && 1 - ratio <= MAX_FALL);

/** The end ratio of a stock when a constant is doubled, or null. */
export const doublingRatio = async function(model, stock, constant) {
    const base = await endOf(model, stock);
    const value = Number(findVariable(model.variables, constant).equation);
    const doubled = await endOf(model, stock, { [constant]: String(value * 2) });
    return base && doubled !== null && Math.abs(base) > 1e-9 ? doubled / base : null;
};

export const report = (constant, stock, ratio) => {
    const up = ratio > 1;
    return `When I double "${constant}", "${stock}" ends the run only about ${Math.round(100 * Math.abs(ratio - 1))}% ${up ? 'higher' : 'lower'} than before. I expected doubling "${constant}" to roughly ${up ? 'double' : 'halve'} "${stock}".`;
};

/** An end-ratio band of plus or minus two percentage points around a reported change. */
const reportedBand = (ratio) => {
    const pct = Math.round(100 * Math.abs(ratio - 1));
    return ratio > 1 ? { min: 1 + (pct - 2) / 100, max: 1 + (pct + 2) / 100 } : { min: 1 - (pct + 2) / 100, max: 1 - (pct - 2) / 100 };
};

/**
 * The generated cases for one scenario, by the general rule: a bug and an expectation, or none.
 * @param {Object} s A scenario from the library
 * @returns {Promise<Array<Object>>} Cases `{name, scenario, kind, description, error?, plant?, report, check}`
 */
export const generateCases = async function(s) {
    const correct = correctModel(s);
    const description = `the ${s.title.toLowerCase()}`;
    const goal = findVariable(correct.variables, Object.entries(s.glossaryToModel).find(([, m]) => m === s.goal.variable)?.[0] ?? s.goal.variable);
    const stocks = [...(goal?.type === 'stock' ? [goal] : []), ...correct.variables.filter((v) => v.type === 'stock' && v !== goal)].map((v) => v.name);
    const constants = correct.variables.filter((v) => v.type !== 'stock' && isNumericEquation(v.equation) && Number(v.equation) > 0).map((v) => v.name);

    // Ratios in the correct model, for every stock and constant.
    const ratios = [];
    for (const stock of stocks) for (const constant of constants) {
        const ratio = await doublingRatio(correct, stock, constant);
        if (ratio !== null) ratios.push({ stock, constant, ratio });
    }
    const byStock = (list) => stocks.flatMap((st) => list.filter((x) => x.stock === st).sort((x, y) => Math.abs(y.ratio - 1) - Math.abs(x.ratio - 1) || x.constant.localeCompare(y.constant)));

    const expectations = byStock(ratios).filter((x) => isOnly(x.ratio));
    const proportional = byStock(ratios).filter((x) => Math.abs(x.ratio - 2) <= 2 * PROPORTIONAL || Math.abs(x.ratio - 0.5) <= 0.5 * PROPORTIONAL);
    const bugs = [];
    const usedErrors = new Set();
    const usedConstants = new Set();
    search: for (const e of candidatesFor(correct)) {
        if (bugs.length >= PAIRS) break;
        if (usedErrors.has(e.variable)) continue;
        const given = plant(correct, [e]);
        const d = await deviation(given, correct);
        if (d === null || d < MIN_DEVIATION) continue;
        for (const x of proportional) {
            if (usedConstants.has(x.constant)) continue;
            const planted = await doublingRatio(given, x.stock, x.constant);
            if (planted === null || !isOnly(planted) || (planted > 1) !== (x.ratio > 1)) continue;
            const band = x.ratio > 1 ? { min: 2 * (1 - PROPORTIONAL), max: 2 * (1 + PROPORTIONAL) } : { min: 0.5 * (1 - PROPORTIONAL), max: 0.5 * (1 + PROPORTIONAL) };
            const check = { outputs: [x.stock], overrides: { [x.constant]: String(Number(findVariable(correct.variables, x.constant).equation) * 2) }, test: { type: 'endRatio', variable: x.stock, ...band } };
            if (!(await checkHolds(correct, check)) || (await checkHolds(given, check))) continue;
            bugs.push({ name: `${s.title} (doubling ${x.constant}, bug in ${e.variable})`, scenario: s.id, kind: 'bug', description, error: { variable: e.variable, change: e.change }, plant: { variable: e.variable, fields: Object.keys(e.change) }, report: report(x.constant, x.stock, planted), check });
            usedErrors.add(e.variable);
            usedConstants.add(x.constant);
            continue search;
        }
    }
    // Expectations on constants no bug of this scenario reports, one per bug.
    const reported = new Set(bugs.map((b) => Object.keys(b.check.overrides)[0]));
    const chosen = [];
    for (const x of expectations) {
        if (chosen.length >= bugs.length) break;
        if (reported.has(x.constant) || chosen.some((c) => c.constant === x.constant)) continue;
        chosen.push(x);
    }
    const n = Math.min(bugs.length, chosen.length);
    const out = [];
    for (let i = 0; i < n; i++) {
        const x = chosen[i];
        const value = Number(findVariable(correct.variables, x.constant).equation);
        out.push(bugs[i], {
            name: `${s.title} (doubling ${x.constant})`, scenario: s.id, kind: 'expectation', description,
            report: report(x.constant, x.stock, x.ratio),
            check: { outputs: [x.stock], overrides: { [x.constant]: String(value * 2) }, test: { type: 'endRatio', variable: x.stock, ...reportedBand(x.ratio) } }
        });
    }
    return out;
};
