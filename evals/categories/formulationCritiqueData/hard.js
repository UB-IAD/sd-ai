/**
 * The general rule that makes formulationCritique's hard cases, for every scenario in the library
 * whose full glossary model passes the formulation linter.
 *
 * Plants are pure matters of form, as in generate.js — the planted model computes what the clean one
 * does — but several at once, of every kind the category knows that the model has a site for, each
 * in its own variable. Sites are searched in model order, the rare kinds first so the common ones
 * do not take their variables:
 *   - hard-coded time switch: each STEP(height, time) of named constants in a variable written as
 *     (IF TIME >= <time> THEN <height> ELSE 0), numbers and all (the hand case "Regional distributor
 *     inventory" does this by hand)
 *   - unguarded division: a division by a total of stocks (a variable adding up two or more stocks)
 *     with the total written out in place, or a MAX(x, number) guard on a divisor dropped (the hand
 *     case "Endemic Infection" does the first by hand)
 *   - too many inputs and embedded constant: generate.js's rules
 *   - embedded constant again, in further variables, until the case has HARD_PLANTS plants
 * Then the "more faults" lever: a second pass over the same kinds in the same order takes further
 * sites of each (any number of time switches, divisions and inlinings, then embedded constants)
 * until the case has MAX_PLANTS plants or the model has no site left. The first pass's plants are
 * kept as they were, so the second pass only adds.
 * Each plant must trip its linter rule on its variable and, alone and all together, keep every stock
 * within SAME_BEHAVIOR of the clean run. A case needs HARD_PLANTS plants of at least two kinds.
 * Distractors are generate.js's.
 *
 * @module categories/formulationCritiqueData/hard
 */

import { lintFormulations, MAX_INPUTS } from '../../utilities/formulationLint.js';
import { findVariable, isNumericEquation, referencedNames, foldName } from '../../utilities/modelDiff.js';
import { behaviorMismatch } from '../../utilities/behaviorCompare.js';
import { cleanModel } from './generate.js';
import { totalsOf } from '../meceData/generate.js';

export const HARD_PLANTS = 3;
/** The "more faults" lever: a second pass adds further plants of every kind, up to this many in all. */
export const MAX_PLANTS = 6;
export const SAME_BEHAVIOR = 0.001;

