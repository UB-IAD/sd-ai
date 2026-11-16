/**
 * This is the mental model versus bug test
 *
 * When a model does something its builder did not expect, either the model is wrong or the
 * expectation is. Telling the two apart is one of the most useful things an assistant can do: fix
 * the bug and the model is right, "fix" a correct model to match a wrong expectation and it is now
 * wrong. This category reports a surprise about a model and asks which it is.
 *
 * Half the cases have a planted bug and a right expectation; half have a correct model and a
 * wrong expectation, whose report describes what the correct model really does. Grading:
 *   - classified: a judge reads the agent's answer and reports, from closed options, whether it
 *     says the model has a bug or the expectation is mistaken; it must match the case
 *   - for a bug, fixed: the agent's version of the planted variable, put back into the correct
 *     model, makes it behave like the correct model again
 *   - for a wrong expectation, left alone: the returned model still behaves like the correct model
 *
 * The mentalModelVsBugHard group (see mentalModelVsBugData/hard.js) reports several surprises at
 * once about a scenario's full model — some from planted bugs, some mistaken expectations — each
 * graded on its own, and adds a clean control: the same request on the correct model, reporting
 * only mistaken expectations.
 *
 * @module categories/mentalModelVsBug
 */

import { z } from 'zod';
import { validateEvaluationResult } from '../evaluationSchema.js';
import { extract } from '../utilities/judge.js';
import { bareModel } from '../utilities/simulateModel.js';
import { hybridModel, behaviorMismatch } from '../utilities/behaviorCompare.js';
import { cases, hardCases, hard2Cases } from './mentalModelVsBugData/cases.js';
import { HARD_ITEMS } from './mentalModelVsBugData/hard.js';
import { doublingRatio } from './mentalModelVsBugData/generate.js';
import { pickHard, responseText } from './guidedCorrectionData/hardShared.js';
import { withFloors } from '../floors/statement.js';
import { MIN_CHANGE, MAX_RISE, MAX_FALL, PROPORTIONAL } from './mentalModelVsBugData/generate.js';
import { splitHeldOut, caseHeldOut } from '../utilities/heldOut.js';

export const BEHAVIOR_TOLERANCE = 0.01;

export const description = () => {
    return `The mental model versus bug test evaluates whether an agent, told that a model does something its builder did not expect, can tell a bug in the model from a mistaken expectation — fixing the model when it is wrong, and explaining the behavior while leaving the model alone when it is right.`;
};

const prompt = (c) => `Here is my model of ${c.description}. ${c.report} Is this a mistake in the model, or is my expectation wrong? If the model is wrong, fix it, keeping the existing variable names, and return the complete model. If my expectation is wrong, explain why and leave the model as it is.`;

const generateTests = function(name) {
    const c = cases[name];
    const base = { prompt: prompt(c), currentModel: structuredClone(c.given), additionalParameters: { mode: 'sfd', problemStatement: `My model of ${c.description} surprised me and I want to know why.` } };
    return [
        { ...base, name: `${name}: tells ${c.kind === 'bug' ? 'a bug' : 'a mistaken expectation'} for what it is`, expectations: { caseName: name, criterion: 'classified' } },
        c.kind === 'bug'
            ? { ...base, name: `${name}: fixes the bug`, expectations: { caseName: name, criterion: 'fixed' } }
            : { ...base, name: `${name}: leaves the correct model alone`, expectations: { caseName: name, criterion: 'leftAlone' } }
    ];
};

/** The hard cases the hard group takes (see guidedCorrectionData/hardShared.js). */
export const HARD = pickHard(hardCases, null);

/** The surprises a hard test reports: every item, or for the clean control the mistaken expectations as measured on the correct model. */
export const hardReports = (c, clean) => (clean ? c.items.filter((x) => x.kind === 'expectation').map((x) => x.cleanReport) : c.items.map((x) => x.report));

const hardPrompt = (c, clean) => {
    const reports = hardReports(c, clean);
    return `Here is my model of ${c.description}. I noticed ${reports.length} things I did not expect:\n${reports.map((r, i) => `${i + 1}. ${r}`).join('\n')}\nFor each one, is it a mistake in the model, or is my expectation wrong? Fix whatever is wrong in the model, keeping the existing variable names, and return the complete model; where my expectation is wrong, explain why and leave that part of the model as it is.`;
};

