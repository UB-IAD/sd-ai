/**
 * The sign of an equation's dependence on each variable it uses.
 *
 * A causal link's polarity in a stock-and-flow model is the sign of the partial derivative of the
 * equation with respect to the input. This works it out from the equation's structure, assuming —
 * as system dynamics models nearly always may — that the quantities involved are positive:
 *   - a sum carries each term's sign; a difference flips the subtracted term's
 *   - in a product or quotient each factor's contribution is multiplied by the sign of the other
 *     factor's value (a number has its own sign; a difference such as a gap has no fixed sign, so a
 *     time constant dividing a gap gets '?'); a quotient flips the denominator's
 *   - MIN, MAX, IF branches, and monotone functions (EXP, LN, SQRT, smoothing and delays) carry
 *     their arguments' signs; a positive power keeps its base's
 *   - where two contributions disagree, or a function is not monotone, the sign is unknown ('?')
 *
 * Signs are '+', '-', '?', or 0 when the equation does not depend on the variable.
 *
 * @module utilities/units/equationSign
 */

import { parseEquation } from './equationParser.js';

const MONOTONE = new Set(['EXP', 'LN', 'LOG10', 'SQRT', 'SMTH1', 'SMTH3', 'SMTHN', 'DELAY', 'DELAY1', 'DELAY3', 'DELAYN', 'DELAY_FIXED', 'SMOOTH', 'SMOOTH3', 'INIT', 'PREVIOUS', 'INT', 'ROUND', 'MIN', 'MAX']);

const flip = (s) => (s === '+' ? '-' : s === '-' ? '+' : s);

/** Combine two contributions to one derivative. */
const combine = (a, b) => {
    if (a === 0) return b;
    if (b === 0) return a;
    if (a === b) return a;
    return '?';
};

/** Multiply a dependence sign by a value sign ('+', '-' or '?'). */
const times = (dep, value) => {
    if (dep === 0) return 0;
    if (dep === '?' || value === '?') return '?';
    return dep === value ? '+' : '-';
};

/**
 * The sign of an expression's value, assuming every variable is positive: '+', '-' or '?'.
 * A difference has no fixed sign (a gap can go either way); a number has its own.
 */
const valueSign = function(node, named) {
    switch (node.type) {
        case 'number': return node.value > 0 ? '+' : node.value < 0 ? '-' : '?';
        // A variable is taken as positive unless its own equation says otherwise (a named gap,
        // desired - actual, can be either sign): `named` maps folded names to their value signs.
        case 'name': return named.get(node.name.toLowerCase().replace(/[\s_]+/g, '_')) ?? '+';
        case 'unary': return node.op === '-' ? flip(valueSign(node.arg, named)) : node.op === 'not' ? '?' : valueSign(node.arg, named);
        case 'if': { const a = valueSign(node.then, named); const b = valueSign(node.else, named); return a === b ? a : '?'; }
        case 'binary': {
            const l = valueSign(node.left, named);
            const r = valueSign(node.right, named);
            switch (node.op) {
                case '+': return l === r ? l : '?';
                case '*': case '/': case '//': return (l === '?' || r === '?') ? '?' : (l === r ? '+' : '-');
                case '^': return l === '+' ? '+' : '?';
                default: return '?';
            }
        }
        case 'call': {
            if (['EXP', 'SQRT'].includes(node.name)) return '+';
            if (['MAX'].includes(node.name)) return node.args.some((a) => valueSign(a, named) === '+') ? '+' : '?';
            if (['MIN'].includes(node.name)) return node.args.every((a) => valueSign(a, named) === '+') ? '+' : '?';
            if (/^(SMTH|DELAY|SMOOTH)/.test(node.name) || ['INIT', 'PREVIOUS', 'ABS'].includes(node.name)) return node.name === 'ABS' ? '+' : valueSign(node.args[0] ?? { type: 'number', value: 0 }, named);
            return '?';
        }
        default: return '?';
    }
};

/**
 * The sign of d(node)/d(target), with names folded by `fold`.
 */
