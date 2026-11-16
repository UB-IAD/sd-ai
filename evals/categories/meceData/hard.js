/**
 * The general rule that makes mece's hard cases.
 *
 * It applies to every model the category has a total in: each scenario's full glossary model, then
 * each hand case's correct model. Several MECE errors are planted at once, of different kinds the
 * category already uses:
 *   - gap: the model's first total (a variable adding up two or more stocks, see generate.js)
 *     leaves one of its stocks out
 *   - overlap: the model's second total, where there is one, counts one of its stocks twice
 *   - doubleDrain: a stock is drained twice for the same thing — a copy of one of its outflows,
 *     named "<stock> leaving", added as a second outflow (the hand case "Inventory and Workforce"
 *     does this by hand)
 * Each total's stocks, and the stocks' outflows, are tried in model order; a plant is kept only if,
 * alone, it moves some stock by at least MIN_DEVIATION of its largest value, and no two plants live
 * in the same variable. A case needs at least two plants of two kinds, and all its plants together
 * must still run with finite values and move some stock by at least MIN_DEVIATION (two errors
 * that cancel out would leave nothing to fix by behavior). Then one more fault is added where the
 * model admits one (the hard group's extra-fault lever):
 *   - doubleFill: a stock filled twice for the same thing — a copy of one of its inflows, named
 *     "<stock> arriving", added as a second inflow — in a stock no other plant names, kept
 *     only if it alone moves some stock by MIN_DEVIATION and the whole still runs and does
 * A model with no such fill keeps the plants it has, so the case set is the same. Distractors are the generated cases' kinds of claim, about
 * stocks and flows no plant lives in or duplicates.
 *
 * @module categories/meceData/hard
 */

import { findVariable } from '../../utilities/modelDiff.js';
import { deviation, MIN_DEVIATION } from '../guidedCorrectionData/generate.js';
import { totalsOf } from './generate.js';

const under = (n) => n.replace(/\s+/g, '_');

/** A model with plants applied. */
export const plantAll = function(model, plants) {
    const m = structuredClone(model);
    for (const p of plants) {
        Object.assign(findVariable(m.variables, p.variable), structuredClone(p.change));
        if (p.adds) m.variables.push(...structuredClone(p.adds));
    }
    return m;
};

const kept = async (correct, plant) => {
    const d = await deviation(plantAll(correct, [plant]), correct);
    return d !== null && d >= MIN_DEVIATION;
};

/**
 * The hard case for one model, or null.
 * @param {Object} correct The correct model
 * @param {Object} about `{name, description, scenario?}` or `{name, description, handCase, heldOut?}`
 * @returns {Promise<Object|null>} `{name, description, scenario|handCase, heldOut?, plants, distractors}`
 */
