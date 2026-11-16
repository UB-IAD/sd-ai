/**
 * This is the formulation critique test
 *
 * Experienced modelers review formulations for more than correctness: an equation with too many
 * inputs is hard to check, a number buried in an equation hides an assumption, a division that can
 * reach zero will one day blow up, and a hard-coded time switch makes a test input invisible. This
 * category plants such formulations in otherwise clean models and asks the agent to review the
 * model's formulations, explain what does not follow best practice, and fix it without changing
 * what the model computes.
 *
 * Every plant is a pure matter of form — the planted equation computes what the clean one does — so
 * a fix is checked deterministically two ways: the formulation linter (evals/utilities/formulationLint.js)
 * no longer flags the plant's rule on that variable, and the model still behaves as before.
 *
 * Whether the agent identified a plant is read by a judge from a list of issues that mixes the real
 * plants with distractors. One test per plant (identified and fixed) plus one for behavior; sibling
 * tests share one generation.
 *
 * The formulationCritiqueHard group (see formulationCritiqueData/hard.js) plants three or more poor
 * formulations of different kinds at once in a scenario's full model — and then, by a second pass,
 * further plants of every kind up to six, as many as the model has sites for — asks only whether the model is
 * ready ("fix anything that needs it") without naming best practice, and adds a clean control: the
 * same request on the clean model.
 *
 * @module categories/formulationCritique
 */

import { z } from 'zod';
import { validateEvaluationResult } from '../evaluationSchema.js';
import { extract } from '../utilities/judge.js';
import { bareModel } from '../utilities/simulateModel.js';
import { findVariable, foldName } from '../utilities/modelDiff.js';
import { hybridModel, behaviorMismatch } from '../utilities/behaviorCompare.js';
import { lintFormulations, MAX_INPUTS } from '../utilities/formulationLint.js';
import { cases, plantedModel, hardCases } from './formulationCritiqueData/cases.js';
import { HARD_PLANTS, MAX_PLANTS } from './formulationCritiqueData/hard.js';
import { readyPrompt, pickHard, cleanVerdictFailure, CLEAN_CRITERIA, responseText } from './guidedCorrectionData/hardShared.js';
import { withFloors } from '../floors/statement.js';
import { splitHeldOut, caseHeldOut } from '../utilities/heldOut.js';

export const BEHAVIOR_TOLERANCE = 0.01;

export const description = () => {
    return `The formulation critique test evaluates whether an agent can review a model's formulations for best practice — too many inputs in one equation, numbers buried in equations, divisions that can reach zero, hard-coded time switches — explain what is wrong, and fix it without changing what the model computes. Each planted formulation is graded on its own: identified in the critique, and fixed so the linter no longer flags it while the model behaves exactly as before.`;
};

/** The issue list the judge reads against: real plants and distractors, interleaved in a fixed order. */
export const issueList = function(c) {
    const list = [];
    for (let i = 0; i < Math.max(c.plants.length, c.distractors.length); i++) {
        if (c.plants[i]) list.push({ text: c.plants[i].text, plantId: c.plants[i].id });
        if (c.distractors[i]) list.push({ text: c.distractors[i], plantId: null });
    }
    // Rotate the list by the case's place among the cases, so the first real problem is not always
    // item 1 and a judge's position bias cannot favor it.
    const shift = Math.max(0, Object.values(cases).findIndex((x) => x.plants[0]?.id === c.plants[0]?.id)) % list.length;
    return [...list.slice(shift), ...list.slice(0, shift)];
};

const prompt = (c) => `Please review the formulations in my model of ${c.description} for best practice: clarity, a limited number of inputs per equation, named constants rather than numbers written into equations, robustness to extreme values, and test inputs that are easy to see and change. Point out every formulation that does not follow best practice and explain why. Then fix them without changing what the model computes, keep the existing variable names, and return the complete model.`;

const generateTests = function(name) {
    const c = cases[name];
    const base = { prompt: prompt(c), currentModel: plantedModel(c), additionalParameters: { problemStatement: `I want my model of ${c.description} to be clear and robust.` } };
    const shared = { caseName: name };
    return [
        ...c.plants.map((p) => ({ ...base, name: `${name}: identifies and fixes ${p.id}`, expectations: { ...shared, criterion: 'plant', plantId: p.id } })),
        { ...base, name: `${name}: the model still computes the same thing`, expectations: { ...shared, criterion: 'behavior' } }
    ];
};

/** The case a test is about: a hard case for the hard group's tests, else one of the cases. */
const caseFor = (expectations) => (expectations.hard ? hardCases : cases)[expectations.caseName];

/** The hard cases the hard group takes (see guidedCorrectionData/hardShared.js). */
export const HARD = pickHard(hardCases, null);

