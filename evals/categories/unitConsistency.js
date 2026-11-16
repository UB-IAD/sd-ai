/**
 * This is the unit consistency test
 *
 * Dimensionally consistent equations are a basic quality bar for a simulation model: a flow that
 * comes out in the wrong units, or a sum of apples and oranges, means the model computes something
 * other than what its author thinks. This category checks units two ways:
 *   - buildWithUnits: the engine builds a model from a description that states every quantity with
 *     its units. The model must be unit-consistent, give every variable units, and behave as the
 *     description says.
 *   - fixUnits: the engine is given a model with unit errors planted in it and asked to fix them.
 *     Each error is graded on its own.
 *   - fixUnitsHard: three unit errors of three kinds at once in a scenario's full model, a request
 *     that names no kind of problem ("is it ready for policy analysis? fix anything that needs
 *     it"), no unit checker reporting to the agent (the one feedback lever this category gives), and a
 *     clean control: the same request on the correct model (see unitConsistencyData/hard.js).
 *
 * Units are checked by a deterministic dimensional-analysis checker
 * (evals/utilities/units/unitChecker.js). Agents run with that checker reporting to them, the way
 * Stella reports unit warnings (the `unitChecking` engine parameter), so they get the same feedback
 * they would in the product — except in fixUnitsHard, where the feedback is withheld.
 *
 * Whether an error is fixed is decided the way guidedCorrection decides it: the engine's version of
 * the variable the error lives in is put back into the correct model, which must then be
 * unit-consistent and behave like the correct model.
 *
 * @module categories/unitConsistency
 */

import { validateEvaluationResult } from '../evaluationSchema.js';
import { bareModel } from '../utilities/simulateModel.js';
import { hybridModel, behaviorMismatch } from '../utilities/behaviorCompare.js';
import { checkUnits, INCONSISTENCY_KINDS } from '../utilities/units/unitChecker.js';
import { buildCases, fixCases, hardFixCases, plantUnitErrors } from './unitConsistencyData/cases.js';
import { HARD_ERRORS } from './unitConsistencyData/hard.js';
import { readyPrompt, pickHard, cleanVerdictFailure, CLEAN_CRITERIA, responseText } from './guidedCorrectionData/hardShared.js';
import { withFloors } from '../floors/statement.js';
import { MIN_DEVIATION } from './guidedCorrectionData/generate.js';
import { splitHeldOut, caseHeldOut } from '../utilities/heldOut.js';

/** How close a stock must stay to the reference model's, as a share of its largest value. */
export const BEHAVIOR_TOLERANCE = 0.02;

export const description = () => {
    return `The unit consistency test evaluates whether an engine produces dimensionally consistent models. It builds models from descriptions that state every quantity's units, which must come back unit-consistent, with units on every variable and the behavior described; and it fixes models with planted unit errors, each graded on its own by putting the engine's version of the erroneous variable back into the correct model.`;
};

const buildPrompt = (c) => `Please build a stock-and-flow model of the following, giving every variable its units. Use the stock names exactly as written.

${c.description}`;

const fixPrompt = (c) => `My model of ${c.description} has unit errors in it. Please find every unit inconsistency and fix it, so that the model is dimensionally consistent and behaves as intended. Keep the existing variable names, and return the complete corrected model.`;

const generateBuild = function(name) {
    const c = buildCases[name];
    const base = {
        prompt: buildPrompt(c),
        currentModel: null,
        additionalParameters: { problemStatement: `I want a simulation model of this system with correct units.`, unitChecking: true }
    };
    const shared = { family: 'build', caseName: name };
    return [
        { ...base, name: `${name}: units are consistent`, expectations: { ...shared, criterion: 'consistent' } },
        { ...base, name: `${name}: every variable has units`, expectations: { ...shared, criterion: 'allHaveUnits' } },
        { ...base, name: `${name}: behaves as described`, expectations: { ...shared, criterion: 'behavior' } }
    ];
};

const generateFix = function(name) {
    const c = fixCases[name];
    const base = {
        prompt: fixPrompt(c),
        currentModel: plantUnitErrors(c.correct, c.errors),
        additionalParameters: { problemStatement: `I need my model of ${c.description} to be dimensionally consistent.`, unitChecking: true }
    };
    const shared = { family: 'fix', caseName: name };
    const tests = c.errors.map((error) => ({
        ...base,
        name: `${name}: fixes "${error.id}"`,
        expectations: { ...shared, criterion: 'error', errorId: error.id }
    }));
    tests.push({ ...base, name: `${name}: whole model is unit-consistent`, expectations: { ...shared, criterion: 'consistent' } });
    tests.push({ ...base, name: `${name}: corrected model behaves like the correct one`, expectations: { ...shared, criterion: 'behavior' } });
    return tests;
};

/** The fix case a test is about: a hard case for the hard group's tests. */
const fixCaseFor = (expectations) => (expectations.hard ? hardFixCases : fixCases)[expectations.caseName];

/**
 * Whether the hard group's agents see the unit checker's warnings: they do not. The checker that
 * grades is unchanged; the agent has to find the unit errors by reading the equations, as a modeler
 * without a unit check would.
 */