const generateHard = function(name) {
    const c = hardCases[name];
    const base = { prompt: hardPrompt(c, false), currentModel: structuredClone(c.given), additionalParameters: { mode: 'sfd', problemStatement: `My model of ${c.description} surprised me and I want to know why.` } };
    const shared = { caseName: name, hard: true };
    return [
        ...c.items.map((x, i) => ({ ...base, name: `${name}: surprise ${i + 1} (doubling ${x.constant}) told for what it is and handled to match`, expectations: { ...shared, criterion: 'item', item: i } })),
        { ...base, name: `${name}: the returned model behaves like the correct one`, expectations: { ...shared, criterion: 'behavior' } }
    ];
};

const generateClean = (name) => [{
    prompt: hardPrompt(hardCases[name], true),
    currentModel: structuredClone(hardCases[name].correct),
    additionalParameters: { mode: 'sfd', problemStatement: `My model of ${hardCases[name].description} surprised me and I want to know why.` },
    name: `${name} (clean control): calls every surprise a mistaken expectation and leaves the correct model alone`,
    expectations: { caseName: name, hard: true, criterion: 'clean' }
}];

/**
 * The second hard group (mentalModelVsBugData/hard2.js), held-out cases only: the same request as the
 * first hard group, about a scenario's pairs of surprises — as many bugs as mistaken expectations —
 * graded together in one test.
 */
const generateHard2 = (name) => {
    const c = hard2Cases[name];
    return [{
        prompt: hardPrompt(c, false),
        currentModel: structuredClone(c.given),
        additionalParameters: { mode: 'sfd', problemStatement: `My model of ${c.description} surprised me and I want to know why.` },
        name: `${name}: every one of ${c.items.length} surprises told for what it is and handled to match, and the model behaves like the correct one`,
        expectations: { caseName: name, hard2: true, criterion: 'together' }
    }];
};

const rawGroups = {
    mentalModelVsBug: Object.keys(cases).flatMap(generateTests),
    mentalModelVsBugHard: [...HARD.faulty.flatMap(generateHard), ...HARD.clean.flatMap(generateClean)],
    mentalModelVsBugHard2: Object.keys(hard2Cases).filter((n) => caseHeldOut(hard2Cases[n])).flatMap(generateHard2)
};


/** The groups, each split into its dev tests and its held-out ones (`<group>HeldOut`); see utilities/heldOut.js. */
export const groups = splitHeldOut(rawGroups, (t) => caseHeldOut((t.expectations.hard2 ? hard2Cases : t.expectations.hard ? hardCases : cases)[t.expectations.caseName]));
const VERDICTS = { bug: 'the model has a mistake', expectation: 'the expectation is mistaken' };

const verdictSchema = z.object({
    verdict: z.enum([VERDICTS.bug, VERDICTS.expectation, 'unclear']).describe("What the answer concludes about the reported surprise. 'unclear' if it does not decide, or says both.")
});

/**
 * Evaluates one criterion.
 * @param {Object} generatedResponse The engine's response
 * @param {Object} expectations The criterion
 * @returns {Promise<Array<Object>>} Failures
 */
export const evaluate = async function(generatedResponse, expectations) {
    if (expectations.hard2) return evaluateTogether(generatedResponse, expectations);
    if (expectations.hard) return evaluateHard(generatedResponse, expectations);
    // The diagnosis counts only with the model handled to match (fixed for a bug, left as it was
    // for a mistaken expectation), and leaving a model alone counts only with the right diagnosis:
    // saying "bug" to everything, or returning every model unchanged, scores nothing.
    const c = cases[expectations.caseName];
    const own = await evaluateOne(generatedResponse, expectations);
    if (expectations.criterion === 'classified') {
        const second = await evaluateOne(generatedResponse, { ...expectations, criterion: c.kind === 'bug' ? 'fixed' : 'leftAlone' });
        return validateEvaluationResult([...own, ...second]);
    }
    if (expectations.criterion === 'leftAlone') {
        return validateEvaluationResult([...own, ...(await evaluateOne(generatedResponse, { ...expectations, criterion: 'classified' }))]);
    }
    return own;
};