const under = (n) => n.replace(/\s+/g, '_');
const pattern = (name) => new RegExp(`(?<![A-Za-z0-9_])${under(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'i');
const trips = (model, variable, rule) => lintFormulations(model).some((f) => f.rule === rule && foldName(f.variable) === foldName(variable));

/** The model with every plant applied. */
export const plantAll = function(model, plants) {
    const m = structuredClone(model);
    for (const p of plants) findVariable(m.variables, p.variable).equation = p.equation;
    return m;
};

/**
 * The hard case for one scenario, or null.
 * @param {Object} s A scenario from the library
 * @returns {Promise<Object|null>} `{name, scenario, description, plants, distractors}`
 */
export const generateHardCase = async function(s) {
    const clean = cleanModel(s);
    if (lintFormulations(clean).length) return null;
    const vars = clean.variables.filter((v) => v.type !== 'stock' && !isNumericEquation(v.equation));
    const byFold = new Map(clean.variables.map((v) => [foldName(v.name), v]));
    const inputsOf = (equation) => [...referencedNames(equation)].map((n) => byFold.get(n)).filter(Boolean);
    const constantValue = (name) => { const v = byFold.get(foldName(name)); return v && v.type !== 'stock' && isNumericEquation(v.equation) ? Number(v.equation) : null; };
    const plants = [];
    const taken = (v) => plants.some((p) => p.variable === v.name);
    const accept = async function(p) {
        const m = plantAll(clean, [p]);
        const rules = p.rules || [p.rule];
        if (!rules.every((r) => trips(m, p.variable, r))) return false;
        if (await behaviorMismatch(m, clean, SAME_BEHAVIOR)) return false;
        plants.push(p);
        return true;
    };

    // Each kind's search accepts up to `limit` new plants, in further variables, in model order.
    const timeSwitches = async function(limit) {
        let n = 0;
        for (const v of vars) {
            if (n >= limit || plants.length >= MAX_PLANTS) return;
            if (taken(v)) continue;
            const steps = [...String(v.equation).matchAll(/STEP\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/gi)]
                .filter((m) => constantValue(m[1]) !== null && constantValue(m[2]) !== null);
            if (!steps.length) continue;
            let equation = String(v.equation);
            for (const m of steps) equation = equation.replace(m[0], `(IF TIME >= ${constantValue(m[2])} THEN ${constantValue(m[1])} ELSE 0)`);
            const named = [...new Set(steps.flatMap((m) => [m[1], m[2]]))].map((x) => `"${byFold.get(foldName(x)).name}"`).join(', ');
            if (await accept({ id: `hard-coded switch in ${v.name}`, variable: v.name, rule: 'hard-coded time switch', rules: ['hard-coded time switch', 'embedded constant'], equation, text: `"${v.name}" switches at hard-coded times with hard-coded sizes (IF TIME >= ...) instead of using STEP with the named constants ${named}.` })) n++;
        }
    };

    // Unguarded division: a total written out in a denominator, or a divisor's MAX guard dropped.
    const totals = totalsOf(clean);
    const divisions = async function(limit) {
        let n = 0;
        site: for (const v of vars) {
            if (n >= limit || plants.length >= MAX_PLANTS) return;
            if (taken(v)) continue;
            const eq = String(v.equation);
            for (const t of totals) {
                const m = eq.match(new RegExp(`/\\s*(${pattern(t.variable).source})`, 'i'));
                if (!m) continue;
                const equation = eq.replace(m[0], `/ (${t.parts.map(under).join(' + ')})`);
                if (await accept({ id: `${t.variable} written out unguarded in ${v.name}`, variable: v.name, rule: 'unguarded division', equation, text: `"${v.name}" divides by the sum ${t.parts.map((p) => `"${p}"`).join(' + ')} written out in place, with no guard against it reaching zero (and repeats the total "${t.variable}" the model already names).` })) { n++; continue site; }
            }
            for (const m of eq.matchAll(/\/\s*MAX\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([0-9.]+)\s*\)/gi)) {
                const equation = eq.replace(m[0], `/ ${m[1]}`);
                const name = byFold.get(foldName(m[1]))?.name ?? m[1];
                if (await accept({ id: `guard on ${name} dropped in ${v.name}`, variable: v.name, rule: 'unguarded division', equation, text: `"${v.name}" divides by "${name}" with no guard against it reaching zero.` })) { n++; continue site; }
            }
        }
    };

    // Too many inputs: an intermediate written out in place (generate.js's rule).
    const inlines = async function(limit) {
        let n = 0;
        site: for (const v of vars) {
            if (n >= limit || plants.length >= MAX_PLANTS) return;
            if (taken(v)) continue;
            for (const r of referencedNames(v.equation)) {
                const a = byFold.get(r);
                if (!a || a.type === 'stock' || isNumericEquation(a.equation)) continue;
                const equation = String(v.equation).replace(pattern(a.name), `(${a.equation})`);
                const inputs = inputsOf(equation).length;
                if (inputs <= MAX_INPUTS) continue;
                if (await accept({ id: `${a.name} inlined into ${v.name}`, variable: v.name, rule: 'too many inputs', equation, text: `"${v.name}" packs ${inputs} inputs into one equation by writing out the formula for "${a.name}" in place instead of using "${a.name}".` })) { n++; continue site; }
            }
        }
    };

    // Embedded constants (generate.js's rule), in further variables until the case has `upTo`
    // plants; at least one.
    const embeddedConstants = async function(upTo) {
        let embedded = plants.filter((p) => p.rule === 'embedded constant').length;
        for (const v of vars) {
            if (embedded >= 1 && plants.length >= upTo) break;
            if (taken(v)) continue;
            if (inputsOf(v.equation).length < 2) continue;
            const constant = inputsOf(v.equation).find((c) => c.type !== 'stock' && isNumericEquation(c.equation) && ![0, 1].includes(Number(c.equation)));
            if (!constant) continue;
            const equation = String(v.equation).replace(pattern(constant.name), String(Number(constant.equation)));
            if (await accept({ id: `${constant.name} embedded in ${v.name}`, variable: v.name, rule: 'embedded constant', equation, text: `"${v.name}" has the value of "${constant.name}" (${Number(constant.equation)}) written into its equation as a number instead of using the named constant "${constant.name}".` })) embedded++;
        }
    };

    // First pass: one site of each rare kind, then embedded constants until HARD_PLANTS.
    await timeSwitches(1);
    await divisions(1);
    await inlines(1);
    await embeddedConstants(HARD_PLANTS);
    // Second pass, the "more faults" lever: further sites of every kind, rare kinds first, until the
    // case has MAX_PLANTS plants or the model has no site left.
    if (plants.length >= HARD_PLANTS) {
        await timeSwitches(Infinity);
        await divisions(Infinity);
        await inlines(Infinity);
        await embeddedConstants(MAX_PLANTS);
    }

    const chosen = plants;
    if (chosen.length < HARD_PLANTS || new Set(chosen.map((p) => p.rule)).size < 2) return null;
    if (await behaviorMismatch(plantAll(clean, chosen), clean, SAME_BEHAVIOR)) return null;

    // generate.js's distractors: a variable said not to depend on one of its inputs, a stock that
    // starts above zero said to start at zero.
    const planted = new Set(chosen.map((p) => p.variable));
    const distractors = [];
    const user = vars.find((v) => !planted.has(v.name) && inputsOf(v.equation).length);
    if (user) distractors.push(`"${user.name}" should not depend on "${inputsOf(user.equation)[0].name}".`);
    const stock = clean.variables.find((v) => v.type === 'stock' && isNumericEquation(v.equation) && Number(v.equation) > 0);
    if (stock) distractors.push(`"${stock.name}" should start at zero.`);
    if (distractors.length < 2) return null;
    return { name: `${s.title} (hard)`, scenario: s.id, description: `the ${s.title.toLowerCase()}`, plants: chosen, distractors };
};
