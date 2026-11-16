/**
 * A deterministic best-practice linter for sd-json stock-and-flow formulations.
 *
 * It flags the formulation habits system dynamics texts warn against and reviewers catch:
 *   - 'too many inputs': an equation that combines more than MAX_INPUTS model variables; such
 *     formulations are hard to read and to check
 *   - 'embedded constant': a number other than 0 or 1 written into a flow or auxiliary equation
 *     instead of being its own named, documented constant (numbers inside graphical functions,
 *     integer exponents and stock initial values are fine; so is an auxiliary whose whole equation
 *     is a number, which is the constant's definition; STEP and PULSE heights and times are numbers
 *     too and should be named)
 *   - an IF whose condition tests a stock guards divisions by it in its branches
 *   - 'unguarded division': dividing by an expression that reaches zero when a stock does — a bare
 *     stock, a difference involving one, a product with such a factor — without a guard (safe
 *     division //, MAX, ZIDZ/XIDZ/SAFEDIV, or an IF testing the stock). A stock plus a positive
 *     constant, the usual saturation form, cannot reach zero and is not flagged
 *   - 'hard-coded time switch': an equation comparing TIME to a number, where a STEP, PULSE or a
 *     named switch time would make the test input visible and adjustable
 *
 * The linter reads structure only; whether a flow can drive its stock negative needs a run and is
 * checked by the extreme-conditions tooling instead.
 *
 * @module utilities/formulationLint
 */

import { parseEquation } from './units/equationParser.js';

export const MAX_INPUTS = 4;

const fold = (name) => String(name ?? '').replace(/\\n/g, ' ').replace(/"/g, '').replace(/[\s_]+/g, '_').replace(/^_|_$/g, '').toLowerCase();

const GUARDS = new Set(['MAX', 'ZIDZ', 'XIDZ', 'SAFEDIV']);

/**
 * Lint a model.
 * @param {Object} model An sd-json model
 * @returns {Array<{variable: string, rule: string, message: string}>} Findings; empty when clean
 */
export const lintFormulations = function(model) {
    const variables = (model?.variables || []).filter((v) => v && typeof v.name === 'string');
    const byName = new Map(variables.map((v) => [fold(v.name), v]));
    const findings = [];
    const flag = (v, rule, message) => findings.push({ variable: v.name, rule, message });

    for (const v of variables) {
        if (v.type === 'stock' || v.type === 'module' || v.crossLevelGhostOf) continue;
        const equation = v.equation === undefined || v.equation === null ? '' : String(v.equation).trim();
        if (!equation) continue;
        let ast;
        try {
            ast = parseEquation(equation);
        } catch {
            continue;
        }
        const isLookup = Array.isArray(v.graphicalFunction) ? v.graphicalFunction.length > 0 : (v.graphicalFunction?.points || []).length > 0;

        const inputs = new Set();
        const numbers = [];
        let unguardedDivision = null;
        let timeSwitch = false;

        const containsStock = (node) => {
            if (!node) return false;
            if (node.type === 'name') return byName.get(fold(node.name))?.type === 'stock';
            if (node.type === 'call' && GUARDS.has(node.name)) return false;
            return ['arg', 'left', 'right', 'cond', 'then', 'else'].some((k) => containsStock(node[k])) || (node.args || []).some(containsStock);
        };
        // Whether a denominator can reach zero because a stock does: a bare stock can, a difference
        // involving one can, a product can if any factor can, a sum only if every term can (a stock
        // plus a positive constant, the usual saturation form, cannot). Guarded calls cannot.
        const canReachZero = (node) => {
            if (!node) return false;
            switch (node.type) {
                case 'name': return byName.get(fold(node.name))?.type === 'stock';
                case 'unary': return canReachZero(node.arg);
                case 'binary':
                    if (node.op === '+') return canReachZero(node.left) && canReachZero(node.right);
                    if (node.op === '-') return containsStock(node.left) || containsStock(node.right);
                    if (node.op === '*') return canReachZero(node.left) || canReachZero(node.right);
                    if (node.op === '/' || node.op === '//') return canReachZero(node.left);
                    return containsStock(node);
                case 'if': return canReachZero(node.then) || canReachZero(node.else);
                case 'call': return !GUARDS.has(node.name) && node.args.some(canReachZero);
                default: return false;
            }
        };
        const isNumber = (node) => node?.type === 'number' || (node?.type === 'unary' && node.arg?.type === 'number');
        const isTime = (node) => node?.type === 'name' && /^time$/i.test(node.name);

        const walk = (node, guarded, inExponent) => {
            switch (node.type) {
                case 'number':
                    if (!inExponent && node.value !== 0 && node.value !== 1) numbers.push(node.value);
                    return;
                case 'unary':
                    // -0.3 is one number, not a negation of one.
                    if (node.op === '-' && node.arg.type === 'number') {
                        if (!inExponent && node.arg.value !== 0 && node.arg.value !== 1) numbers.push(-node.arg.value);
                        return;
                    }
                    walk(node.arg, guarded, inExponent);
                    return;
                case 'name':
                    if (byName.has(fold(node.name))) inputs.add(fold(node.name));
                    return;
                case 'if':
                    // IF S > 0 THEN k / S ELSE ... guards the division by S in its branches.
                    walk(node.cond, guarded, inExponent);
                    walk(node.then, guarded || containsStock(node.cond), inExponent);
                    walk(node.else, guarded || containsStock(node.cond), inExponent);
                    return;
                case 'call': {
                    const guard = GUARDS.has(node.name);
                    node.args.forEach((a) => walk(a, guarded || guard, inExponent));
                    return;
                }
                case 'binary': {
                    if (node.op === '/' && !guarded && canReachZero(node.right)) unguardedDivision = unguardedDivision ?? node;
                    if (['>', '>=', '<', '<=', '='].includes(node.op) && ((isTime(node.left) && isNumber(node.right)) || (isTime(node.right) && isNumber(node.left)))) timeSwitch = true;
                    walk(node.left, guarded, inExponent);
                    walk(node.right, guarded, inExponent || node.op === '^');
                    return;
                }
                default: return;
            }
        };
        walk(ast, false, false);

        if (inputs.size > MAX_INPUTS) flag(v, 'too many inputs', `"${v.name}" combines ${inputs.size} variables; best practice is at most ${MAX_INPUTS}, with intermediate variables naming the parts.`);
        const isDefinition = v.type === 'variable' && (ast.type === 'number' || (ast.type === 'unary' && ast.arg.type === 'number'));
        if (numbers.length && !isLookup && !isDefinition) {
            flag(v, 'embedded constant', `"${v.name}" has the number${numbers.length > 1 ? 's' : ''} ${numbers.join(', ')} written into its equation; give ${numbers.length > 1 ? 'each' : 'it'} a named constant.`);
        }
        if (unguardedDivision) flag(v, 'unguarded division', `"${v.name}" divides by an expression containing a stock with no guard against it reaching zero.`);
        if (timeSwitch) flag(v, 'hard-coded time switch', `"${v.name}" compares TIME to a number; use STEP or PULSE with a named switch time so the test input is visible.`);
    }
    return findings;
};
