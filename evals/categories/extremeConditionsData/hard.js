/**
 * The general rule that makes extremeConditions' hard cases, for every scenario in the library.
 *
 * generate.js plants one impossible formulation of one of three kinds; a hard case plants up to
 * HARD_PLANTS at once, each in its own variable — first one of each kind the scenario's full model
 * has a site for, then further sites of any kind:
 *   - guardRemoved: a MIN or MAX guard in the scenario's model dropped (generate.js's plantsFor)
 *   - drainUnguarded: an outflow that ignores the stock it drains; the robust model limits it to
 *     that stock over GUARD_STEPS time steps (generate.js's addedGuardsFor)
 *   - divisionUnguarded: a division by a quantity that can reach zero; the robust model keeps it at
 *     or above SMALLEST (generate.js's divisorGuardsFor)
 * The robust model is the scenario's model with every added guard of the case in place. A plant
 * counts as for generate.js: alone in the robust model it normally keeps every stock within
 * BASE_TOLERANCE, and some trigger — tried in generate.js's order — makes it impossible while the
 * robust model stays possible; the first such trigger is that plant's. Each kind's sites are tried
 * in model order, the kinds in the order above. All the plants together must still normally behave
 * like the robust model. Most scenario models have a site for only one plant (every other guard
 * binds in normal runs, or no extreme exposes it); their hard case keeps the one plant, and its
 * other levers — no hint, the clean control — still apply.
 *
 * @module categories/extremeConditionsData/hard
 */

import { impossibleUnder } from '../../utilities/extremeRun.js';
import { findVariable, isNumericEquation } from '../../utilities/modelDiff.js';
import { correctModel, deviation } from '../guidedCorrectionData/generate.js';
import { plantsFor, addedGuardsFor, divisorGuardsFor, BASE_TOLERANCE, TRIGGER_FACTOR } from './generate.js';

export const HARD_PLANTS = 3;

/** The robust model of a hard case: the scenario's model with every added guard in place. */
export const hardRobustModel = function(s, added) {
    const m = correctModel(s);
    for (const a of added) {
        findVariable(m.variables, a.variable).equation = a.equation;
        m.variables.push(structuredClone(a.constant));
    }
    return m;
};

/** A model with plants in place. */
export const plantAll = function(model, plants) {
    const m = structuredClone(model);
    for (const p of plants) findVariable(m.variables, p.variable).equation = p.equation;
    return m;
};

/**
 * The hard case for one scenario, or null.
 * @param {Object} s A scenario from the library
 * @returns {Promise<Object|null>} `{name, scenario, description, added, plants}`, each plant `{id, kind, variable, equation, trigger, failure}`
 */
export const generateHardCase = async function(s) {
    const base = correctModel(s);
    const kinds = {
        guardRemoved: plantsFor(base).map((p) => ({ plant: { variable: p.variable, equation: p.equation }, guard: p.guard })),
        drainUnguarded: addedGuardsFor(base),
        divisionUnguarded: divisorGuardsFor(base)
    };
    const constants = base.variables.filter((v) => v.type !== 'stock' && isNumericEquation(v.equation) && Number(v.equation) !== 0);
    const stocks = base.variables.filter((v) => v.type === 'stock' && isNumericEquation(v.equation) && Number(v.equation) !== 0);
    const triggers = [...constants.map((k) => ({ [k.name]: '0' })), ...constants.map((k) => ({ [k.name]: String(Number(k.equation) * TRIGGER_FACTOR) })), ...stocks.map((k) => ({ [k.name]: '0' }))];

    const chosen = [];
    // One plant of each kind first, then more of any kind, until the case has HARD_PLANTS.
    const passes = [Object.entries(kinds), Object.entries(kinds)];
    for (const [pass, list] of passes.entries()) for (const [kind, candidates] of list) {
        if (chosen.length >= HARD_PLANTS) break;
        if (pass === 0 && chosen.some((x) => x.kind === kind)) continue;
        for (const c of candidates) {
            if (chosen.length >= HARD_PLANTS) break;
            if (chosen.some((x) => x.plant.variable === c.plant.variable)) continue;
            const added = [...chosen.map((x) => x.added), c.added].filter(Boolean);
            const robust = hardRobustModel(s, added);
            const planted = plantAll(robust, [c.plant]);
            const d = await deviation(planted, robust);
            if (d === null || d > BASE_TOLERANCE) continue;
            let found = null;
            for (const trigger of triggers) {
                if (await impossibleUnder(robust, trigger)) continue;
                const why = await impossibleUnder(planted, trigger);
                if (why) { found = { trigger, why }; break; }
            }
            if (!found) continue;
            const [[name, value]] = Object.entries(found.trigger);
            chosen.push({
                kind, added: c.added,
                plant: {
                    id: `${c.plant.variable} ${c.guard}`, kind, variable: c.plant.variable, equation: c.plant.equation, trigger: found.trigger,
                    failure: `with "${name}" at ${value}, "${c.plant.variable}" ${c.guard}, and ${/failed to simulate/.test(found.why) ? 'the run fails' : `the model goes impossible: ${found.why}`}`
                }
            });
            if (pass === 0) break;
        }
    }
    if (!chosen.length) return null;
    const added = chosen.map((x) => x.added).filter(Boolean);
    const robust = hardRobustModel(s, added);
    const plants = chosen.map((x) => x.plant);
    // Each plant's trigger was found with only the guards chosen before it; it must hold in the
    // case's robust model too, and all the plants together must normally behave like it.
    for (const p of plants) {
        if (await impossibleUnder(robust, p.trigger)) return null;
        if (!(await impossibleUnder(plantAll(robust, [p]), p.trigger))) return null;
        const d = await deviation(plantAll(robust, [p]), robust);
        if (d === null || d > BASE_TOLERANCE) return null;
    }
    const together = await deviation(plantAll(robust, plants), robust);
    if (together === null || together > BASE_TOLERANCE) return null;
    return { name: `${s.title} (hard)`, scenario: s.id, description: `the ${s.title.toLowerCase()}`, added, plants };
};