export const HARD_UNIT_CHECKING = false;

/** The hard cases the hard group takes (see guidedCorrectionData/hardShared.js). */
export const HARD = pickHard(hardFixCases, null);

const generateHard = function(name) {
    const c = hardFixCases[name];
    const base = { prompt: readyPrompt(c.description), currentModel: plantUnitErrors(c.correct, c.errors), additionalParameters: { problemStatement: `I need my model of ${c.description} to be right.`, unitChecking: HARD_UNIT_CHECKING } };
    const shared = { family: 'fix', caseName: name, hard: true };
    return [
        ...c.errors.map((error) => ({ ...base, name: `${name}: fixes "${error.id}" unprompted`, expectations: { ...shared, criterion: 'error', errorId: error.id } })),
        { ...base, name: `${name}: whole model is unit-consistent`, expectations: { ...shared, criterion: 'consistent' } },
        { ...base, name: `${name}: corrected model behaves like the correct one`, expectations: { ...shared, criterion: 'behavior' } }
    ];
};

const generateClean = (name) => [{
    prompt: readyPrompt(hardFixCases[name].description),
    currentModel: structuredClone(hardFixCases[name].correct),
    additionalParameters: { problemStatement: `I need my model of ${hardFixCases[name].description} to be right.`, unitChecking: HARD_UNIT_CHECKING },
    name: `${name} (clean control): finds nothing to fix and leaves the correct model as it is`,
    expectations: { family: 'fix', caseName: name, hard: true, criterion: 'clean' }
}];

const rawGroups = {
    buildWithUnits: Object.keys(buildCases).flatMap(generateBuild),
    fixUnits: Object.keys(fixCases).flatMap(generateFix),
    fixUnitsHard: [...HARD.faulty.flatMap(generateHard), ...HARD.clean.flatMap(generateClean)]
};


/** The groups, each split into its dev tests and its held-out ones (`<group>HeldOut`); see utilities/heldOut.js. */
export const groups = splitHeldOut(rawGroups, (t) => caseHeldOut(t.expectations.family === 'build' ? buildCases[t.expectations.caseName] : fixCaseFor(t.expectations)));
const describeWarnings = (warnings) => warnings.map((w) => w.message).join(' ');

/**
 * Evaluates one criterion.
 * @param {Object} generatedResponse The engine's response, carrying its model
 * @param {Object} expectations The criterion
 * @returns {Promise<Array<Object>>} Failures
 */
export const evaluate = async function(generatedResponse, expectations) {
    const generated = bareModel(generatedResponse);
    if (!generated || (generated.variables || []).length === 0) {
        return validateEvaluationResult([{ type: 'No model produced', details: `The engine did not return a model.${generatedResponse?.err ? ` Engine error: ${generatedResponse.err}` : ''}` }]);
    }
    const reference = expectations.family === 'build' ? buildCases[expectations.caseName].reference : fixCaseFor(expectations).correct;
    // Units are checked against the time unit the model declares; a build that left it out is
    // checked against the reference's, which the description states.
    const specs = generated.specs?.timeUnits ? generated.specs : { ...(generated.specs || {}), timeUnits: reference.specs.timeUnits };
    const checked = { ...generated, specs };
    const failures = [];

    switch (expectations.criterion) {
        case 'consistent': {
            // A variable without readable units cannot be checked, and an equation that uses it
            // escapes the check too; deleting units must not read as making them consistent.
            const warnings = checkUnits(checked).filter((w) => INCONSISTENCY_KINDS.has(w.kind) || w.kind === 'missing');
            for (const w of warnings) failures.push({ type: 'Unit inconsistency', details: w.kind === 'missing' ? `${w.message} Its units cannot be checked.` : w.message });
            break;
        }
        case 'allHaveUnits': {
            for (const w of checkUnits(checked).filter((x) => x.kind === 'missing')) failures.push({ type: 'Missing units', details: w.message });
            break;
        }
        case 'behavior': {
            const mismatch = await behaviorMismatch(generated, reference, BEHAVIOR_TOLERANCE);
            if (mismatch) failures.push({ type: 'Behavior differs', details: mismatch });
            break;
        }
        case 'error': {
            const c = fixCaseFor(expectations);
            const error = c.errors.find((e) => e.id === expectations.errorId);
            const fields = [...Object.keys(error.change), ...(error.change.equation !== undefined ? ['graphicalFunction'] : [])];
            const hybrid = hybridModel(c.correct, generated, error.variable, fields);
            if (!hybrid) {
                failures.push({ type: 'Unit error not fixed', details: `The returned model no longer has "${error.variable}".` });
                break;
            }
            // Deleting the erroneous variable's units hides the error rather than fixing it.
            const warnings = checkUnits(hybrid).filter((w) => INCONSISTENCY_KINDS.has(w.kind) || w.kind === 'missing');
            if (warnings.length) {
                failures.push({ type: 'Unit error not fixed', details: `With the returned "${error.variable}" in place, the model still has unit problems: ${describeWarnings(warnings)}` });
                break;
            }
            const mismatch = await behaviorMismatch(hybrid, c.correct, BEHAVIOR_TOLERANCE);
            if (mismatch) failures.push({ type: 'Unit error not fixed', details: `With the returned "${error.variable}" in place the units work, but the model no longer behaves as intended: ${mismatch}` });
            break;
        }
        case 'clean': {
            // The correct model needs nothing: the returned one must still be unit-consistent and
            // behave like it, and the response must say it needed no fixing.
            const warnings = checkUnits(checked).filter((w) => INCONSISTENCY_KINDS.has(w.kind) || w.kind === 'missing');
            if (warnings.length) failures.push({ type: 'Correct model changed', details: `The model was unit-consistent, but the returned one is not: ${describeWarnings(warnings)}` });
            const mismatch = await behaviorMismatch(generated, reference, BEHAVIOR_TOLERANCE);
            if (mismatch) failures.push({ type: 'Correct model changed', details: `The model needed no fixing, but the returned model behaves differently: ${mismatch}` });
            const text = responseText(generatedResponse);
            const said = await cleanVerdictFailure(`unitConsistency|clean|${expectations.caseName}|${text}`, fixCaseFor(expectations).description, text);
            if (said) failures.push(said);
            break;
        }
        default:
            throw new Error(`Unknown criterion ${expectations.criterion}`);
    }
    return validateEvaluationResult(failures);
};