const signOf = function(node, target, fold, named) {
    switch (node.type) {
        case 'number': return 0;
        case 'name': return fold(node.name) === target ? '+' : 0;
        case 'unary': return node.op === '-' ? flip(signOf(node.arg, target, fold, named)) : node.op === 'not' ? (signOf(node.arg, target, fold, named) === 0 ? 0 : '?') : signOf(node.arg, target, fold, named);
        case 'if': {
            if (signOf(node.cond, target, fold, named) !== 0) return '?';
            return combine(signOf(node.then, target, fold, named), signOf(node.else, target, fold, named));
        }
        case 'binary': {
            const l = signOf(node.left, target, fold, named);
            const r = signOf(node.right, target, fold, named);
            switch (node.op) {
                case '+': return combine(l, r);
                case '-': return combine(l, flip(r));
                // d(ab) = a'b + ab'; d(a/b) = a'/b - ab'/b², with b² > 0.
                case '*': return combine(times(l, valueSign(node.right, named)), times(r, valueSign(node.left, named)));
                case '/': case '//': return combine(times(l, valueSign(node.right, named)), flip(times(r, valueSign(node.left, named))));
                case '^': {
                    if (r !== 0) return '?';
                    const exponent = node.right.type === 'number' ? node.right.value : node.right.type === 'unary' && node.right.arg.type === 'number' ? -node.right.arg.value : null;
                    if (exponent === null || valueSign(node.left, named) !== '+') return l === 0 ? 0 : '?';
                    return exponent > 0 ? l : exponent < 0 ? flip(l) : 0;
                }
                default: return (l === 0 && r === 0) ? 0 : '?';
            }
        }
        case 'call': {
            const signs = node.args.map((a) => signOf(a, target, fold, named));
            if (MONOTONE.has(node.name)) {
                // Smoothing and delays depend on their input monotonically; their time arguments do
                // not have a fixed sign of effect, so a dependence through them is unknown.
                const isSmooth = /^(SMTH|DELAY|SMOOTH)/.test(node.name);
                if (isSmooth) return signs.slice(1).some((x) => x !== 0) ? '?' : signs[0] ?? 0;
                return signs.reduce(combine, 0);
            }
            if (['SAFEDIV', 'ZIDZ', 'XIDZ'].includes(node.name)) {
                const [a, b] = node.args;
                return combine(times(signs[0] ?? 0, b ? valueSign(b, named) : '?'), flip(times(signs[1] ?? 0, a ? valueSign(a, named) : '?')));
            }
            return signs.some((x) => x !== 0) ? '?' : 0;
        }
        default: return '?';
    }
};

/**
 * The direction of a lookup: '+' when its outputs never fall as its input rises, '-' when they never
 * rise, '?' otherwise.
 * @param {Object|Array} graphicalFunction A graphical function ({points} or a bare array)
 * @returns {string} '+', '-' or '?'
 */
export const lookupDirection = function(graphicalFunction) {
    const points = (Array.isArray(graphicalFunction) ? graphicalFunction : graphicalFunction?.points || []).slice().sort((a, b) => a.x - b.x);
    if (points.length < 2) return '?';
    const steps = points.slice(1).map((p, i) => p.y - points[i].y);
    if (steps.every((d) => d >= 0) && steps.some((d) => d > 0)) return '+';
    if (steps.every((d) => d <= 0) && steps.some((d) => d < 0)) return '-';
    return '?';
};

/**
 * The sign of an equation's dependence on each of the given variables.
 *
 * @param {string} equation The equation
 * @param {Array<string>} names Variable names to test, in any spelling
 * @param {function(string): string} fold Folds a name for comparison
 * @param {Map<string, string>} named Value signs of named variables (see variableValueSigns); a
 *   variable not in it is taken as positive
 * @returns {Map<string, string>|null} Folded name to '+', '-' or '?', for the names the equation
 *   depends on; null when the equation cannot be parsed
 */
export const dependenceSigns = function(equation, names, fold, named) {
    let ast;
    try {
        ast = parseEquation(String(equation));
    } catch {
        return null;
    }
    const out = new Map();
    for (const name of names) {
        const target = fold(name);
        const sign = signOf(ast, target, fold, named);
        if (sign !== 0) out.set(target, sign);
    }
    return out;
};

/**
 * The value sign of each non-stock variable from its own equation, one level deep (the variables it
 * uses are taken as positive): a gap such as desired - actual is '?', a rate is '+'. Stocks are
 * positive. Keys are folded with the same rule valueSign uses for names.
 * @param {Array<Object>} variables sd-json variables
 * @returns {Map<string, string>} Folded name to '+', '-' or '?'
 */
export const variableValueSigns = function(variables) {
    const out = new Map();
    for (const v of variables) {
        if (!v || typeof v.name !== 'string' || v.type === 'stock') continue;
        const points = Array.isArray(v.graphicalFunction) ? v.graphicalFunction : (v.graphicalFunction?.points || []);
        if (points.length > 0) {
            // A lookup's value is whatever its table says: positive, negative or either.
            const ys = points.map((pt) => Number(pt.y));
            out.set(v.name.toLowerCase().replace(/[\s_]+/g, '_'), ys.every((y) => y >= 0) ? '+' : ys.every((y) => y <= 0) ? '-' : '?');
            continue;
        }
        let ast;
        try { ast = parseEquation(String(v.equation ?? '')); } catch { continue; }
        out.set(v.name.toLowerCase().replace(/[\s_]+/g, '_'), valueSign(ast, new Map()));
    }
    return out;
};
