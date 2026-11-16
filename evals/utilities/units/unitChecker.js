/**
 * A deterministic dimensional-consistency checker for sd-json stock-and-flow models.
 *
 * It infers the units of every equation from the declared units of the variables it references,
 * and reports where they disagree:
 *   - an auxiliary or flow whose equation's units differ from the units declared on it
 *   - a sum, difference, comparison, MIN/MAX or IF branch combining different units
 *   - a stock whose inflows and outflows are not in the stock's units per time unit
 *   - a stock whose initial value is not in the stock's units
 *   - a function given an argument of the wrong kind (EXP of a quantity with units, a delay time
 *     that is not a time)
 *
 * Conventions, chosen to match how modelers write units and how Stella checks them:
 *   - a number written in an equation has no fixed units. In a sum or comparison it takes the
 *     units of what it is combined with ("Stock - 5"); in a product it is a plain number.
 *   - a variable with no declared units, or units that cannot be read, is unknown, and nothing is
 *     reported about expressions that depend on it (the "Missing units" report covers it instead)
 *   - a lookup's output carries its variable's declared units
 *
 * The output is a list of warnings, each `{variable, kind, message}`. Kinds: 'mismatch', 'equation',
 * 'stock', 'initial' and 'function' are dimensional inconsistencies; 'missing' is a variable with
 * no readable units; 'unparsed' is an equation this checker cannot read (arrays, unusual syntax),
 * which says nothing about the model's units. INCONSISTENCY_KINDS lists the first group.
 *
 * @module utilities/units/unitChecker
 */

import { parseEquation } from './equationParser.js';
import { parseUnits, unitVocabulary, multiplyUnits, divideUnits, powerUnits, sameUnits, isDimensionless, formatUnits, DIMENSIONLESS } from './unitAlgebra.js';

/** The warning kinds that are dimensional inconsistencies in the model. */
export const INCONSISTENCY_KINDS = new Set(['mismatch', 'equation', 'stock', 'initial', 'function']);