export const generateHardCase = async function(correct, about) {
    const totals = totalsOf(correct);
    if (!totals.length) return null;
    const plants = [];
    const make = {
        gap: (total, part) => ({
            kind: 'gap', id: `${total.variable} leaves out ${part}`, variable: total.variable, names: [total.variable],
            change: { equation: total.parts.filter((p) => p !== part).map(under).join(' + ') },
            text: `"${total.variable}" adds up ${total.parts.filter((p) => p !== part).map((p) => `"${p}"`).join(' and ')} and leaves out "${part}", so it is not the whole of ${total.variable}.`
        }),
        overlap: (total, part) => ({
            kind: 'overlap', id: `${total.variable} counts ${part} twice`, variable: total.variable, names: [total.variable],
            change: { equation: [...total.parts, part].map(under).join(' + ') },
            text: `"${total.variable}" counts "${part}" twice, so the people or things in "${part}" are counted as if they were a separate group.`
        })
    };
    for (const [i, kind] of ['gap', 'overlap'].entries()) {
        const total = totals[i];
        if (!total) continue;
        for (const part of total.parts) {
            const p = make[kind](total, part);
            if (await kept(correct, p)) { plants.push(p); break; }
        }
    }
    drain: for (const stock of correct.variables.filter((v) => v.type === 'stock')) {
        if (plants.some((p) => p.variable === stock.name)) continue;
        const name = `${stock.name} leaving`;
        if (findVariable(correct.variables, name)) continue;
        for (const f of stock.outflows || []) {
            const flow = findVariable(correct.variables, f);
            if (!flow) continue;
            const p = {
                kind: 'doubleDrain', id: `${stock.name} drained twice by ${f}`, variable: stock.name, names: [stock.name, f, name],
                change: { outflows: [...stock.outflows, name] },
                adds: [{ name, type: 'flow', equation: flow.equation, units: flow.units, documentation: `People or things leaving "${stock.name}".` }],
                text: `"${stock.name}" is drained twice for the same thing: "${name}" is a copy of "${f}", so whatever leaves through "${f}" leaves "${stock.name}" a second time.`
            };
            if (await kept(correct, p)) { plants.push(p); break drain; }
        }
    }
    if (plants.length < 2 || new Set(plants.map((p) => p.kind)).size < 2) return null;
    // Together they must still run, and must not cancel out: the planted model as a whole moves some
    // stock by at least MIN_DEVIATION too.
    const together = await deviation(plantAll(correct, plants), correct);
    if (together === null || together < MIN_DEVIATION) return null;

    // Distractors are about stocks and flows no plant lives in or duplicates, so one never reads as
    // part of a real error: two such stocks measured alike said to overlap (else one such stock said not
    // to be a stock, else — only once the extra fault below has taken the last such stock — the first
    // constant no plant names said to be a stock), and such a flow said to need splitting by kind
    // (else the first total said to be a stock), as in the generated cases.
    const constant = (named) => correct.variables.find((v) => v.type === 'variable' && !named.has(v.name) && !totals.some((t) => t.variable === v.name) && /^\s*-?[0-9.]+(e-?[0-9]+)?\s*$/i.test(String(v.equation ?? '')));
    const distractorsFor = function(chosen, extended) {
        const named = new Set(chosen.flatMap((p) => p.names));
        const stocks = correct.variables.filter((v) => v.type === 'stock' && !named.has(v.name));
        const unitsOf = (v) => String(v.units ?? '').trim().toLowerCase();
        let pair = null;
        for (let i = 0; i < stocks.length && !pair; i++) for (let j = i + 1; j < stocks.length && !pair; j++) if (unitsOf(stocks[i]) === unitsOf(stocks[j])) pair = [stocks[i].name, stocks[j].name];
        const flow = correct.variables.find((v) => v.type === 'flow' && !named.has(v.name));
        const fallback = extended && !(pair || stocks.length) ? constant(named) : null;
        if (!(pair || stocks.length || fallback)) return null;
        return [
            pair ? `"${pair[0]}" and "${pair[1]}" overlap and one should be removed.` : stocks.length ? `"${stocks[0].name}" should not be a stock.` : `"${fallback.name}" should be a stock.`,
            flow ? `"${flow.name}" should be split into separate rates for every kind of ${totals[0].variable}.` : `"${totals[0].variable}" should be a stock.`
        ];
    };
    if (!distractorsFor(plants, false)) return null;

    // The extra fault (the hard group's added lever): a stock filled twice for the same thing — a
    // copy of one of its inflows, named "<stock> arriving", added as a second inflow. Stocks and
    // their inflows are tried in model order, skipping stocks a plant already names (the inflow may
    // be one another plant copies); the first that alone moves some stock by MIN_DEVIATION, keeps
    // the whole planted model running and moving some stock by MIN_DEVIATION, and leaves the
    // distractors makeable is planted. A model with none keeps the plants it has, so the case set
    // does not change.
    const taken = new Set(plants.flatMap((p) => p.names));
    fill: for (const stock of correct.variables.filter((v) => v.type === 'stock' && !taken.has(v.name))) {
        const name = `${stock.name} arriving`;
        if (findVariable(correct.variables, name)) continue;
        for (const f of stock.inflows || []) {
            const flow = findVariable(correct.variables, f);
            if (!flow) continue;
            const p = {
                kind: 'doubleFill', id: `${stock.name} filled twice by ${f}`, variable: stock.name, names: [stock.name, f, name],
                change: { inflows: [...stock.inflows, name] },
                adds: [{ name, type: 'flow', equation: flow.equation, units: flow.units, documentation: `People or things arriving in "${stock.name}".` }],
                text: `"${stock.name}" is filled twice for the same thing: "${name}" is a copy of "${f}", so whatever arrives through "${f}" arrives in "${stock.name}" a second time.`
            };
            if (!(await kept(correct, p))) continue;
            const all = [...plants, p];
            const d = await deviation(plantAll(correct, all), correct);
            if (d === null || d < MIN_DEVIATION || !distractorsFor(all, true)) continue;
            plants.push(p);
            break fill;
        }
    }
    const distractors = distractorsFor(plants, true);
    for (const p of plants) delete p.names;
    return { ...about, name: `${about.name} (hard)`, plants, distractors };
};

/**
 * Every hard case the rule gives: the scenarios' models in library order, then the hand cases'.
 * Stored in hard.json by buildGenerated.js, without the correct models (cases.js rebuilds them).
 */
export const allHardCases = async function() {
    const { scenarios } = await import('../../utilities/scenarios/library.js');
    const { correctModel } = await import('../guidedCorrectionData/generate.js');
    const { handCases } = await import('./cases.js');
    const out = {};
    for (const s of Object.values(scenarios)) {
        const c = await generateHardCase(correctModel(s), { name: s.title, scenario: s.id, description: `the ${s.title.toLowerCase()}` });
        if (c) out[c.name] = c;
    }
    for (const [name, h] of Object.entries(handCases)) {
        const c = await generateHardCase(h.correct, { name, handCase: name, description: h.description, ...(h.heldOut ? { heldOut: true } : {}) });
        if (c) out[c.name] = c;
    }
    return out;
};