const evaluateOne = async function(generatedResponse, expectations) {
    const c = cases[expectations.caseName];
    const failures = [];
    if (expectations.criterion === 'classified') {
        const text = generatedResponse?.supportingInfo?.explanation || generatedResponse?.output?.textContent || '';
        if (!text.trim()) return validateEvaluationResult([{ type: 'Wrong diagnosis', details: `The engine gave no explanation.${generatedResponse?.err ? ` Engine error: ${generatedResponse.err}` : ''}` }]);
        let reading;
        try {
            reading = await extract(`mentalModelVsBug|${expectations.caseName}|${text}`, [
                { role: 'system', content: 'You read an answer to a modeler who was surprised by their model, and report what the answer concludes: that the model has a mistake, or that the modeler\'s expectation is mistaken. Report only what the answer says; do not judge whether it is right.' },
                { role: 'user', content: `The modeler's report:\n"""\n${c.report}\n"""\n\nThe answer:\n"""\n${text}\n"""` }
            ], verdictSchema);
        } catch (error) {
            return validateEvaluationResult([{ type: 'Evaluation error', details: `Error reading the answer: ${error.message}` }]);
        }
        if (reading.verdict !== VERDICTS[c.kind]) failures.push({ type: 'Wrong diagnosis', details: `The answer concludes "${reading.verdict}"; in fact ${c.kind === 'bug' ? 'the model has a bug and the expectation is right' : 'the model is correct and the expectation is mistaken'}.` });
        return validateEvaluationResult(failures);
    }
    const generated = bareModel(generatedResponse);
    if (!generated || (generated.variables || []).length === 0) {
        return validateEvaluationResult([{ type: 'No model produced', details: `The engine did not return a model.${generatedResponse?.err ? ` Engine error: ${generatedResponse.err}` : ''}` }]);
    }
    if (expectations.criterion === 'fixed') {
        // Fixed when the agent's version of the planted variable, put into the correct model, makes
        // it behave correctly — or when the agent's whole model does: a bug can be fixed somewhere
        // other than where it was planted (unhooking the immigration flow a closed town should not
        // have, rather than zeroing the newcomers that feed it), and each case has only one bug.
        const hybrid = hybridModel(c.correct, generated, c.plant.variable, c.plant.fields);
        const hybridMismatch = hybrid ? await behaviorMismatch(hybrid, c.correct, BEHAVIOR_TOLERANCE) : 'the variable is gone';
        if (hybridMismatch) {
            const wholeMismatch = await behaviorMismatch(generated, c.correct, BEHAVIOR_TOLERANCE);
            if (wholeMismatch) failures.push({ type: 'Bug not fixed', details: `The revised model still misbehaves: ${wholeMismatch}` });
        }
    } else if (expectations.criterion === 'leftAlone') {
        const mismatch = await behaviorMismatch(generated, c.correct, BEHAVIOR_TOLERANCE);
        if (mismatch) failures.push({ type: 'Correct model changed', details: `The model was right, but the returned model behaves differently: ${mismatch}` });
    } else {
        throw new Error(`Unknown criterion ${expectations.criterion}`);
    }
    return validateEvaluationResult(failures);
};

const itemsSchema = z.object({
    surprises: z.array(z.object({
        number: z.number().int().positive().describe('The number of the surprise in the list'),
        verdict: z.enum([VERDICTS.bug, VERDICTS.expectation, 'unclear']).describe("What the answer concludes about this surprise. 'unclear' if it does not decide, says both, or does not address it.")
    })).describe('One entry for every numbered surprise')
});

/** How far the returned model's doubling ratio may stray from the correct model's for a mistaken expectation. */
export const RATIO_TOLERANCE = 0.03;

/** The judge's verdict on every surprise of a hard test, or a failure. */
const readSurprises = async function(name, reports, text) {
    if (!text.trim()) return { failure: { type: 'Wrong diagnosis', details: 'The engine gave no explanation.' } };
    try {
        const reading = await extract(`mentalModelVsBug|${name}|${reports.length}|${text}`, [
            { role: 'system', content: 'You read an answer to a modeler who listed several things their model did that surprised them, and report what the answer concludes about each: that the model has a mistake, or that the modeler\'s expectation is mistaken. Report only what the answer says; do not judge whether it is right.' },
            { role: 'user', content: `The modeler's surprises:\n${reports.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\nThe answer:\n"""\n${text}\n"""\n\nFor every numbered surprise, report what the answer concludes.` }
        ], itemsSchema);
        return { verdicts: Object.fromEntries((reading.surprises || []).map((x) => [x.number, x.verdict])) };
    } catch (error) {
        return { failure: { type: 'Evaluation error', details: `Error reading the answer: ${error.message}` } };
    }
};