const fold = (name) => String(name ?? '').replace(/\\n/g, ' ').replace(/"/g, '').replace(/[\s_]+/g, '_').replace(/^_|_$/g, '').toLowerCase();

/** An inferred value's units: known, a free number, or unknown. */
const known = (unit) => ({ kind: 'known', unit });
const FREE = { kind: 'free' };
const UNKNOWN = { kind: 'unknown' };

const SAME_AS_ARGUMENT = new Set(['ABS', 'INT', 'ROUND', 'MIN', 'MAX', 'SAFEDIV_SAME']);
const DIMENSIONLESS_FUNCTIONS = new Set(['EXP', 'LN', 'LOG10', 'LOG', 'SIN', 'COS', 'TAN', 'ARCSIN', 'ARCCOS', 'ARCTAN']);
const SMOOTHS = new Set(['SMTH1', 'SMTH3', 'SMTHN', 'DELAY', 'DELAY1', 'DELAY3', 'DELAYN', 'FORCST', 'DELAY_FIXED', 'DELAY_MATERIAL', 'DELAYINFORMATION', 'SMOOTH', 'SMOOTH3', 'SMOOTHI', 'SMOOTH3I', 'DELAY3I', 'DELAY1I']);
const TEST_INPUTS = new Set(['STEP', 'PULSE', 'RAMP', 'RANDOM', 'NORMAL', 'UNIFORM', 'POISSON', 'LOGNORMAL', 'EXPRND', 'INIT', 'PREVIOUS']);

/**
 * Check a model's units.
 *
 * @param {Object} model An sd-json model
 * @returns {Array<{variable: string, kind: string, message: string}>} Warnings; empty when consistent
 */
export const checkUnits = function(model) {
    const variables = (model?.variables || []).filter((v) => v && typeof v.name === 'string');
    const byName = new Map(variables.map((v) => [fold(v.name), v]));
    const vocabulary = unitVocabulary([model?.specs?.timeUnits, ...variables.map((v) => v.units)]);
    const timeUnit = parseUnits(model?.specs?.timeUnits, vocabulary);
    const declared = new Map(variables.map((v) => [fold(v.name), parseUnits(v.units, vocabulary)]));
    const warnings = [];
    const warn = (variable, kind, message) => warnings.push({ variable: variable.name, kind, message });

    for (const v of variables) {
        if (v.type === 'module' || v.crossLevelGhostOf) continue;
        if (declared.get(fold(v.name)) === null) {
            warn(v, 'missing', v.units ? `"${v.name}" has units "${v.units}" that cannot be read.` : `"${v.name}" has no units.`);
        }
    }

    /**
     * Infer the units of an expression, reporting conflicts inside it against variable `owner`.
     */
    const infer = (node, owner) => {
        switch (node.type) {
            case 'number': return FREE;
            case 'name': {
                const upper = node.name.toUpperCase();
                if (upper === 'TIME' || upper === 'DT' || upper === 'STARTTIME' || upper === 'STOPTIME' || upper === 'INITIAL_TIME' || upper === 'FINAL_TIME') {
                    return timeUnit ? known(timeUnit) : UNKNOWN;
                }
                if (upper === 'PI' || upper === 'INF' || upper === 'NAN') return FREE;
                const target = byName.get(fold(node.name));
                if (!target) return UNKNOWN;
                const unit = declared.get(fold(target.name));
                return unit ? known(unit) : UNKNOWN;
            }
            case 'unary': {
                const arg = infer(node.arg, owner);
                return node.op === 'not' ? known(DIMENSIONLESS) : arg;
            }
            case 'if': {
                infer(node.cond, owner);
                return combineSame([infer(node.then, owner), infer(node.else, owner)], owner, 'the two branches of an IF');
            }
            case 'binary': {
                const left = infer(node.left, owner);
                const right = infer(node.right, owner);
                switch (node.op) {
                    case '+': case '-':
                        return combineSame([left, right], owner, `the two sides of "${node.op}"`);
                    case '=': case '<>': case '<': case '<=': case '>': case '>=':
                        combineSame([left, right], owner, 'the two sides of a comparison');
                        return known(DIMENSIONLESS);
                    case 'and': case 'or':
                        return known(DIMENSIONLESS);
                    case '*': case '/': case '//': {
                        if (left.kind === 'unknown' || right.kind === 'unknown') return UNKNOWN;
                        const l = left.kind === 'free' ? DIMENSIONLESS : left.unit;
                        const r = right.kind === 'free' ? DIMENSIONLESS : right.unit;
                        if (left.kind === 'free' && right.kind === 'free') return FREE;
                        return known(node.op === '*' ? multiplyUnits(l, r) : divideUnits(l, r));
                    }
                    case '^': {
                        if (left.kind !== 'known') return left;
                        const exponent = node.right.type === 'number' ? node.right.value
                            : node.right.type === 'unary' && node.right.arg.type === 'number' ? (node.right.op === '-' ? -node.right.arg.value : node.right.arg.value)
                            : null;
                        if (Number.isInteger(exponent)) return known(powerUnits(left.unit, exponent));
                        if (!isDimensionless(left.unit)) warn(owner, 'function', `"${owner.name}" raises a quantity in ${formatUnits(left.unit)} to a power that is not a whole number.`);
                        return known(DIMENSIONLESS);
                    }
                    default: return UNKNOWN;
                }
            }
            case 'call': {
                const args = node.args.map((a) => infer(a, owner));
                const name = node.name;
                if (SAME_AS_ARGUMENT.has(name)) return combineSame(args, owner, `the arguments of ${name}`);
                if (name === 'SQRT') {
                    const a = args[0];
                    if (a?.kind !== 'known') return a ?? UNKNOWN;
                    if ([...a.unit.values()].some((e) => e % 2 !== 0)) { warn(owner, 'function', `"${owner.name}" takes the square root of ${formatUnits(a.unit)}.`); return UNKNOWN; }
                    return known(powerUnits(a.unit, 0.5));
                }
                if (DIMENSIONLESS_FUNCTIONS.has(name)) {
                    if (args[0]?.kind === 'known' && !isDimensionless(args[0].unit)) {
                        warn(owner, 'function', `"${owner.name}" applies ${name} to a quantity in ${formatUnits(args[0].unit)}; it needs a plain number.`);
                    }
                    return known(DIMENSIONLESS);
                }
                if (name === 'TREND') {
                    // TREND returns a fractional growth rate per time unit, not its input's units.
                    return timeUnit ? known(divideUnits(DIMENSIONLESS, timeUnit)) : UNKNOWN;
                }
                if (SMOOTHS.has(name)) {
                    const delay = args[1];
                    if (delay?.kind === 'known' && timeUnit && !sameUnits(delay.unit, timeUnit)) {
                        warn(owner, 'function', `"${owner.name}" uses ${name} with a delay time in ${formatUnits(delay.unit)}, not in ${formatUnits(timeUnit)}.`);
                    }
                    return args[0] ?? UNKNOWN;
                }
                if (name === 'SAFEDIV' || name === 'ZIDZ' || name === 'XIDZ') {
                    if (args[0]?.kind === 'known' && args[1]?.kind === 'known') return known(divideUnits(args[0].unit, args[1].unit));
                    return UNKNOWN;
                }
                if (name === 'IF_THEN_ELSE') return combineSame([args[1], args[2]].filter(Boolean), owner, 'the two branches of IF_THEN_ELSE');
                if (TEST_INPUTS.has(name)) return name === 'INIT' || name === 'PREVIOUS' ? (args[0] ?? UNKNOWN) : FREE;
                if (name === 'LOOKUP' || name === 'GRAPH') return UNKNOWN;
                return UNKNOWN;
            }
            default: return UNKNOWN;
        }
    };

    /** Values that must share units; reports the first disagreement and returns the shared unit. */
    const combineSame = (values, owner, where) => {
        const knowns = values.filter((v) => v.kind === 'known');
        if (values.some((v) => v.kind === 'unknown')) return UNKNOWN;
        if (knowns.length === 0) return FREE;
        const first = knowns[0].unit;
        const clash = knowns.find((k) => !sameUnits(k.unit, first));
        if (clash) {
            warn(owner, 'mismatch', `"${owner.name}" combines ${formatUnits(first)} with ${formatUnits(clash.unit)} in ${where}.`);
            return UNKNOWN;
        }
        return known(first);
    };

    for (const v of variables) {
        if (v.type === 'module' || v.crossLevelGhostOf) continue;
        const target = declared.get(fold(v.name));
        let ast = null;
        const equation = v.equation === undefined || v.equation === null ? '' : String(v.equation).trim();
        if (equation) {
            try {
                ast = parseEquation(equation);
            } catch (error) {
                warn(v, 'unparsed', `The equation of "${v.name}" could not be read for a unit check: ${error.message}`);
            }
        }

        // A lookup's output is in the variable's own units whatever its input is; its input
        // expression is still checked for internal conflicts.
        const inferred = ast ? infer(ast, v) : UNKNOWN;
        // Lookups come as {points: [...]} or as a bare array of points; SDJsonToXMILE accepts both.
        const points = Array.isArray(v.graphicalFunction) ? v.graphicalFunction : v.graphicalFunction?.points;
        const isLookup = Array.isArray(points) && points.length > 0;

        if (v.type === 'stock') {
            if (target && inferred.kind === 'known' && !sameUnits(inferred.unit, target)) {
                warn(v, 'initial', `The initial value of stock "${v.name}" is in ${formatUnits(inferred.unit)}, but the stock is in ${formatUnits(target)}.`);
            }
            if (target && timeUnit) {
                const expected = divideUnits(target, timeUnit);
                for (const flowName of [...(v.inflows || []), ...(v.outflows || [])]) {
                    const flow = byName.get(fold(flowName));
                    const flowUnit = flow ? declared.get(fold(flow.name)) : null;
                    if (flowUnit && !sameUnits(flowUnit, expected)) {
                        warn(v, 'stock', `Flow "${flowName}" of stock "${v.name}" is in ${formatUnits(flowUnit)}, but a flow of a stock in ${formatUnits(target)} must be in ${formatUnits(expected)}.`);
                    }
                }
            }
        } else if (!isLookup && target && inferred.kind === 'known' && !sameUnits(inferred.unit, target)) {
            warn(v, 'equation', `The equation of "${v.name}" works out to ${formatUnits(inferred.unit)}, but "${v.name}" is declared in ${formatUnits(target)}.`);
        }
    }
    return warnings;
};
