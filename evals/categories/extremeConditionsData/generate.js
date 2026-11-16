/**
 * The general rule that makes extremeConditions cases for every scenario in the library.
 *
 * The robust model is the scenario's glossary model. A plant removes one guard: a MIN or MAX call
 * anywhere in a flow's or auxiliary's equation is replaced by one of its arguments (not a bare
 * number) — a flow that keeps draining a stock that has run dry, a rate that can turn negative, a
 * fraction no longer capped at 1, a divisor no longer kept off zero
 * or, where the scenario's model has no such guard to remove, the robust model gets one added:
 *   - an outflow whose equation ignores the stock it drains becomes MIN(outflow, stock / minimum
 *     time) in the robust model (a new constant of GUARD_STEPS time steps); the plant is the
 *     original, unguarded outflow
 *   - a division by a quantity that is not a constant (a stock, or a variable computed from one)
 *     becomes a division by MAX(quantity, SMALLEST) in the robust model; the plant is the
 *     original, unguarded division
 * Removable guards are tried first, then added ones, variables in model order. A plant is kept only if, normally, the planted model behaves like
 * the robust one (every stock within BASE_TOLERANCE of its largest value), and some trigger makes
 * the planted model impossible (a stock negative, or a value non-finite) while the robust model
 * stays possible. Triggers are tried in a fixed order: each constant, in model order, set to zero,
 * then each set to TRIGGER_FACTOR times its value, then each stock started at zero. The first plant with a trigger makes the case.
 *
 * @module categories/extremeConditionsData/generate
 */

import { impossibleUnder } from '../../utilities/extremeRun.js';
import { findVariable, isNumericEquation, referencedNames, foldName } from '../../utilities/modelDiff.js';
import { correctModel, deviation } from '../guidedCorrectionData/generate.js';

export const BASE_TOLERANCE = 0.01;
export const TRIGGER_FACTOR = 10;
export const GUARD_STEPS = 4;
export const SMALLEST = 0.001;

/** Split a top-level call's arguments, respecting nested parentheses. */
const callArgs = function(equation, fn) {
    const m = String(equation).trim().match(new RegExp(`^${fn}\\s*\\(`, 'i'));
    if (!m) return null;
    const body = String(equation).trim().slice(m[0].length);
    const args = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch === '(') depth++;
        else if (ch === ')') {
            if (depth === 0) return body.slice(i + 1).trim() === '' ? [...args, body.slice(start, i).trim()] : null;
            depth--;
        } else if (ch === ',' && depth === 0) {
            args.push(body.slice(start, i).trim());
            start = i + 1;
        }
    }
    return null;
};

/** Every variable a variable depends on, directly or through others (stocks end the search). */
const dependsOn = function(model, equation, target) {
    const byFold = new Map(model.variables.map((v) => [foldName(v.name), v]));
    const seen = new Set();
    const queue = [...referencedNames(equation)];
    while (queue.length) {
        const n = queue.shift();
        if (seen.has(n)) continue;
        seen.add(n);
        if (n === foldName(target)) return true;
        const v = byFold.get(n);
        if (v && v.type !== 'stock') queue.push(...referencedNames(v.equation));
    }
    return false;
};

