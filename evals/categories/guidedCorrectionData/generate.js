/**
 * The general rule that makes guidedCorrection cases for a scenario that has no hand-written ones.
 *
 * The correct model is the scenario's glossary model over its own run settings. Errors are planted
 * by four general kinds, each a change to one variable:
 *   - timeConstant: a variable that divides by a constant measured in time ("x / delay", anywhere
 *     in its equation) multiplies by it instead, so a longer delay makes things faster
 *   - reversedGap:  a gap "(a - b)" is taken the wrong way round, "(b - a)"
 *   - disconnected: a flow that drains one stock and fills another is not connected to the stock
 *     it fills, so what leaves the first vanishes
 *   - missingOutflow: a flow that drains a stock into nowhere (out of the model) is not connected
 *     to that stock, so the stock never drains through it
 * A candidate error counts only if, alone, it moves some stock by at least MIN_DEVIATION of that
 * stock's largest value and the model still runs with finite values. A case plants two errors of
 * different kinds, chosen in a kind order that rotates from scenario to scenario (so the kinds
 * vary across models), each kind's candidates in model order. The two together must also run.
 *
 * Distractors are claims of the kinds not planted, made about variables where they are false (a
 * correct division said to need multiplying; a correctly connected flow said to be connected to a
 * stock it should not fill), so the judge is never handed only true problems.
 *
 * The extension request for the selfCorrection group is general too: an outflow that drains the
 * goal's stock (or the first stock) at a constant fraction per unit of time; the error left in the
 * model for that group is one that does not live in the stock the addition touches.
 *
 * @module categories/guidedCorrectionData/generate
 */

import { glossaryModel } from '../../utilities/scenarios/renameModel.js';
import { simulateModel, allFinite } from '../../utilities/simulateModel.js';
import { findVariable, isNumericEquation } from '../../utilities/modelDiff.js';

export const MIN_DEVIATION = 0.1;
export const KINDS = ['timeConstant', 'reversedGap', 'disconnected', 'missingOutflow'];

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/;
const spaced = (id) => id.replace(/_/g, ' ');
const singular = (u) => String(u || '').trim().replace(/s$/, '').toLowerCase();
const TIME_UNITS = new Set(['second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year']);

/** The scenario's glossary model over its own run settings. */
export const correctModel = (s) => ({ ...glossaryModel(s), specs: s.model.specs });

const isTimeConstant = (model, id) => {
    const v = findVariable(model.variables, spaced(id));
    return Boolean(v && v.type !== 'stock' && isNumericEquation(v.equation) && TIME_UNITS.has(singular(v.units)));
};

/** Every candidate error of every kind in a model, in model order. */
export const candidatesFor = function(model) {
    const out = [];
    const stocks = model.variables.filter((v) => v.type === 'stock');
    for (const v of model.variables) {
        if (v.type === 'stock') continue;
        const eq = String(v.equation ?? '');
        // The first division by a constant measured in time, wherever it sits ("x / t", "MAX(0, (a - b) / t)").
        const div = [...eq.matchAll(new RegExp(`/\\s*(${IDENT.source})(?![A-Za-z0-9_(])`, 'g'))].find((m) => isTimeConstant(model, m[1]));
        if (div) {
            const t = spaced(div[1]);
            out.push({
                kind: 'timeConstant', id: `${v.name} multiplies by ${t}`, variable: v.name, change: { equation: eq.slice(0, div.index) + `* ${div[1]}` + eq.slice(div.index + div[0].length) },
                text: `"${v.name}" multiplies by "${t}" instead of dividing by it, so a longer ${t} makes it bigger instead of smaller (and the units do not work out).`,
                symptomTopic: `what happens to "${v.name}" when "${t}" is longer`,
                symptom: `When I make "${t}" longer, "${v.name}" gets bigger instead of smaller, which can't be right.`,
                falseClaim: `"${v.name}" should multiply by "${t}" instead of dividing by it.`
            });
        }
        const gap = eq.match(new RegExp(`\\(\\s*(${IDENT.source})\\s*-\\s*(${IDENT.source})\\s*\\)`));
        if (gap && findVariable(model.variables, spaced(gap[1])) && findVariable(model.variables, spaced(gap[2]))) {
            const [a, b] = [spaced(gap[1]), spaced(gap[2])];
            out.push({
                kind: 'reversedGap', id: `${v.name} takes its gap backwards`, variable: v.name, change: { equation: eq.replace(gap[0], `(${gap[2]} - ${gap[1]})`) },
                text: `"${v.name}" takes the gap the wrong way round ("${b}" minus "${a}" instead of "${a}" minus "${b}"), so it pushes the opposite way to what is needed.`,
                symptomTopic: `which way "${v.name}" moves when "${a}" and "${b}" are apart`,
                symptom: `When "${a}" is above "${b}", "${v.name}" goes the opposite way to what I expect.`,
                falseClaim: `"${v.name}" should use "${b}" minus "${a}" instead of "${a}" minus "${b}".`
            });
        }
    }
    for (const from of stocks) {
        for (const f of from.outflows || []) {
            const to = stocks.find((s) => s !== from && (s.inflows || []).includes(f));
            if (to) {
                out.push({
                    kind: 'disconnected', id: `${f} not connected to ${to.name}`, variable: to.name, change: { inflows: (to.inflows || []).filter((x) => x !== f) },
                    text: `"${f}" drains "${from.name}" but is not connected to "${to.name}", so what leaves "${from.name}" vanishes instead of arriving in "${to.name}".`,
                    symptomTopic: `what happens to "${to.name}" when "${f}" happens`,
                    symptom: `When "${f}" happens, "${from.name}" goes down but "${to.name}" never goes up.`,
                    falseClaim: `"${f}" should not flow into "${to.name}"; it should only drain "${from.name}".`
                });
            } else {
                out.push({
                    kind: 'missingOutflow', id: `${f} does not drain ${from.name}`, variable: from.name, change: { outflows: (from.outflows || []).filter((x) => x !== f) },
                    text: `"${f}" is not connected as an outflow of "${from.name}", so "${from.name}" never goes down through it and keeps piling up.`,
                    symptomTopic: `what happens to "${from.name}" through "${f}"`,
                    symptom: `"${f}" is happening, but "${from.name}" never goes down because of it — it just keeps piling up.`,
                    falseClaim: `"${f}" should not drain "${from.name}".`
                });
            }
        }
    }
    return out;
};

