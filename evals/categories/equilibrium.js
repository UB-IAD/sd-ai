/**
 * This is the equilibrium test
 *
 * Putting a model into equilibrium, so that every stock holds steady until something disturbs
 * it, is one of the first things a modeler does with a working model: it is the baseline every
 * policy test and every disturbance is read against. This category hands the engine a model that
 * starts out of equilibrium, tells it exactly which equations it may change (stock initial values,
 * and in some cases a constant), and asks it to put the named stocks into equilibrium.
 *
 * Grading is entirely deterministic. The returned model is diffed against the one the engine was
 * given, so any change outside the permitted set fails the test, which rules out the shortcuts
 * that make a model "flat" without balancing it: zeroing a flow, cutting a loop, or rewriting an
 * equation. The model is then simulated through PySD on the original simulation specs and every
 * named stock must stay within a small band of its initial value for the whole run.
 *
 * @module categories/equilibrium
 */

import { validateEvaluationResult } from '../evaluationSchema.js';
import { diffModels, findVariable, referencedNames, foldName, isNumericEquation } from '../utilities/modelDiff.js';
import { simulateModel, bareModel, allFinite } from '../utilities/simulateModel.js';
import { parseEquation } from '../utilities/units/equationParser.js';
import { cases as handCases } from './equilibriumData/models.js';
import { withFloors } from '../floors/statement.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scenarios } from '../utilities/scenarios/library.js';
import { caseModel, HORIZONS, NON_TRIVIAL } from './equilibriumData/generate.js';
import { splitHeldOut, caseHeldOut } from '../utilities/heldOut.js';

const GENERATED = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'equilibriumData', 'generated.json'), 'utf8'));
/**
 * Cases made by the general rule in equilibriumData/generate.js for every scenario in the library
 * (see buildGenerated.js), on the scenario's glossary model. Entries for a scenario that is not
 * registered (a stale file) are skipped.
 */
export const generatedCases = Object.fromEntries(Object.entries(GENERATED).filter(([, g]) => scenarios[g.scenario]).map(([name, g]) => [name, { ...g, model: caseModel(scenarios[g.scenario], g.postStep) }]));
/**
 * The hard group's cases, by the general rule in equilibriumData/hard.js on the generated scenario
 * cases (frozen in hardGenerated.json, re-derived by the unit tests): one stock held at a stated
 * level that only a changed value of one constant gives, every stock in equilibrium, with which
 * constant withheld: any one of the model's constants may change, no more.
 */
const HARD_GENERATED = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'equilibriumData', 'hardGenerated.json'), 'utf8'));
export const hardGeneratedCases = Object.fromEntries(Object.entries(HARD_GENERATED).filter(([, g]) => scenarios[g.scenario]).map(([name, g]) => [name, { ...g, model: caseModel(scenarios[g.scenario], g.postStep) }]));
export const cases = { ...handCases, ...generatedCases, ...hardGeneratedCases };

/**
 * How far a stock may wander from its initial value, as a fraction of that value, and still count
 * as in equilibrium. Large enough that an engine which rounds a computed equilibrium to a few
 * significant figures passes; small enough that a stock still visibly moving fails.
 */
export const RELATIVE_TOLERANCE = 0.02;

/** How far a constrained initial total may sit from its target, as a fraction of the target. */
export const TOTAL_TOLERANCE = 0.01;

/**
 * Returns the description for this category
 * @returns {string} The description describing this category
 */
export const description = () => {
    return `The equilibrium test evaluates whether an engine can parameterize a stock-and-flow model so that it starts in equilibrium. The engine is given a model that starts out of balance and told exactly which initial values or constants it may change; it passes when every named stock stays steady over the whole simulation and nothing outside the permitted changes was touched.`;
};

const listNames = (names) => names.map((n) => `"${n}"`).join(', ');

/**
 * Generates an equilibrium test for a given case.
 * @param {string} name The case name
 * @returns {Object} Test case with prompt, model, parameters and expectations
 */
