/**
 * Model diffing for the evals.
 *
 * Several categories hand an engine a model and then need to know exactly what the engine
 * did to it: which variables it added or removed, and which equations, flows, units or
 * graphical functions it changed. The name and equation comparison here started life in
 * quantitativeErrorFixing.js and moved here unchanged so every category compares the same way;
 * quantitativeErrorFixing imports it back, so its results are untouched by the move.
 *
 * @module utilities/modelDiff
 */

import utils from '../../utilities/utils.js';

/**
 * Compare two variable names (case-insensitive and flexible matching)
 */
export const compareNames = function(name1, name2) {
    return utils.sameVars(name1, name2);
};

/**
 * Find a variable by name in an array of variables
 */
export const findVariable = function(variables, name) {
    return variables.find(v => compareNames(v.name, name));
};

/**
 * Compare two equations.
 *
 * The comparison is textual because an SD equation's *form* is part of what this category
 * measures — DELAY3(Infection, tau) and Exposed/tau compute similar things and only one of
 * them is the pipeline delay the prompt asked to preserve. But two forms of the same
 * literal, and two orderings of the same sum, say nothing about the modelling, and scoring
 * them as errors put false failures on the board: `1.7e+07` was marked wrong for being
 * written `17000000`, and a correct sum was marked wrong for listing its terms in a
 * different order.
 *
 * @param {String} eq1 The generated equation
 * @param {String} eq2 The expected equation
 * @returns {boolean} True when the two equations are the same equation
 */