/** Every MIN or MAX call with two arguments in an equation: its span and its arguments. */
const guardCalls = function(equation) {
    const eq = String(equation ?? '');
    const out = [];
    const re = /\b(MIN|MAX)\s*\(/gi;
    let m;
    while ((m = re.exec(eq))) {
        const open = m.index + m[0].length;
        const args = [];
        let depth = 0;
        let start = open;
        for (let i = open; i < eq.length; i++) {
            const ch = eq[i];
            if (ch === '(') depth++;
            else if (ch === ')') {
                if (depth === 0) {
                    args.push(eq.slice(start, i).trim());
                    if (args.length === 2) out.push({ fn: m[1].toUpperCase(), from: m.index, to: i + 1, args });
                    break;
                }
                depth--;
            } else if (ch === ',' && depth === 0) {
                args.push(eq.slice(start, i).trim());
                start = i + 1;
            }
        }
    }
    return out;
};

/**
 * The guard-removal plants of a model, in model order: every MIN or MAX call in a flow's or
 * auxiliary's equation replaced by one of its arguments (one that is not a bare number), so the
 * limit it puts on the value is gone.
 */
export const plantsFor = function(model) {
    const out = [];
    for (const v of model.variables.filter((x) => x.type !== 'stock' && !isNumericEquation(x.equation))) {
        const eq = String(v.equation);
        for (const call of guardCalls(eq)) {
            call.args.forEach((arg, i) => {
                if (isNumericEquation(arg)) return;
                out.push({ variable: v.name, equation: eq.slice(0, call.from) + `(${arg})` + eq.slice(call.to), guard: `loses the ${call.fn} that limits it to ${call.args[1 - i]}` });
            });
        }
    }
    return out;
};

/** Why a run under the overrides is impossible (a stock below zero, a value not finite), or null. */
const firstImpossible = async (model, overrides) => impossibleUnder(model, overrides);

const under = (n) => n.replace(/\s+/g, '_');
const singular = (u) => String(u || '').trim().replace(/s$/, '').toLowerCase();

/**
 * The robust model for a case: the scenario's model, with the guard the case adds (if any).
 * @param {Object} s A scenario from the library
 * @param {Object|undefined} added `{variable, equation, constant}` — the guarded equation and its new constant
 */
export const robustModel = function(s, added) {
    const m = correctModel(s);
    if (added) {
        findVariable(m.variables, added.variable).equation = added.equation;
        m.variables.push(structuredClone(added.constant));
    }
    return m;
};

/** Outflows whose equations ignore the stock they drain: each gets a guard in the robust model. */
export const addedGuardsFor = function(model) {
    const out = [];
    for (const f of model.variables.filter((v) => v.type === 'flow')) {
        const drained = model.variables.find((x) => x.type === 'stock' && (x.outflows || []).includes(f.name));
        if (!drained || dependsOn(model, f.equation, drained.name) || isNumericEquation(f.equation) && Number(f.equation) === 0) continue;
        const name = `minimum ${f.name} time`;
        out.push({
            added: { variable: f.name, equation: `MIN(${f.equation}, ${under(drained.name)} / ${under(name)})`, constant: { name, type: 'variable', equation: String(GUARD_STEPS * model.specs.dt), units: `${singular(model.specs.timeUnits)}s` } },
            plant: { variable: f.name, equation: f.equation },
            guard: `keeps flowing after "${drained.name}" runs out`
        });
    }
    return out;
};

/** Divisions by a quantity that is not a constant: each gets a floor in the robust model. */
export const divisorGuardsFor = function(model) {
    const out = [];
    const byFold = new Map(model.variables.map((v) => [foldName(v.name), v]));
    for (const v of model.variables.filter((x) => x.type !== 'stock' && !isNumericEquation(x.equation))) {
        const eq = String(v.equation);
        for (const m of eq.matchAll(/\/\s*([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_(])/g)) {
            const y = byFold.get(foldName(m[1]));
            if (!y || (y.type !== 'stock' && isNumericEquation(y.equation))) continue;
            const name = `smallest ${y.name}`;
            out.push({
                added: { variable: v.name, equation: eq.slice(0, m.index) + `/ MAX(${m[1]}, ${under(name)})` + eq.slice(m.index + m[0].length), constant: { name, type: 'variable', equation: String(SMALLEST), units: y.units } },
                plant: { variable: v.name, equation: eq },
                guard: `divides by "${y.name}" with nothing to keep it off zero`
            });
        }
    }
    return out;
};

/**
 * The generated case for one scenario, by the general rule, or null.
 * @param {Object} s A scenario from the library
 * @returns {Promise<Object|null>} `{name, scenario, description, added?, plant, trigger, failure}`
 */
export const generateCase = async function(s) {
    const base = correctModel(s);
    const candidates = [
        ...plantsFor(base).map((p) => ({ plant: { variable: p.variable, equation: p.equation }, guard: p.guard })),
        ...addedGuardsFor(base),
        ...divisorGuardsFor(base)
    ];
    for (const c of candidates) {
        const clean = robustModel(s, c.added);
        const planted = structuredClone(clean);
        findVariable(planted.variables, c.plant.variable).equation = c.plant.equation;
        const d = await deviation(planted, clean);
        if (d === null || d > BASE_TOLERANCE) continue;
        const constants = base.variables.filter((v) => v.type !== 'stock' && isNumericEquation(v.equation) && Number(v.equation) !== 0);
        const stocks = base.variables.filter((v) => v.type === 'stock' && isNumericEquation(v.equation) && Number(v.equation) !== 0);
        const triggers = [...constants.map((k) => ({ [k.name]: '0' })), ...constants.map((k) => ({ [k.name]: String(Number(k.equation) * TRIGGER_FACTOR) })), ...stocks.map((k) => ({ [k.name]: '0' }))];
        for (const trigger of triggers) {
            if (await firstImpossible(clean, trigger)) continue;
            const why = await firstImpossible(planted, trigger);
            if (!why) continue;
            const [[name, value]] = Object.entries(trigger);
            return {
                name: s.title,
                scenario: s.id,
                description: `the ${s.title.toLowerCase()}`,
                ...(c.added ? { added: c.added } : {}),
                plant: c.plant,
                trigger,
                failure: `with "${name}" at ${value}, "${c.plant.variable}" ${c.guard}, and ${/failed to simulate/.test(why) ? 'the run fails' : `the model goes impossible: ${why}`}`
            };
        }
    }
    return null;
};