const generateTest = function(name) {
    const c = cases[name];
    const stocks = c.model.variables.filter((v) => v.type === 'stock').map((v) => v.name);
    const adjustableStocks = c.adjustable.filter((n) => stocks.includes(n));
    const adjustableConstants = c.adjustable.filter((n) => !stocks.includes(n));

    const permissions = [];
    if (adjustableStocks.length) permissions.push(`the initial values of ${listNames(adjustableStocks)}`);
    if (adjustableConstants.length) permissions.push(`the value${adjustableConstants.length > 1 ? 's' : ''} of ${listNames(adjustableConstants)}`);
    // Withheld feedback (hard group): any one constant may change, and the prompt does not say which.
    if (c.oneConstantOf) permissions.push('the value of one constant — any one variable whose equation is a plain number; which one is for you to work out — and no more than one');

    const prompt = `This model of ${c.description} does not start in equilibrium: when I run it, its stocks move even though nothing is disturbing it. Please put ${listNames(c.equilibriumStocks)} into equilibrium, so that ${c.equilibriumStocks.length > 1 ? 'each of them stays' : 'it stays'} constant over the whole simulation.

You may change only ${permissions.join(' and ')}. Do not change any other equation, do not add or remove flows or feedback, and do not change the simulation specs.${c.frozen ? ` ${c.frozen}` : ''}

Return the complete updated model.`;

    return {
        name: `${name} equilibrium`,
        prompt,
        currentModel: c.model,
        additionalParameters: {
            problemStatement: `I want a baseline run of my model of ${c.description} in which nothing changes until I disturb it.`
        },
        expectations: {
            originalModel: c.model,
            adjustable: c.adjustable,
            ...(c.oneConstantOf ? { oneConstantOf: c.oneConstantOf } : {}),
            equilibriumStocks: c.equilibriumStocks,
            fixedInitial: c.fixedInitial || null,
            fixedTotal: c.fixedTotal || null,
            nonTrivial: c.nonTrivial || null
        }
    };
};

/**
 * Check the returned model changes only what the test permits.
 *
 * Permitted: the initial value of an adjustable stock (any expression), a new number for an
 * adjustable constant, unit spellings and documentation, and new helper variables that feed only stock initial values
 * (an engine may reasonably write `initial prey = 400` and point the stock at it). Everything
 * else that differs from the given model is a structural change and fails the test.
 */
/**
 * Whether an equation is a constant: a number, or arithmetic on numbers ("1/45") that refers to
 * no variable of the model.
 */
const isConstantExpression = function(equation, model) {
    if (isNumericEquation(equation)) return true;
    let ast;
    try {
        ast = parseEquation(String(equation));
    } catch {
        return false;
    }
    const names = new Set((model.variables || []).map((v) => foldName(v.name)));
    const refersToModel = (node) => {
        switch (node.type) {
            case 'number': return false;
            case 'name': return names.has(foldName(node.name)) || /^(time|dt)$/i.test(node.name);
            case 'unary': return refersToModel(node.arg);
            case 'binary': return refersToModel(node.left) || refersToModel(node.right);
            case 'if': return refersToModel(node.cond) || refersToModel(node.then) || refersToModel(node.else);
            case 'call': return node.args.some(refersToModel);
            default: return true;
        }
    };
    return !refersToModel(ast);
};

const structuralFailures = function(original, generated, adjustable) {
    const failures = [];
    const diff = diffModels(original, generated);
    const isAdjustable = (name) => adjustable.some((a) => foldName(a) === foldName(name));

    for (const removed of diff.removed) {
        failures.push({ type: 'Model structure changed', details: `Variable "${removed.name}" was removed from the model.` });
    }

    for (const change of diff.changed) {
        if (change.field === 'units') continue;
        // A stock's initial value may be any expression: it is evaluated once, at the start. An
        // adjustable constant must stay a constant — rewriting it as an expression of the model's
        // state adds the very feedback the prompt rules out, and can hold a stock flat by force.
        if (change.field === 'equation' && isAdjustable(change.name) && (change.variable.type === 'stock' || isConstantExpression(change.after, generated))) continue;
        failures.push({
            type: 'Model structure changed',
            details: `The ${change.field} of "${change.name}" changed from ${JSON.stringify(change.before)} to ${JSON.stringify(change.after)}, but only ${adjustable.map((n) => `"${n}"`).join(', ')} may be changed.`
        });
    }

    // A new variable is a harmless helper only when nothing but stock initial values (or other new
    // helpers) reads it. Anything a flow or an existing auxiliary reads changes what the model computes.
    const addedNames = new Set(diff.added.map((v) => foldName(v.name)));
    for (const added of diff.added) {
        const readers = (generated.variables || []).filter((v) => referencedNames(v.equation).has(foldName(added.name)));
        const badReader = readers.find((v) => v.type !== 'stock' && !addedNames.has(foldName(v.name)));
        if (added.type !== 'variable' || badReader) {
            failures.push({
                type: 'Model structure changed',
                details: added.type !== 'variable'
                    ? `A new ${added.type} "${added.name}" was added to the model.`
                    : `A new variable "${added.name}" was added and is used by "${badReader.name}", which changes what the model computes.`
            });
        }
    }
    return failures;
};