export const compareEquations = function(eq1, eq2) {
    // "//" is SD-JSON's safe division, the same division with a guard against a zero
    // denominator, so a/b and a//b are the same formulation. Engines routinely write it,
    // and scoring it as a different equation failed otherwise correct repairs.
    const normalize = (eq) => {
        if (eq === undefined || eq === null) return '';
        return eq.toString().replace(/\s+/g, '').toLowerCase().replace(/\/\//g, '/');
    };

    const a = normalize(eq1);
    const b = normalize(eq2);
    if (a === b)
        return true;

    // Two spellings of one number. Number() rather than parseFloat: parseFloat("1x") is 1,
    // which would call an equation equal to a constant it merely starts with.
    const numA = Number(a);
    const numB = Number(b);
    if (a !== '' && b !== '' && Number.isFinite(numA) && Number.isFinite(numB))
        return numA === numB;

    // A sum of the same terms in a different order. Only plain sums qualify: once any other
    // operator is present the order of the terms can change what the equation computes.
    const sumTerms = (eq) => {
        if (!eq.includes('+') || /[-*\/^()]/.test(eq)) return null;
        return eq.split('+').map((term) => { return term.trim() }).sort();
    };
    const termsA = sumTerms(a);
    const termsB = sumTerms(b);
    if (termsA && termsB && termsA.length === termsB.length)
        return termsA.every((term, i) => { return term === termsB[i] });

    return false;
};

/**
 * Compare a generated equation to the expected one, looking through helper auxiliaries.
 *
 * The sum-error models carry a helper the correct model lacks ("Total population net flow",
 * a flow summing the stocks that feeds a "Total population" stock). Turning the helper into
 * an auxiliary and pointing the sum at it — Total population = Total_population_net_flow —
 * computes exactly what the reference computes, but a textual match against the sum failed
 * it. So when the generated equation is nothing but the name of another variable, and that
 * variable is an auxiliary the correct model does not have, its equation stands in for the
 * name. Only such helpers are looked through: aliasing a variable the correct model defines
 * is a different formulation, and flows and stocks are not pass-throughs.
 *
 * @param {Object} generatedVar The generated variable whose equation is being checked
 * @param {Object} correctVar The matching variable in the correct model
 * @param {Array<Object>} generatedVars Every variable in the generated model
 * @param {Array<Object>} correctVars Every variable in the correct model
 * @returns {boolean} True when the equations match directly or through helper auxiliaries
 */
export const equationMatchesThroughHelpers = function(generatedVar, correctVar, generatedVars, correctVars) {
    const seen = new Set();
    let equation = generatedVar.equation;
    while (true) {
        if (compareEquations(equation, correctVar.equation))
            return true;

        const reference = (equation ?? '').toString().trim();
        const helper = findVariable(generatedVars, reference);
        if (!helper || helper.type !== 'variable' || findVariable(correctVars, helper.name) || seen.has(helper.name))
            return false;

        seen.add(helper.name);
        equation = helper.equation;
    }
};

/**
 * Whether an equation is a bare numeric literal (a constant), e.g. "6", "0.25", "1e3".
 * @param {*} equation The equation as stored on an sd-json variable
 * @returns {boolean} True when the equation is just a number
 */
export const isNumericEquation = function(equation) {
    if (equation === undefined || equation === null) return false;
    const text = String(equation).trim();
    return text !== '' && Number.isFinite(Number(text));
};

/**
 * The fields of a variable a diff compares. Documentation and layout are deliberately left
 * out: they change nothing about what the model computes.
 */
const COMPARED_FIELDS = ['type', 'equation', 'inflows', 'outflows', 'units', 'graphicalFunction'];

const sameFlowList = function(a, b) {
    const left = a || [];
    const right = b || [];
    if (left.length !== right.length) return false;
    return left.every((name) => right.some((other) => compareNames(name, other)));
};

const sameGraphicalFunction = function(a, b) {
    return JSON.stringify(a?.points || null) === JSON.stringify(b?.points || null);
};

const sameUnits = function(a, b) {
    const normalize = (u) => (u ?? '').toString().replace(/\s+/g, '').toLowerCase();
    return normalize(a) === normalize(b);
};

const fieldsEqual = function(field, a, b) {
    switch (field) {
        case 'equation': return compareEquations(a, b);
        case 'inflows':
        case 'outflows': return sameFlowList(a, b);
        case 'graphicalFunction': return sameGraphicalFunction(a, b);
        case 'units': return sameUnits(a, b);
        default: return (a ?? null) === (b ?? null);
    }
};

/**
 * Diff two sd-json models variable by variable.
 *
 * Variables are matched by name with the same tolerant comparison quantitativeErrorFixing uses
 * (case, spaces and underscores do not matter). Relationships are not diffed: in a stock-and-flow
 * model they follow from the equations, and in a CLD a category that cares compares them itself.
 *
 * @param {Object} before The model the engine was given
 * @param {Object} after The model the engine returned
 * @returns {{added: Array<Object>, removed: Array<Object>, changed: Array<{name: string, field: string, before: *, after: *, variable: Object}>}}
 */
export const diffModels = function(before, after) {
    const beforeVars = before?.variables || [];
    const afterVars = after?.variables || [];
    const added = afterVars.filter((v) => !findVariable(beforeVars, v.name));
    const removed = beforeVars.filter((v) => !findVariable(afterVars, v.name));
    const changed = [];
    for (const original of beforeVars) {
        const updated = findVariable(afterVars, original.name);
        if (!updated) continue;
        for (const field of COMPARED_FIELDS) {
            if (!fieldsEqual(field, original[field], updated[field])) {
                changed.push({ name: original.name, field, before: original[field], after: updated[field], variable: original });
            }
        }
    }
    return { added, removed, changed };
};

/**
 * The identifiers an equation refers to, in the XMILE spelling (spaces as underscores), lower case.
 * Builtin function names are returned too; callers compare against variable names, which never
 * collide with a builtin in a valid model.
 * @param {*} equation The equation text
 * @returns {Set<string>} Referenced identifiers, folded to compare with {@link foldName}
 */
export const referencedNames = function(equation) {
    const names = new Set();
    const text = (equation ?? '').toString().replace(/"([^"]*)"/g, (_, quoted) => quoted.replace(/\s+/g, '_'));
    for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_.]*/g)) {
        names.add(foldName(match[0]));
    }
    return names;
};

/**
 * The folded form of a variable name used to compare it with identifiers inside equations.
 * @param {string} name A variable name in any spelling
 * @returns {string} Lower case, with runs of spaces and underscores as one underscore
 */
export const foldName = function(name) {
    return String(name ?? '').replace(/\\n/g, ' ').replace(/[\s_]+/g, '_').replace(/^_|_$/g, '').toLowerCase();
};
