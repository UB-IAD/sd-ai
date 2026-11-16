/**
 * The general rule that makes unitConsistency's hard cases, for every scenario in the library whose
 * full glossary model is unit-consistent.
 *
 * generate.js plants two unit errors; a hard case plants HARD_ERRORS at once, each of a different
 * kind and in a different variable, the kinds tried in this order and each kind's sites in model
 * order:
 *   - timeConstant: a division by a constant measured in time made a multiplication (generate.js's
 *     first kind): wrong in its units and in what the model computes
 *   - unlikeSum: an equation that multiplies two variables adds them instead (the hand case
 *     "Predators and Prey" does this by hand): apples added to oranges, and a different result
 *   - flowUnits: a flow declared without its "per time" (generate.js's second kind): the right
 *     equation with the wrong units
 *   - constantUnits: a constant declared as "1/<time>" whose units are "<something>/<time>" (the
 *     hand case "Predators and Prey" does this by hand): the right value with the wrong units
 * Every error must, alone, be flagged by the unit checker; one that changes an equation must also,
 * alone, move some stock by at least MIN_DEVIATION of its largest value. All of them together must
 * still run.
 *
 * @module categories/unitConsistencyData/hard
 */

import { checkUnits, INCONSISTENCY_KINDS } from '../../utilities/units/unitChecker.js';
import { correctModel, candidatesFor, plant, deviation, MIN_DEVIATION } from '../guidedCorrectionData/generate.js';
import { isNumericEquation } from '../../utilities/modelDiff.js';

export const HARD_ERRORS = 3;

const flagged = (model) => checkUnits(model).filter((w) => INCONSISTENCY_KINDS.has(w.kind) || w.kind === 'missing');
const singular = (u) => String(u || '').trim().replace(/s$/, '').toLowerCase();

/**
 * The hard case for one scenario, or null.
 * @param {Object} s A scenario from the library
 * @returns {Promise<Object|null>} `{name, scenario, description, errors}`, each error `{id, kind, variable, change}`
 */
export const generateHardCase = async function(s) {
    const correct = correctModel(s);
    if (flagged(correct).length) return null;
    const unit = singular(correct.specs.timeUnits);
    const errors = [];
    const free = (name) => !errors.some((e) => e.variable === name);
    const behaves = async (e) => { const d = await deviation(plant(correct, [e]), correct); return d !== null && d >= MIN_DEVIATION; };
    const kinds = {
        timeConstant: async function() {
            for (const c of candidatesFor(correct).filter((x) => x.kind === 'timeConstant' && free(x.variable))) {
                const e = { id: c.id, kind: 'timeConstant', variable: c.variable, change: c.change };
                if (flagged(plant(correct, [e])).length && await behaves(e)) return e;
            }
            return null;
        },
        unlikeSum: async function() {
            for (const v of correct.variables.filter((x) => x.type !== 'stock' && free(x.name))) {
                const m = String(v.equation ?? '').match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\*\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/);
                if (!m) continue;
                const e = { id: `${v.name} adds where it should multiply`, kind: 'unlikeSum', variable: v.name, change: { equation: `${m[1]} + ${m[2]}` } };
                if (flagged(plant(correct, [e])).length && await behaves(e)) return e;
            }
            return null;
        },
        flowUnits: async function() {
            for (const v of correct.variables.filter((x) => x.type === 'flow' && free(x.name))) {
                const [num, den] = String(v.units || '').split('/').map((x) => x.trim());
                if (!num || den === undefined || singular(den) !== unit) continue;
                const e = { id: `${v.name} declared without per ${unit}`, kind: 'flowUnits', variable: v.name, change: { units: num } };
                if (flagged(plant(correct, [e])).length) return e;
            }
            return null;
        },
        constantUnits: async function() {
            for (const v of correct.variables.filter((x) => x.type !== 'stock' && isNumericEquation(x.equation) && free(x.name))) {
                const parts = String(v.units || '').split('/').map((x) => x.trim());
                if (parts.length !== 2 || !parts[0] || parts[0] === '1' || singular(parts[1]) !== unit) continue;
                const e = { id: `${v.name} declared per ${unit} only`, kind: 'constantUnits', variable: v.name, change: { units: `1/${parts[1]}` } };
                if (flagged(plant(correct, [e])).length) return e;
            }
            return null;
        }
    };
    for (const find of Object.values(kinds)) {
        if (errors.length >= HARD_ERRORS) break;
        const e = await find();
        if (e) errors.push(e);
    }
    if (errors.length < HARD_ERRORS) return null;
    if ((await deviation(plant(correct, errors), correct)) === null) return null;
    return { name: `${s.title} (hard)`, scenario: s.id, description: `the ${s.title.toLowerCase()}`, errors };
};