/**
 * Evaluates whether the returned model starts in equilibrium within the permitted changes.
 * @param {Object} generatedResponse The engine's response, carrying the updated model
 * @param {Object} expectations The test expectations
 * @returns {Promise<Array<Object>>} A list of failures with type and details.
 */
export const evaluate = async function(generatedResponse, expectations) {
    const failures = [];
    const generated = bareModel(generatedResponse);
    if (!generated || (generated.variables || []).length === 0) {
        failures.push({
            type: 'No model produced',
            details: `The engine did not return a model.${generatedResponse?.err ? ` Engine error: ${generatedResponse.err}` : ''}`
        });
        return validateEvaluationResult(failures);
    }

    const original = expectations.originalModel;
    failures.push(...structuralFailures(original, generated, [...expectations.adjustable, ...(expectations.oneConstantOf || [])]));
    if (expectations.oneConstantOf) {
        const moved = [...new Set(diffModels(original, generated).changed.filter((ch) => ch.field === 'equation' && expectations.oneConstantOf.some((n) => foldName(n) === foldName(ch.name))).map((ch) => ch.name))];
        if (moved.length > 1) failures.push({ type: 'Model structure changed', details: `Only one constant may change, but ${moved.length} did: ${listNames(moved)}.` });
    }

    // Run on the original specs: the test is about the model, and shortening the run or the step
    // is not a way to put it into equilibrium.
    const runnable = { ...generated, relationships: generated.relationships || [], specs: original.specs };
    const stockNames = (original.variables || []).filter((v) => v.type === 'stock').map((v) => v.name);
    const present = stockNames.map((n) => findVariable(runnable.variables, n)?.name).filter(Boolean);
    const run = await simulateModel(runnable, present, null);
    if (!run.ok) {
        failures.push({ type: 'Simulation error', details: run.error });
        return validateEvaluationResult(failures);
    }

    const seriesFor = (name) => {
        const matched = findVariable(runnable.variables, name);
        return matched ? run.series[matched.name] : undefined;
    };

    for (const [name, value] of Object.entries(expectations.fixedInitial || {})) {
        const series = seriesFor(name);
        if (!allFinite(series) || Math.abs(series[0] - value) > Math.abs(value) * TOTAL_TOLERANCE) {
            failures.push({ type: 'Constraint violated', details: `The initial value of "${name}" must stay at ${value}, but it is ${series ? series[0] : 'missing'}.` });
        }
    }

    if (expectations.fixedTotal) {
        const { stocks, total } = expectations.fixedTotal;
        const initialTotal = stocks.reduce((sum, name) => sum + (seriesFor(name)?.[0] ?? NaN), 0);
        if (!Number.isFinite(initialTotal) || Math.abs(initialTotal - total) > total * TOTAL_TOLERANCE) {
            failures.push({ type: 'Constraint violated', details: `The initial total of ${stocks.join(' + ')} must be ${total}, but it is ${initialTotal}.` });
        }
    }

    for (const [name, minimum] of Object.entries(expectations.nonTrivial || {})) {
        const series = seriesFor(name);
        if (allFinite(series) && series[0] < minimum) {
            failures.push({ type: 'Constraint violated', details: `"${name}" must start at ${minimum} or more (the trivial empty equilibrium does not count), but it starts at ${series[0]}.` });
        }
    }

    for (const name of expectations.equilibriumStocks) {
        const series = seriesFor(name);
        if (!allFinite(series)) {
            failures.push({ type: 'Stock not in equilibrium', details: `Stock "${name}" is missing from the model or produced non-finite values.` });
            continue;
        }
        const initial = series[0];
        const band = RELATIVE_TOLERANCE * Math.max(Math.abs(initial), 1e-9);
        let worst = 0;
        let worstAt = 0;
        series.forEach((v, i) => {
            const deviation = Math.abs(v - initial);
            if (deviation > worst) { worst = deviation; worstAt = i; }
        });
        if (worst > band) {
            failures.push({
                type: 'Stock not in equilibrium',
                details: `Stock "${name}" starts at ${initial} but reaches ${series[worstAt]} at time ${run.time[worstAt]}, a change of ${(100 * worst / Math.max(Math.abs(initial), 1e-9)).toFixed(1)}% (allowed: ${100 * RELATIVE_TOLERANCE}%).`
            });
        }
    }

    return validateEvaluationResult(failures);
};