export const methodology = () => withFloors('unitConsistency', {
    howItWorks: [
        `Units are checked by a deterministic dimensional-analysis checker. It parses every equation, infers its units from the declared units of the variables it uses, and reports equations whose units differ from their variable's declared units; sums, comparisons, MIN/MAX and IF branches that combine different units; flows that are not in their stock's units per time unit; initial values in the wrong units; and functions given the wrong kind of argument (EXP of a quantity with units, a smoothing delay whose delay is not a time). A number written in an equation takes the units of what it is added to, and is a plain number in a product. Agents run with this checker's warnings reported to them, as Stella reports its own — except in the fixUnitsHard group, where they are withheld.`,
        `In buildWithUnits the engine builds a model from a description that states every quantity with its units, precisely enough that one model follows. The model must have no unit inconsistencies, must give every variable units, and its stocks must stay within ${100 * BEHAVIOR_TOLERANCE}% of the reference model's trajectories.`,
        `In fixUnits the engine is given a correct model with unit errors planted in it — an equation whose units do not work out, or a variable declared in the wrong units — and asked to fix them. Each error is graded on its own: the engine's version of the part of the variable the error lives in is put back into the correct model, which must then pass the unit checker and behave like the correct model. Fixing the units by changing what the model computes does not count.`,
        `Besides the hand-written fixUnits cases, every scenario in the shared scenario library whose model is unit-consistent gets one by a general rule (unitConsistencyData/generate.js) on its own model: the first division by a constant measured in time that, made a multiplication, the checker flags and that moves some stock by at least ${100 * MIN_DEVIATION}% of its largest value; and the first flow in another variable whose units, shortened by their "per time", the checker flags. The fixUnitsHard group is built by difficulty levers applied by the rule in unitConsistencyData/hard.js to every such scenario, never by picking cases an agent failed: ${HARD_ERRORS} errors of ${HARD_ERRORS} different kinds at once in the scenario's full model (a division by a time constant made a multiplication, a product made a sum, a flow declared without its per time, a rate constant declared per time only), a request that names no kind of problem ("is it ready for policy analysis? fix anything that needs it"), withheld feedback — the unit checker does not report to the agent in this group, so the errors must be found by reading the equations (the same checker still grades) — and a clean control — the same request on the correct model, which passes only when the model comes back unit-consistent, behaving as it did, and the response says it needed no fixing. For buildWithUnits, every such scenario also gets a description of its whole model by a general rule: each stock with its units, its starting value and its flows, each constant with its units, each formula written in the model's own names without units — the units of every flow and computed variable are the agent's to work out — and the run's time span; the reference is the scenario's model.`
    ],
    criteria: [
        { name: 'Unit inconsistency', description: 'The unit checker found a dimensional inconsistency in the model, or a variable whose units are missing or unreadable, so that the units of everything using it cannot be checked. Recorded once per warning.' },
        { name: 'Missing units', description: 'A variable has no units, or units that cannot be read. Recorded once per variable.' },
        { name: 'Behavior differs', description: `A stock strays more than ${100 * BEHAVIOR_TOLERANCE}% from the reference model's run.` },
        { name: 'Unit error not fixed', description: 'With the engine\'s version of the erroneous variable in the correct model, the units still do not work out, the variable\'s units were deleted rather than corrected, or the units work but the model no longer behaves as intended.' },
        ...CLEAN_CRITERIA,
        { name: 'No model produced', description: 'The engine returned no model.' },
        { name: 'Evaluation error', description: 'In a clean control, the judge call failed; recorded as a failure so a broken judge never reads as a good answer.' }
    ],
    scoring: `One criterion per test, all graded from one model per case. Unit consistency and behavior are separate tests, so a model that is consistent but wrong, or right but carelessly unitted, passes one and fails the other.`
});
