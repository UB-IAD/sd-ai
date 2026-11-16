/**
 * The general rule that makes fixUnits cases for every scenario in the library.
 *
 * The correct model is the scenario's glossary model, which must be unit-consistent. A case plants
 * two errors, as the hand-written cases do:
 *   - a division by a constant measured in time made a multiplication (the guidedCorrection rule's
 *     timeConstant kind): wrong in its units and in what the model computes. The first such
 *     candidate, in model order, that the unit checker flags and that moves some stock by at least
 *     MIN_DEVIATION of its largest value.
 *   - a flow declared without its "per time": the right equation with the wrong units. The first
 *     flow, in model order, in another variable, whose units end in "/<time unit>" and whose
 *     shortened units the unit checker flags.
 * A scenario that cannot give both gets no case.
 *
 * @module categories/unitConsistencyData/generate
 */

import { checkUnits, INCONSISTENCY_KINDS } from '../../utilities/units/unitChecker.js';
import { correctModel, candidatesFor, plant, deviation, MIN_DEVIATION } from '../guidedCorrectionData/generate.js';

const flagged = (model) => checkUnits(model).filter((w) => INCONSISTENCY_KINDS.has(w.kind) || w.kind === 'missing');
const singular = (u) => String(u || '').trim().replace(/s$/, '').toLowerCase();

/**
 * The generated case for one scenario, by the general rule, or null.
 * @param {Object} s A scenario from the library
 * @returns {Promise<Object|null>} `{name, scenario, description, errors}`
 */
export const generateCase = async function(s) {
    const correct = correctModel(s);
    if (flagged(correct).length) return null;
    let behavioral = null;
    for (const c of candidatesFor(correct).filter((x) => x.kind === 'timeConstant')) {
        const given = plant(correct, [c]);
        if (!flagged(given).length) continue;
        const d = await deviation(given, correct);
        if (d === null || d < MIN_DEVIATION) continue;
        behavioral = { id: c.id, variable: c.variable, change: c.change };
        break;
    }
    if (!behavioral) return null;
    const unit = singular(correct.specs.timeUnits);
    let declared = null;
    for (const v of correct.variables.filter((x) => x.type === 'flow' && x.name !== behavioral.variable)) {
        const [num, den] = String(v.units || '').split('/').map((x) => x.trim());
        if (!num || den === undefined || singular(den) !== unit) continue;
        const change = { units: num };
        if (!flagged(plant(correct, [{ variable: v.name, change }])).length) continue;
        declared = { id: `${v.name} declared without per ${unit}`, variable: v.name, change };
        break;
    }
    if (!declared) return null;
    return { name: s.title, scenario: s.id, description: `the ${s.title.toLowerCase()}`, errors: [behavioral, declared] };
};

/** An equation written with the variables' own names in quotes, for a description. */
const spoken = function(model, equation) {
    const byFold = new Map(model.variables.map((v) => [v.name.toLowerCase().replace(/[\s_]+/g, '_'), v.name]));
    return String(equation).replace(/[A-Za-z_][A-Za-z0-9_]*/g, (id) => {
        const name = byFold.get(id.toLowerCase());
        return name ? `"${name}"` : id;
    });
};

/**
 * The generated buildWithUnits case for one scenario: a description of the scenario's glossary
 * model — each stock with its units, its start and its flows; each constant with its units; each
 * formula in the model's own names, without units, so the units of every flow and computed
 * variable are the agent's to work out — and the run's time span, so one model follows from it.
 * @param {Object} s A scenario from the library
 * @returns {Object|null} `{name, scenario, description, stocks}`, or null if the model is not unit-consistent
 */
export const generateBuildCase = function(s) {
    const m = correctModel(s);
    if (flagged(m).length) return null;
    const units = (v) => v.units || 'dimensionless';
    const parts = [`This is a model of the ${s.title.toLowerCase()}.`];
    for (const v of m.variables.filter((x) => x.type === 'stock')) {
        const ins = (v.inflows || []).map((f) => `"${f}"`).join(' and ');
        const outs = (v.outflows || []).map((f) => `"${f}"`).join(' and ');
        parts.push(`"${v.name}" is a stock measured in ${units(v)}, starting at ${spoken(m, v.equation)}${ins ? `; it is increased by ${ins}` : ''}${outs ? `${ins ? ' and' : '; it is'} decreased by ${outs}` : ''}.`);
    }
    for (const v of m.variables.filter((x) => x.type !== 'stock')) {
        const eq = String(v.equation ?? '');
        parts.push(/^[-+]?[0-9.eE+-]+$/.test(eq.trim())
            ? `"${v.name}" is ${eq.trim()} ${units(v)}.`
            : `"${v.name}"${v.type === 'flow' ? ' (a flow)' : ''} equals ${spoken(m, eq)}.`);
    }
    const { startTime, stopTime, dt, timeUnits } = m.specs;
    parts.push(`Simulate from ${timeUnits} ${startTime} to ${stopTime} in steps of ${dt}.`);
    return { name: `${s.title} (build)`, scenario: s.id, description: parts.join(' '), stocks: m.variables.filter((x) => x.type === 'stock').map((x) => x.name) };
};

export { correctModel };