/** One criterion of a hard-group test. */
const evaluateHard = async function(generatedResponse, expectations) {
    const c = hardCases[expectations.caseName];
    const clean = expectations.criterion === 'clean';
    const failures = [];
    const generated = bareModel(generatedResponse);
    if (!generated || (generated.variables || []).length === 0) {
        return validateEvaluationResult([{ type: 'No model produced', details: `The engine did not return a model.${generatedResponse?.err ? ` Engine error: ${generatedResponse.err}` : ''}` }]);
    }
    const whole = await behaviorMismatch(generated, c.correct, BEHAVIOR_TOLERANCE);
    if (expectations.criterion === 'behavior') {
        if (whole) failures.push({ type: 'Bug not fixed', details: `The returned model does not behave like the correct one: ${whole}` });
        return validateEvaluationResult(failures);
    }
    const reports = hardReports(c, clean);
    const read = await readSurprises(expectations.caseName, reports, responseText(generatedResponse));
    if (read.failure) return validateEvaluationResult([read.failure]);
    if (clean) {
        reports.forEach((r, i) => {
            if (read.verdicts[i + 1] !== VERDICTS.expectation) failures.push({ type: 'Wrong diagnosis', details: `Surprise ${i + 1} is a mistaken expectation, but the answer concludes "${read.verdicts[i + 1] ?? 'nothing'}".` });
        });
        if (whole) failures.push({ type: 'Correct model changed', details: `The model was right, but the returned model behaves differently: ${whole}` });
        return validateEvaluationResult(failures);
    }
    const x = c.items[expectations.item];
    const said = read.verdicts[expectations.item + 1];
    if (said !== VERDICTS[x.kind]) failures.push({ type: 'Wrong diagnosis', details: `The answer concludes "${said ?? 'nothing'}" about surprise ${expectations.item + 1}; in fact ${x.kind === 'bug' ? 'the model has a bug there' : 'the expectation is mistaken'}.` });
    if (x.kind === 'bug') {
        // Fixed in place (the planted variable, put into the correct model) or anywhere (the whole model).
        const hybrid = hybridModel(c.correct, generated, x.variable, x.fields);
        const mismatch = hybrid ? await behaviorMismatch(hybrid, c.correct, BEHAVIOR_TOLERANCE) : 'the variable is gone';
        if (mismatch && whole) failures.push({ type: 'Bug not fixed', details: `With the returned "${x.variable}" the model still misbehaves: ${mismatch}` });
    } else {
        // Not bent to the mistaken expectation: doubling the constant moves the stock as in the correct model.
        const ratio = await doublingRatio({ ...generated, relationships: generated.relationships || [], specs: c.correct.specs }, x.stock, x.constant).catch(() => null);
        if (ratio === null || Math.abs(ratio - x.correctRatio) > RATIO_TOLERANCE) failures.push({ type: 'Correct model changed', details: `Doubling "${x.constant}" should move "${x.stock}" by a factor of ${x.correctRatio}, as in the correct model; in the returned model it ${ratio === null ? 'cannot be run' : `moves it by ${ratio.toFixed(3)}`}.` });
    }
    return validateEvaluationResult(failures);
};

/**
 * The second hard group's one test: every surprise told for what it is, every bug fixed, every
 * mistaken expectation left as it is (doubling its constant moves its stock as in the correct model),
 * and the whole returned model behaving like the correct one — all graded together, each as in the
 * first hard group.
 */
const evaluateTogether = async function(generatedResponse, expectations) {
    const c = hard2Cases[expectations.caseName];
    const generated = bareModel(generatedResponse);
    if (!generated || (generated.variables || []).length === 0) {
        return validateEvaluationResult([{ type: 'No model produced', details: `The engine did not return a model.${generatedResponse?.err ? ` Engine error: ${generatedResponse.err}` : ''}` }]);
    }
    const reports = c.items.map((x) => x.report);
    const read = await readSurprises(expectations.caseName, reports, responseText(generatedResponse));
    if (read.failure) return validateEvaluationResult([read.failure]);
    const failures = [];
    const whole = await behaviorMismatch(generated, c.correct, BEHAVIOR_TOLERANCE);
    for (const [i, x] of c.items.entries()) {
        const said = read.verdicts[i + 1];
        if (said !== VERDICTS[x.kind]) failures.push({ type: 'Wrong diagnosis', details: `The answer concludes "${said ?? 'nothing'}" about surprise ${i + 1}; in fact ${x.kind === 'bug' ? 'the model has a bug there' : 'the expectation is mistaken'}.` });
        if (x.kind === 'expectation') {
            const ratio = await doublingRatio({ ...generated, relationships: generated.relationships || [], specs: c.correct.specs }, x.stock, x.constant).catch(() => null);
            if (ratio === null || Math.abs(ratio - x.correctRatio) > RATIO_TOLERANCE) failures.push({ type: 'Correct model changed', details: `Doubling "${x.constant}" should move "${x.stock}" by a factor of ${x.correctRatio}, as in the correct model; in the returned model it ${ratio === null ? 'cannot be run' : `moves it by ${ratio.toFixed(3)}`}.` });
        }
    }
    if (whole) failures.push({ type: 'Bug not fixed', details: `The returned model does not behave like the correct one: ${whole}` });
    return validateEvaluationResult(failures);
};