/**
 * Returns the methodology for this category. Each `criteria[].name` is the exact failure `type`
 * {@link evaluate} records when that criterion is not met.
 * @returns {{howItWorks: Array<string>, criteria: Array<{name: string, description: string}>, scoring: string}}
 */
export const methodology = () => withFloors('equilibrium', {
    howItWorks: [
        `Each test hands the engine a small stock-and-flow model that starts out of equilibrium and names the stocks that should be held steady. The prompt states exactly which equations may change: the initial values of particular stocks, and in some cases one constant. Some cases add a constraint, such as keeping a total population fixed or keeping a population present, which rules out the trivial empty equilibrium.`,
        `Every case is known to be solvable within its rules: the test data carries one solution that holds every named stock steady, and the category's unit tests run it through the simulator. The solution is never shown to the engine.`,
        `Besides the hand-written models, every scenario in the shared scenario library whose equations do not change with time on their own — or whose only time functions are steps, taken as they stand once every step has happened — gets a case by a general rule (equilibriumData/generate.js): its whole model, every stock to be held, only the stocks' initial values adjustable. Its equilibrium is found by running the model ${HORIZONS} times as long, and the case is kept only if starting there holds every stock within half a percent, the model as given moves, and some stock sits above zero; the largest stock must keep at least ${100 * NON_TRIVIAL}% of its equilibrium value, so emptying the model fails.`,
        `Hard group (scenarioEquilibriumHard): for every generated scenario case, by a general rule (equilibriumData/hard.js), one stock must sit at a stated level its equilibrium does not have as the model stands — the level it settles at when one of the scenario's management levers is moved by half again (or halved), the stock being the one that lever moves most, by at least a fifth — and the engine may change every stock's initial value and any one constant of the model, with the lever withheld (the prompt does not say which constant moves the stock), so it must find which constant to move and the value that puts the stock there, and hold every stock steady; moving more than one constant counts as a structural change, and the stated level counts as a fixed initial value.`,
        `Grading is deterministic. The returned model is diffed against the given one, and any change outside the permitted set fails — zeroing a flow, cutting a loop or rewriting an equation would all make a stock flat without balancing the model. New helper variables are allowed only when nothing but stock initial values reads them. The model is then simulated through PySD on the original simulation specs, and every named stock must stay within ${100 * RELATIVE_TOLERANCE}% of its initial value for the whole run.`
    ],
    criteria: [
        { name: 'Stock not in equilibrium', description: `A named stock moved more than ${100 * RELATIVE_TOLERANCE}% from its initial value at some point in the run. Recorded once per stock, with the largest departure and when it happened.` },
        { name: 'Model structure changed', description: 'Something other than the permitted initial values and constants changed: a variable was removed, a flow or auxiliary equation was rewritten, an adjustable constant was replaced by an expression rather than a number, a new variable feeds the model\'s computation, or (hard group) more than one constant moved where any one may. Recorded once per change.' },
        { name: 'Constraint violated', description: 'A constraint the prompt stated does not hold: a fixed initial value or total moved by more than 1%, or a stock that must stay present starts below its minimum.' },
        { name: 'Simulation error', description: 'The returned model could not be converted to XMILE or simulated.' },
        { name: 'No model produced', description: 'The engine returned no model.' }
    ],
    scoring: `A test passes only when every named stock stays within the band, nothing outside the permitted changes was touched, and every stated constraint holds. A model that is flat for the wrong reason is not in equilibrium, so a structural change fails the test even if every stock stays steady.`
});

/**
 * The groups of tests, from one-stock models with an obvious balance point to coupled nonlinear
 * models where the equilibrium has to be worked out or found by experiment.
 */
const rawGroups = Object.keys(cases).reduce((acc, name) => {
    const group = cases[name].group;
    (acc[group] = acc[group] || []).push(generateTest(name));
    return acc;
}, {});


/** The groups, each split into its dev tests and its held-out ones (`<group>HeldOut`); see utilities/heldOut.js. */
export const groups = splitHeldOut(rawGroups, (t) => caseHeldOut(cases[t.name.replace(/ equilibrium$/, '')]));