const generateHard = function(name) {
    const c = hardCases[name];
    const base = { prompt: readyPrompt(c.description), currentModel: plantedModel(c), additionalParameters: { problemStatement: `I want my model of ${c.description} to be ready for others to use.` } };
    const shared = { caseName: name, hard: true };
    return [
        ...c.plants.map((p) => ({ ...base, name: `${name}: identifies and fixes ${p.id} unprompted`, expectations: { ...shared, criterion: 'plant', plantId: p.id } })),
        { ...base, name: `${name}: the model still computes the same thing`, expectations: { ...shared, criterion: 'behavior' } }
    ];
};

const generateClean = (name) => [{
    prompt: readyPrompt(hardCases[name].description),
    currentModel: structuredClone(hardCases[name].clean),
    additionalParameters: { problemStatement: `I want my model of ${hardCases[name].description} to be ready for others to use.` },
    name: `${name} (clean control): finds nothing to fix and leaves the clean model as it is`,
    expectations: { caseName: name, hard: true, criterion: 'clean' }
}];

const rawGroups = {
    formulationCritique: Object.keys(cases).flatMap(generateTests),
    formulationCritiqueHard: [...HARD.faulty.flatMap(generateHard), ...HARD.clean.flatMap(generateClean)]
};


/** The groups, each split into its dev tests and its held-out ones (`<group>HeldOut`); see utilities/heldOut.js. */
export const groups = splitHeldOut(rawGroups, (t) => caseHeldOut(caseFor(t.expectations)));
export const identificationSchema = z.object({
    issues: z.array(z.object({
        number: z.number().int().positive(),
        identified: z.enum(['yes', 'no']).describe("'yes' if the response identifies this issue in substance (in its own words is fine); 'no' if it does not mention it or dismisses it")
    }))
});

/**
 * Evaluates one criterion.
 * @param {Object} generatedResponse The engine's response
 * @param {Object} expectations The criterion
 * @returns {Promise<Array<Object>>} Failures
 */
export const evaluate = async function(generatedResponse, expectations) {
    // Computing the same thing counts only for a model that was actually improved: the planted
    // formulations compute the same thing too, so an unchanged model would otherwise pass.
    const own = await evaluateOne(generatedResponse, expectations);
    if (expectations.criterion !== 'behavior') return own;
    const c = caseFor(expectations);
    let anyFixed = false;
    for (const p of c.plants) if (!(await evaluateOne(generatedResponse, { ...expectations, criterion: 'plant', plantId: p.id })).length) anyFixed = true;
    return anyFixed ? own : validateEvaluationResult([...own, { type: 'Formulation not fixed', details: 'This test counts only when at least one planted formulation is identified and fixed; none is.' }]);
};

const evaluateOne = async function(generatedResponse, expectations) {
    const c = caseFor(expectations);
    const generated = bareModel(generatedResponse);
    if (!generated || (generated.variables || []).length === 0) {
        return validateEvaluationResult([{ type: 'No model produced', details: `The engine did not return a model.${generatedResponse?.err ? ` Engine error: ${generatedResponse.err}` : ''}` }]);
    }
    const failures = [];
    if (expectations.criterion === 'behavior') {
        const mismatch = await behaviorMismatch(generated, c.clean, BEHAVIOR_TOLERANCE);
        if (mismatch) failures.push({ type: 'Behavior changed', details: `The revised model no longer computes what it did: ${mismatch}` });
        return validateEvaluationResult(failures);
    }
    if (expectations.criterion === 'clean') {
        // The clean model needs nothing: the returned one must compute the same thing, still pass
        // the linter, and the response must say it needed no fixing.
        const mismatch = await behaviorMismatch(generated, c.clean, BEHAVIOR_TOLERANCE);
        if (mismatch) failures.push({ type: 'Correct model changed', details: `The model needed no fixing, but the revised model computes something else: ${mismatch}` });
        const lint = lintFormulations(generated);
        if (lint.length) failures.push({ type: 'Correct model changed', details: `The model passed every best-practice check, but the revised one does not: ${lint.map((f) => f.message).join(' ')}` });
        const text = responseText(generatedResponse);
        const said = await cleanVerdictFailure(`formulationCritique|clean|${expectations.caseName}|${text}`, c.description, text);
        if (said) failures.push(said);
        return validateEvaluationResult(failures);
    }

    const plant = c.plants.find((p) => p.id === expectations.plantId);
    // Fixed: the agent's version of the planted variable, with any helpers it added, in the clean
    // model — the plant's rule no longer fires on it or on the helpers, and nothing behaves differently.
    const hybrid = hybridModel(c.clean, generated, plant.variable, ['equation', 'graphicalFunction']);
    if (!hybrid) {
        failures.push({ type: 'Formulation not fixed', details: `The revised model no longer has "${plant.variable}".` });
    } else {
        const added = new Set((generated.variables || []).filter((v) => !findVariable(c.clean.variables, v.name)).map((v) => foldName(v.name)));
        const rules = plant.rules || [plant.rule];
        const still = lintFormulations(hybrid).filter((f) => rules.includes(f.rule) && (foldName(f.variable) === foldName(plant.variable) || added.has(foldName(f.variable))));
        if (still.length) failures.push({ type: 'Formulation not fixed', details: still.map((f) => f.message).join(' ') });
        const mismatch = await behaviorMismatch(hybrid, c.clean, BEHAVIOR_TOLERANCE);
        if (mismatch) failures.push({ type: 'Formulation not fixed', details: `The revised "${plant.variable}" changes what the model computes: ${mismatch}` });
    }

    const text = generatedResponse?.supportingInfo?.explanation || generatedResponse?.output?.textContent || '';
    const list = issueList(c);
    const number = list.findIndex((i) => i.plantId === plant.id) + 1;
    if (!text.trim()) {
        failures.push({ type: 'Formulation not identified', details: 'The engine gave no critique.' });
    } else {
        try {
            const reading = await extract(`formulationCritique|${expectations.caseName}|${text}`, [
                { role: 'system', content: 'You read a review of a model\'s formulations and report which of a list of possible issues the review identified. Do NOT judge whether the issues are real; report only whether the review identified each one.' },
                { role: 'user', content: `Possible issues:\n${list.map((x, i) => `${i + 1}. ${x.text}`).join('\n')}\n\nReview:\n"""\n${text}\n"""` }
            ], identificationSchema);
            if ((reading.issues || []).find((x) => x.number === number)?.identified !== 'yes') {
                failures.push({ type: 'Formulation not identified', details: `The review does not identify this problem: ${plant.text}` });
            }
        } catch (error) {
            failures.push({ type: 'Evaluation error', details: `Error reading the review: ${error.message}` });
        }
    }
    return validateEvaluationResult(failures);
};