/** Apply errors (each `{variable, change}`) to a model. */
export const plant = function(model, errors) {
    const m = structuredClone(model);
    for (const e of errors) Object.assign(findVariable(m.variables, e.variable), structuredClone(e.change));
    return m;
};

/** The largest deviation of any stock from the correct run, as a share of that stock's largest value; null if it does not run. */
export const deviation = async function(model, correct) {
    const stocks = correct.variables.filter((v) => v.type === 'stock').map((v) => v.name);
    const [mine, truth] = await Promise.all([simulateModel(model, stocks, null), simulateModel(correct, stocks, null)]);
    if (!mine.ok || !truth.ok) return null;
    let worst = 0;
    for (const n of stocks) {
        if (!allFinite(mine.series[n])) return null;
        const scale = Math.max(...truth.series[n].map(Math.abs), 1e-9);
        for (let i = 0; i < truth.series[n].length; i++) worst = Math.max(worst, Math.abs(mine.series[n][i] - truth.series[n][i]) / scale);
    }
    return worst;
};

const rotation = (id) => [...id].reduce((a, ch) => a + ch.charCodeAt(0), 0) % KINDS.length;

/**
 * The generated case for one scenario, by the general rule, or null when it cannot give two
 * errors of different kinds.
 * @param {Object} s A scenario from the library
 * @returns {Promise<Object|null>} `{name, scenario, description, errors, distractors, extension, plantedForExtension}`
 */
export const generateCase = async function(s) {
    const correct = correctModel(s);
    const all = candidatesFor(correct);
    const valid = [];
    for (const c of all) {
        const d = await deviation(plant(correct, [c]), correct);
        if (d !== null && d >= MIN_DEVIATION) valid.push(c);
    }
    const r = rotation(s.id);
    const order = [...KINDS.slice(r), ...KINDS.slice(0, r)];
    let errors = null;
    outer: for (let i = 0; i < order.length; i++) {
        for (let j = i + 1; j < order.length; j++) {
            const [a, b] = [valid.find((c) => c.kind === order[i]), valid.find((c) => c.kind === order[j])];
            if (!a || !b || a.variable === b.variable) continue;
            if ((await deviation(plant(correct, [a, b]), correct)) === null) continue;
            errors = [a, b];
            break outer;
        }
    }
    if (!errors) return null;
    const planted = new Set(errors.map((e) => e.kind));
    const touched = new Set(errors.map((e) => e.variable));
    const distractors = [];
    for (const k of order.filter((x) => !planted.has(x))) {
        const c = all.find((x) => x.kind === k && !touched.has(x.variable));
        if (c) distractors.push(c.falseClaim);
    }
    for (const c of all) if (distractors.length < 2 && !planted.has(c.kind) && !touched.has(c.variable) && !distractors.includes(c.falseClaim)) distractors.push(c.falseClaim);
    for (const c of all) if (distractors.length < 2 && !touched.has(c.variable) && !errors.some((e) => e.id === c.id) && !distractors.includes(c.falseClaim)) distractors.push(c.falseClaim);
    if (distractors.length < 2) return null;

    const goal = findVariable(correct.variables, Object.entries(s.glossaryToModel).find(([, m]) => m === s.goal.variable)?.[0] ?? s.goal.variable);
    // The addition must not touch the variable the earlier error lives in (the fix is graded by
    // copying the engine's whole version of that variable into the correct model).
    const stocks = [...(goal?.type === 'stock' ? [goal] : []), ...correct.variables.filter((v) => v.type === 'stock' && v !== goal)];
    const stock = stocks.find((x) => errors.some((e) => e.variable !== x.name));
    const earlier = errors.find((e) => e.variable !== stock.name);
    const unit = singular(correct.specs.timeUnits);
    const flow = `${stock.name} lost`;
    const fraction = `${stock.name} loss fraction`;
    return {
        name: s.title,
        scenario: s.id,
        description: `the ${s.title.toLowerCase()}`,
        errors: errors.map(({ kind, id, variable, change, text, symptomTopic, symptom }) => ({ kind, id, variable, change, text, symptomTopic, symptom })),
        distractors: distractors.slice(0, 2),
        extension: {
            request: `Please add a loss from "${stock.name}": a flow called "${flow}" that drains "${stock.name}" at a constant "${fraction}" of 0.01 per ${unit} of "${stock.name}".`,
            variables: [{ name: flow, type: 'flow', references: [stock.name] }, { name: fraction }],
            stockFlows: [{ stock: stock.name, outflow: flow }]
        },
        plantedForExtension: earlier.id
    };
};
