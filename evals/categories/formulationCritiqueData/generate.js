/**
 * The general rule that makes formulationCritique cases for every scenario in the library whose
 * glossary model passes the formulation linter.
 *
 * Plants are pure matters of form, so the planted model computes exactly what the clean one does:
 *   - embedded constant: the first variable (in model order) with at least two inputs, one of them
 *     a named constant, has that constant's value written into its equation as a number
 *   - too many inputs: the first variable (in model order, another than the first plant's) that,
 *     with one of the intermediate variables it uses written out in place, has more than the
 *     linter's limit of inputs
 * Each plant must trip its linter rule on its variable. A case needs at least one plant.
 *
 * Distractors are claims about formulations that are fine: that a variable should not depend on
 * one of its inputs, and that a stock which starts above zero should start at zero.
 *
 * @module categories/formulationCritiqueData/generate
 */

import { lintFormulations, MAX_INPUTS } from '../../utilities/formulationLint.js';
import { findVariable, isNumericEquation, referencedNames, foldName } from '../../utilities/modelDiff.js';
import { correctModel as scenarioModel } from '../guidedCorrectionData/generate.js';

const under = (n) => n.replace(/\s+/g, '_');
const pattern = (name) => new RegExp(`(?<![A-Za-z0-9_])${under(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'i');
const trips = (model, variable, rule) => lintFormulations(model).some((f) => f.rule === rule && foldName(f.variable) === foldName(variable));

/** The scenario's glossary model over its own run settings: the clean model. */
export const cleanModel = scenarioModel;

/**
 * The generated case for one scenario, by the general rule, or null.
 * @param {Object} s A scenario from the library
 * @returns {Object|null} `{name, scenario, description, plants, distractors}`
 */
export const generateCase = function(s) {
    const clean = cleanModel(s);
    if (lintFormulations(clean).length) return null;
    const vars = clean.variables.filter((v) => v.type !== 'stock');
    const byFold = new Map(clean.variables.map((v) => [foldName(v.name), v]));
    const plants = [];
    const inputsOf = (equation) => [...referencedNames(equation)].map((n) => byFold.get(n)).filter(Boolean);

    for (const v of vars) {
        if (isNumericEquation(v.equation) || inputsOf(v.equation).length < 2) continue;
        const constant = inputsOf(v.equation).find((c) => c && c.type !== 'stock' && isNumericEquation(c.equation) && ![0, 1].includes(Number(c.equation)));
        if (!constant) continue;
        const equation = String(v.equation).replace(pattern(constant.name), String(Number(constant.equation)));
        const m = structuredClone(clean);
        findVariable(m.variables, v.name).equation = equation;
        if (!trips(m, v.name, 'embedded constant')) continue;
        plants.push({ id: `${constant.name} embedded in ${v.name}`, variable: v.name, rule: 'embedded constant', equation, text: `"${v.name}" has the value of "${constant.name}" (${Number(constant.equation)}) written into its equation as a number instead of using the named constant "${constant.name}".` });
        break;
    }

    inline: for (const v of vars) {
        if (plants.some((p) => p.variable === v.name) || isNumericEquation(v.equation)) continue;
        for (const n of referencedNames(v.equation)) {
            const a = byFold.get(n);
            if (!a || a.type === 'stock' || isNumericEquation(a.equation)) continue;
            const equation = String(v.equation).replace(pattern(a.name), `(${a.equation})`);
            const inputs = inputsOf(equation).length;
            if (inputs <= MAX_INPUTS) continue;
            const m = structuredClone(clean);
            findVariable(m.variables, v.name).equation = equation;
            if (!trips(m, v.name, 'too many inputs')) continue;
            plants.push({ id: `${a.name} inlined into ${v.name}`, variable: v.name, rule: 'too many inputs', equation, text: `"${v.name}" packs ${inputs} inputs into one equation by writing out the formula for "${a.name}" in place instead of using "${a.name}".` });
            break inline;
        }
    }
    if (!plants.length) return null;

    const planted = new Set(plants.map((p) => p.variable));
    const distractors = [];
    const user = vars.find((v) => !planted.has(v.name) && inputsOf(v.equation).length);
    if (user) distractors.push(`"${user.name}" should not depend on "${inputsOf(user.equation)[0].name}".`);
    const stock = clean.variables.find((v) => v.type === 'stock' && isNumericEquation(v.equation) && Number(v.equation) > 0);
    if (stock) distractors.push(`"${stock.name}" should start at zero.`);
    if (distractors.length < 2) return null;
    return { name: s.title, scenario: s.id, description: `the ${s.title.toLowerCase()}`, plants, distractors };
};