export const methodology = () => withFloors('formulationCritique', {
    howItWorks: [
        `Each case is a clean model — every formulation passes the linter — with poor formulations planted in it: an intermediate inlined so one equation has five inputs, a named constant replaced by its number, a division by a sum of stocks with no guard, a STEP replaced by a hard-coded IF TIME switch. Every plant computes exactly what the clean formulation does, which the unit tests check by simulation.`,
        `Besides the hand-written cases, every scenario in the shared scenario library whose model passes the linter gets a case by a general rule (formulationCritiqueData/generate.js) on its own model: the first variable with at least two inputs, one a named constant, has that constant's value written in as a number; and the first variable that, with an intermediate it uses written out in place, has more than ${MAX_INPUTS} inputs gets it inlined. Each plant must trip its linter rule. The distractors say that one variable should not depend on one of its inputs and that a stock which starts above zero should start at zero.`,
        `The agent is asked to review the formulations for best practice, explain what does not follow it, and fix it without changing what the model computes.`,
        `The formulationCritiqueHard group is built by difficulty levers applied by rule (formulationCritiqueData/hard.js) to every lint-clean scenario, never by picking cases an agent failed: at least ${HARD_PLANTS} plants of at least two kinds at once in the scenario's full model (a hard-coded time switch, a total written out unguarded in a denominator or a divisor's guard dropped, an intermediate inlined, constants written in as numbers) — then more faults at once: a second pass adds further plants of every kind, rare kinds first, up to ${MAX_PLANTS} in all as the model has sites for, each graded on its own — a request that names no best practice or kind of problem ("is it ready for policy analysis? fix anything that needs it"), and a clean control — the same request on the clean model, which passes only when the model comes back computing the same thing and still lint-clean and the response says it needed no fixing.`,
        `A plant is fixed when the agent's version of that variable, put into the clean model with any helper variables it added, no longer trips the plant's linter rule and the model behaves as before (every stock within ${100 * BEHAVIOR_TOLERANCE}% of the clean run). A plant is identified when a fixed judge model, reading the review against a list that mixes the real plants with distractor problems, reports that the review names it.`
    ],
    criteria: [
        { name: 'Formulation not fixed', description: 'The planted formulation still trips its linter rule, or the revision changes what the model computes.' },
        { name: 'Formulation not identified', description: 'The review does not name the planted problem.' },
        { name: 'Behavior changed', description: 'The revised model as a whole no longer behaves as before.' },
        ...CLEAN_CRITERIA,
        { name: 'No model produced', description: 'The engine returned no model.' },
        { name: 'Evaluation error', description: 'The judge call failed; recorded as a failure so a broken judge never reads as a good answer.' }
    ],
    scoring: `One test per planted formulation, passing only when it is both identified and fixed, plus a whole-model behavior test that counts only when at least one planted formulation is fixed (an unchanged model computes the same thing and would otherwise pass).`
});