export const methodology = () => withFloors('mentalModelVsBug', {
    howItWorks: [
        `Each case reports a surprise about a model: what it does, and what the modeler expected instead. In half the cases the model has one planted bug and the expectation is right (the bugs of the guided correction category, a reservoir whose releases are capped, and a town nobody should move into that has newcomers). In the other half the model is correct and the expectation is wrong — the coffee never quite reaches room temperature, the town grows although births are fewer than deaths — and the unit tests check by simulation that the correct model does what the report says. One report appears twice, word for word — a town with fewer births than deaths that keeps growing — once about a town with newcomers (the expectation is wrong) and once about a town nobody moves into (the model is wrong), so how plausible a report sounds does not give the answer away.`,
        `Besides the hand-written cases, every scenario in the shared scenario library gives a pair by a general rule (mentalModelVsBugData/generate.js) on its own model, or none, and both reports of a pair take the same form, so the wording says nothing about which is which: "When I double X, Y ends the run only about N% higher (lower) than before. I expected doubling X to roughly double (halve) Y." In the expectation case the model is correct and doubling X really moves Y by only N% (between ${100 * MIN_CHANGE}% and ${100 * MAX_RISE}% up, or ${100 * MAX_FALL}% down). In the bug case one error planted by the guidedCorrection rule is what holds Y back: in the correct model doubling X really does roughly double (halve) Y, within ${100 * PROPORTIONAL}%.`,
        `The mentalModelVsBugHard group is built by difficulty levers applied by rule (mentalModelVsBugData/hard.js), never by picking cases an agent failed: a scenario's generated surprises put together in one report of at least ${HARD_ITEMS} — its bugs planted in its full model at once where their reports still hold together, else one bug, beside its mistaken expectations, every report re-measured on the model the agent is given — so the agent must tell bug from mistaken expectation surprise by surprise in a model where both are present. Each surprise is a test: the judge's verdict on it must match, a bug must be fixed, and for a mistaken expectation doubling the constant must still move the stock as in the correct model (within ${RATIO_TOLERANCE}). A clean control asks the same about the correct model, reporting only its mistaken expectations; it passes only when every one is called a mistaken expectation and the model comes back behaving as it did.`,
        `Second hard group (mentalModelVsBugHard2, held-out scenarios only; the lever: several answers graded together, all needed to pass), by rule (mentalModelVsBugData/hard2.js): a held-out scenario's generated pairs — each a bug and a mistaken expectation, so the kinds are always equal in number and any constant verdict is wrong for half — put together in one report on its full model with the pairs' bugs planted (all pairs at once, else the first pair alone whose surprises all still hold, re-measured on the model the agent is given; a report the first hard group already asks is not repeated). It is one test, where the first hard group grades each surprise on its own: every verdict must match, every bug be fixed, every mistaken expectation's doubling still move its stock as in the correct model (within ${RATIO_TOLERANCE}), and the whole returned model behave like the correct one.`,
        `A fixed judge model reads the agent's answer and reports from closed options whether it concludes that the model has a mistake or that the expectation is mistaken; it must match the case. For a bug, the agent's version of the planted variable is put back into the correct model — or the agent's whole model, since a bug can be fixed somewhere other than where it was planted — must then keep every stock within ${100 * BEHAVIOR_TOLERANCE}% of the correct run. For a wrong expectation, the returned model as a whole must still behave like the correct model within the same tolerance — changing a correct model to match a wrong expectation fails.`
    ],
    criteria: [
        { name: 'Wrong diagnosis', description: 'The answer calls a bug a mistaken expectation or the other way round, does not decide, or gives no explanation.' },
        { name: 'Bug not fixed', description: 'With the agent\'s version of the planted variable, the model still does not behave like the correct one.' },
        { name: 'Correct model changed', description: 'The model was right, but the returned model behaves differently.' },
        { name: 'No model produced', description: 'The engine returned no model.' },
        { name: 'Evaluation error', description: 'The judge call failed; recorded as a failure so a broken judge never reads as a good answer.' }
    ],
    scoring: `Two tests per case, graded from one generation. The diagnosis test also requires the model handled to match, and the left-alone test also requires the right diagnosis, so answering "bug" to everything or returning every model unchanged scores nothing. The second hard group has one test per case, everything about it graded together.`
});
