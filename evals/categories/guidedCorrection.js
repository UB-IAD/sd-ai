/**
 * This is the guided correction test
 *
 * A modeling assistant has to notice when a model is wrong, explain the problem so the modeler
 * understands it, and fix it — including when the mistake is in a model it built itself and
 * nobody has pointed at it. This category plants formulation errors in otherwise correct models
 * and checks both halves: whether the engine identified each error, and whether the model it
 * returned actually fixes it.
 *
 * Three groups:
 *   - findAndFix: the user says the model misbehaves and asks for the problems to be found,
 *     explained and fixed.
 *   - selfCorrection: the model is presented as one the engine built earlier, with an error in it,
 *     and the user asks for an unrelated addition. Nothing mentions the error; a good assistant
 *     fixes it anyway while making the addition. Only the model is graded in this group.
 *   - guidedConversation: a conversation (run on test-agent-converse). A scripted novice reports
 *     only what they see going wrong and answers the agent's questions with the symptoms; the agent
 *     has to diagnose, explain and fix the errors, and run the model after its last change.
 *   - findAndFixHard: three errors of three different kinds at once in a scenario's full model,
 *     plus a fourth wherever the model admits one (guidedCorrectionData/hard.js), and a request that names no problem ("is this ready for policy analysis? fix anything that
 *     needs it"); plus a clean control — the same request on the correct model, where the right
 *     answer is that nothing needs fixing (see guidedCorrectionData/hardShared.js).
 *
 * Whether an error is fixed is decided by simulation, one error at a time: the engine's version of
 * the variable the error lives in is put back into the correct model (with any helper variables
 * the engine introduced), and the result must simulate like the correct model. Whether the engine
 * identified an error is read by a judge from a list of problem descriptions that mixes the real
 * errors with distractors, so the judge is never handed only true problems.
 *
 * @module categories/guidedCorrection
 */

import { z } from 'zod';
import { validateEvaluationResult } from '../evaluationSchema.js';
import { extract } from '../utilities/judge.js';
import { findVariable, referencedNames, foldName } from '../utilities/modelDiff.js';
import { simulateModel, bareModel, allFinite } from '../utilities/simulateModel.js';
import { ranAfterLastChange } from '../utilities/toolLog.js';
import { hybridModel, behaviorMismatch } from '../utilities/behaviorCompare.js';
import { cases, hardCases, plantErrors } from './guidedCorrectionData/cases.js';
import { HARD_ERRORS, EXTRA_ERRORS } from './guidedCorrectionData/hard.js';
import { readyPrompt, pickHard, cleanVerdictFailure, CLEAN_CRITERIA, responseText } from './guidedCorrectionData/hardShared.js';
import { MIN_DEVIATION } from './guidedCorrectionData/generate.js';
import { withFloors } from '../floors/statement.js';
import { splitHeldOut, caseHeldOut } from '../utilities/heldOut.js';

/** How close the engine's fix must bring a stock to the correct model's, as a share of its range of values. */
export const BEHAVIOR_TOLERANCE = 0.01;

export const description = () => {
    return `The guided correction test evaluates whether an engine can find the formulation errors in a model, explain them, and fix them — both when the user asks it to and when the error sits unmentioned in a model it built earlier and the user only asks for an unrelated addition. Each planted error is graded on its own: identified in the explanation, and fixed in the returned model, as judged by simulating the engine's version of that variable inside the correct model.`;
};

/** The problem list the judge reads against: real errors and distractors, interleaved in a fixed order. */
export const problemList = function(c) {
    const list = [];
    const max = Math.max(c.errors.length, c.distractors.length);
    for (let i = 0; i < max; i++) {
        if (c.errors[i]) list.push({ text: c.errors[i].text, errorId: c.errors[i].id });
        if (c.distractors[i]) list.push({ text: c.distractors[i], errorId: null });
    }
    return list;
};

const findAndFixPrompt = (c) => `My model of ${c.description} does not behave the way it should. Please find what is wrong with it, explain each problem so that I understand why it is a problem, and fix the model. Keep the existing variable names, and return the complete corrected model.`;

const selfCorrectionPrompt = (c) => `Earlier you built this model of ${c.description} for me. ${c.extension.request} Return the complete updated model.`;

const generateFindAndFix = function(name) {
    const c = cases[name];
    const base = {
        prompt: findAndFixPrompt(c),
        currentModel: plantErrors(c.correct, c.errors),
        additionalParameters: { problemStatement: `I'm building a model of ${c.description} and I need it to be right.` }
    };
    const shared = { caseName: name, group: 'findAndFix' };
    const tests = c.errors.map((error) => ({
        ...base,
        name: `${name}: finds and fixes "${error.id}"`,
        expectations: { ...shared, criterion: 'error', errorId: error.id }
    }));
    tests.push({ ...base, name: `${name}: corrected model behaves like the correct one`, expectations: { ...shared, criterion: 'behavior' } });
    return tests;
};

const generateSelfCorrection = function(name) {
    const c = cases[name];
    const planted = c.errors.find((e) => e.id === c.plantedForExtension);
    const base = {
        prompt: selfCorrectionPrompt(c),
        currentModel: plantErrors(c.correct, [planted]),
        additionalParameters: { problemStatement: `I'm extending my model of ${c.description}.` }
    };
    const shared = { caseName: name, group: 'selfCorrection' };
    return [
        { ...base, name: `${name}: fixes its own earlier error "${planted.id}" unprompted`, expectations: { ...shared, criterion: 'fixedOnly', errorId: planted.id } },
        { ...base, name: `${name}: makes the requested addition`, expectations: { ...shared, criterion: 'extension' } },
        { ...base, name: `${name}: updated model simulates`, expectations: { ...shared, criterion: 'simulates' } }
    ];
};

/** The scripted novice for a case: they know only the symptoms, each behind its topic. */
export const noviceScriptFor = function(name) {
    const c = cases[name];
    return {
        id: `guidedCorrection:${name}`,
        facts: c.errors.map((e) => ({ id: e.id, topic: e.symptomTopic, text: e.symptom })),
        unknownReply: "I don't know — I'm new to this and that's all I've noticed.",
        maxQuestionTurns: 4,
        maxFactsPerTurn: 2,
        closingMessage: 'Thanks. Please make sure the model is corrected now, and tell me what was wrong.'
    };
};

const generateConversation = function(name) {
    const c = cases[name];
    const base = {
        prompt: `I'm new to modeling. My model of ${c.description} isn't behaving the way I expect, but I can't see why. Can you help me work out what's wrong? I'd like to understand it, not just have it fixed.`,
        currentModel: plantErrors(c.correct, c.errors),
        additionalParameters: { mode: 'sfd', userScript: noviceScriptFor(name) }
    };
    const shared = { caseName: name, group: 'guidedConversation' };
    return [
        ...c.errors.map((error) => ({ ...base, name: `${name} (conversation): diagnoses, explains and fixes "${error.id}"`, expectations: { ...shared, criterion: 'error', errorId: error.id } })),
        { ...base, name: `${name} (conversation): corrected model behaves like the correct one`, expectations: { ...shared, criterion: 'behavior' } },
        { ...base, name: `${name} (conversation): runs the model after its last change`, expectations: { ...shared, criterion: 'ranAfterChange' } }
    ];
};

/** The case a test is about: a hard case for the hard group's tests, else one of the cases. */
const caseFor = (expectations) => (expectations.hard ? hardCases : cases)[expectations.caseName];

/**
 * The hard cases the hard group takes (see hardShared.js). A later-batch case joins only with four
 * errors at once, as the extra-fault lever gives every case the group takes (the test "the
 * extra-fault lever: every case the group takes carries four errors at once").
 */
export const HARD = pickHard(hardCases, (c) => c.errors.length === 4);

const generateHard = function(name) {
    const c = hardCases[name];
    const base = { prompt: readyPrompt(c.description), currentModel: plantErrors(c.correct, c.errors), additionalParameters: { problemStatement: `I'm building a model of ${c.description} and I need it to be right.` } };
    const shared = { caseName: name, group: 'findAndFixHard', hard: true };
    return [
        ...c.errors.map((error) => ({ ...base, name: `${name}: finds and fixes "${error.id}" unprompted`, expectations: { ...shared, criterion: 'error', errorId: error.id } })),
        { ...base, name: `${name}: corrected model behaves like the correct one`, expectations: { ...shared, criterion: 'behavior' } }
    ];
};

const generateClean = function(name) {
    const c = hardCases[name];
    return [{
        prompt: readyPrompt(c.description),
        currentModel: structuredClone(c.correct),
        additionalParameters: { problemStatement: `I'm building a model of ${c.description} and I need it to be right.` },
        name: `${name} (clean control): finds nothing to fix and leaves the correct model as it is`,
        expectations: { caseName: name, group: 'findAndFixHard', hard: true, criterion: 'clean' }
    }];
};

const rawGroups = {
    findAndFix: Object.keys(cases).flatMap(generateFindAndFix),
    selfCorrection: Object.keys(cases).flatMap(generateSelfCorrection),
    guidedConversation: Object.keys(cases).flatMap(generateConversation),
    findAndFixHard: [...HARD.faulty.flatMap(generateHard), ...HARD.clean.flatMap(generateClean)]
};


/** The groups, each split into its dev tests and its held-out ones (`<group>HeldOut`); see utilities/heldOut.js. */
export const groups = splitHeldOut(rawGroups, (t) => caseHeldOut(caseFor(t.expectations)));
export const identificationSchema = z.object({
    problems: z.array(z.object({
        number: z.number().int().positive().describe('The number of the problem in the list'),
        identified: z.enum(['yes', 'no']).describe("'yes' if the response identifies this problem in substance (in its own words is fine), 'no' if it does not mention it or mentions it only to dismiss it")
    })).describe('One entry for every numbered problem')
});

const identificationMessages = function(text, list) {
    return [
        { role: 'system', content: `You read a response that reviews a system dynamics model and report which of a list of possible problems the response identified. Do NOT judge whether the problems are real; report only whether the response itself identified each one.` },
        { role: 'user', content: `Possible problems:
${list.map((p, i) => `${i + 1}. ${p.text}`).join('\n')}

Response:
"""
${text}
"""

For every numbered problem, report whether the response identified it.` }
    ];
};

/**
 * Whether the engine fixed one planted error, judged by simulating its version of that variable in
 * the correct model.
 * @returns {Promise<string|null>} Why it is not fixed, or null when it is
 */
export const errorNotFixed = async function(c, generated, errorId) {
    const error = c.errors.find((e) => e.id === errorId);
    const fields = Object.keys(error.change).concat(error.change.equation !== undefined ? ['graphicalFunction'] : []);
    const hybrid = hybridModel(c.correct, generated, error.variable, fields);
    if (!hybrid) return `The returned model no longer has "${error.variable}".`;
    const mismatch = await behaviorMismatch(hybrid, c.correct, BEHAVIOR_TOLERANCE);
    return mismatch ? `With the returned "${error.variable}" in place, the model does not behave like the correct one: ${mismatch}` : null;
};

const extensionFailures = function(c, generated) {
    const failures = [];
    const vars = generated.variables || [];
    for (const required of c.extension.variables || []) {
        const v = findVariable(vars, required.name);
        if (!v) { failures.push(`There is no variable named "${required.name}".`); continue; }
        if (required.type && v.type !== required.type) failures.push(`"${required.name}" is a ${v.type}, not a ${required.type}.`);
        for (const ref of required.references || []) {
            if (!referencedNames(v.equation).has(foldName(ref))) failures.push(`"${required.name}" does not depend on "${ref}".`);
        }
    }
    for (const { variable, references } of c.extension.references || []) {
        const v = findVariable(vars, variable);
        if (!v || !referencedNames(v.equation).has(foldName(references))) failures.push(`"${variable}" does not depend on "${references}".`);
    }
    for (const { stock, inflow, outflow } of c.extension.stockFlows || []) {
        const s = findVariable(vars, stock);
        const list = inflow ? s?.inflows : s?.outflows;
        const flow = inflow || outflow;
        if (!(list || []).some((f) => foldName(f) === foldName(flow))) failures.push(`"${flow}" is not ${inflow ? 'an inflow to' : 'an outflow from'} "${stock}".`);
    }
    return failures;
};

/**
 * Evaluates one criterion of a guided-correction response.
 * @param {Object} generatedResponse The engine's response
 * @param {Object} expectations The criterion
 * @returns {Promise<Array<Object>>} Failures
 */
export const evaluate = async function(generatedResponse, expectations) {
    // The updated model simulating counts only once the requested addition is made: an unchanged
    // model simulates too.
    const own = await evaluateOne(generatedResponse, expectations);
    if (expectations.criterion !== 'simulates') return own;
    const extension = await evaluateOne(generatedResponse, { ...expectations, criterion: 'extension' });
    return extension.length ? validateEvaluationResult([...own, ...extension]) : own;
};

const evaluateOne = async function(generatedResponse, expectations) {
    const c = caseFor(expectations);
    const generated = bareModel(generatedResponse);
    if (!generated || (generated.variables || []).length === 0) {
        return validateEvaluationResult([{ type: 'No model produced', details: `The engine did not return a model.${generatedResponse?.err ? ` Engine error: ${generatedResponse.err}` : ''}` }]);
    }
    const failures = [];
    switch (expectations.criterion) {
        case 'error': {
            const notFixed = await errorNotFixed(c, generated, expectations.errorId);
            if (notFixed) failures.push({ type: 'Error not fixed', details: notFixed });
            const text = generatedResponse?.supportingInfo?.explanation || generatedResponse?.output?.textContent || '';
            const list = problemList(c);
            const number = list.findIndex((p) => p.errorId === expectations.errorId) + 1;
            if (!text.trim()) {
                failures.push({ type: 'Error not explained', details: 'The engine returned no explanation of the problems it found.' });
            } else {
                try {
                    const reading = await extract(`guidedCorrection|${expectations.caseName}|${text}`, identificationMessages(text, list), identificationSchema);
                    const said = (reading.problems || []).find((p) => p.number === number)?.identified;
                    if (said !== 'yes') failures.push({ type: 'Error not explained', details: `The explanation does not identify this problem: ${list[number - 1].text}` });
                } catch (error) {
                    failures.push({ type: 'Evaluation error', details: `Error reading the explanation: ${error.message}` });
                }
            }
            break;
        }
        case 'behavior':
        case 'simulates': {
            if (expectations.criterion === 'behavior') {
                const mismatch = await behaviorMismatch(generated, c.correct, BEHAVIOR_TOLERANCE);
                if (mismatch) failures.push({ type: 'Model still misbehaves', details: mismatch });
            } else {
                const run = await simulateModel({ ...generated, relationships: generated.relationships || [], specs: c.correct.specs }, null, null);
                if (!run.ok) failures.push({ type: 'Model does not simulate', details: run.error });
                else {
                    const bad = Object.entries(run.series).find(([, values]) => !allFinite(values));
                    if (bad) failures.push({ type: 'Model does not simulate', details: `"${bad[0]}" produced non-finite values.` });
                }
            }
            break;
        }
        case 'fixedOnly': {
            const notFixed = await errorNotFixed(c, generated, expectations.errorId);
            if (notFixed) failures.push({ type: 'Own error not fixed', details: notFixed });
            break;
        }
        case 'ranAfterChange': {
            if (!Array.isArray(generatedResponse?.toolLog)) {
                failures.push({ type: 'Did not check its fix', details: 'The response carries no tool log, so there is no record of the model being run.' });
            } else if (!ranAfterLastChange(generatedResponse.toolLog)) {
                failures.push({ type: 'Did not check its fix', details: 'The agent did not run the model after its last change to it, so it never saw whether the fix worked.' });
            }
            break;
        }
        case 'clean': {
            const mismatch = await behaviorMismatch(generated, c.correct, BEHAVIOR_TOLERANCE);
            if (mismatch) failures.push({ type: 'Correct model changed', details: `The model needed no fixing, but the returned model behaves differently: ${mismatch}` });
            const said = await cleanVerdictFailure(`guidedCorrection|clean|${expectations.caseName}|${responseText(generatedResponse)}`, c.description, responseText(generatedResponse));
            if (said) failures.push(said);
            break;
        }
        case 'extension': {
            for (const problem of extensionFailures(c, generated)) failures.push({ type: 'Requested addition missing', details: problem });
            break;
        }
        default:
            throw new Error(`Unknown criterion ${expectations.criterion}`);
    }
    return validateEvaluationResult(failures);
};

export const methodology = () => withFloors('guidedCorrection', {
    howItWorks: [
        `Each case starts from a correct stock-and-flow model and plants formulation errors in it: an equation that multiplies where it should divide, a gap taken backwards, a flow attached to the wrong side of a stock or not attached at all. Each error lives in one variable — its equation, or a stock's inflows and outflows.`,
        `Besides the hand-written cases, every scenario in the shared scenario library gets a case by a general rule (guidedCorrectionData/generate.js) on its own model: two errors of different kinds — a division by a time constant made a multiplication, a gap taken backwards, a flow not connected to the stock it fills, an outflow not connected to the stock it drains — each of which alone moves some stock by at least ${100 * MIN_DEVIATION}% of its largest value, with the kind order rotating from scenario to scenario; distractors are claims of the kinds not planted, about variables where they are false; and the selfCorrection request is a constant-fraction loss from a stock the earlier error does not live in.`,
        `In the findAndFix group the user says the model misbehaves and asks for the problems to be found, explained and fixed. In the selfCorrection group the model is presented as one the engine built earlier, carrying one of the errors, and the user asks only for an unrelated addition; nothing mentions the error.`,
        `Fixes are checked by simulation, one error at a time. The engine's version of the part of the variable an error lives in — its equation, or a stock's inflows and outflows — is put back into the correct model, together with any helper variables the engine added, and every stock must then stay within ${100 * BEHAVIOR_TOLERANCE}% (of its range of values) of the correct model's run. That isolates each error: fixing one and not the other passes one test and fails the other, whatever else the engine changed.`,
        `In the guidedConversation group a scripted novice starts with only "it isn't behaving the way I expect" and answers the agent's questions with what they see — one symptom per planted error, given only when the agent asks about it — before asking for the model to be corrected. The same per-error tests apply, plus a process check from the agent's tool log: it must run the model after its last change.`,
        `The findAndFixHard group is built by difficulty levers applied by rule (guidedCorrectionData/hard.js), never by picking cases an agent failed: ${HARD_ERRORS} errors of ${HARD_ERRORS} different kinds at once in a scenario's full model, plus up to ${EXTRA_ERRORS} more fault where the model admits one (the first valid candidate of a kind not yet planted, else a second of a planted kind, in a variable no other error lives in, with the whole still moving some stock by at least ${100 * MIN_DEVIATION}%), a request that names no kind of problem ("is it ready for policy analysis? fix anything that needs it"), and a clean control — the same request on the correct model, which passes only when the model is returned behaving as it did and the response says it needed no fixing.`,
        `Explanations are read by a fixed judge model against a numbered list that mixes the real errors with distractor problems the model does not have. The judge reports which listed problems the response identified, without being told which are real; this category's code checks the real ones.`
    ],
    criteria: [
        { name: 'Error not fixed', description: 'With the engine\'s version of the erroneous variable put into the correct model, the model still does not behave like the correct one.' },
        { name: 'Error not explained', description: 'The engine\'s explanation does not identify the planted error.' },
        { name: 'Model still misbehaves', description: 'The whole returned model does not behave like the correct model.' },
        { name: 'Own error not fixed', description: 'Asked only for an addition, the engine left the error in the model it had built earlier.' },
        { name: 'Did not check its fix', description: 'In the conversation group, the tool log shows no model run after the agent\'s last change to the model.' },
        { name: 'Requested addition missing', description: 'The addition the user asked for is missing or not connected as asked.' },
        { name: 'Model does not simulate', description: 'The updated model fails to simulate or produces non-finite values.' },
        ...CLEAN_CRITERIA,
        { name: 'No model produced', description: 'The engine returned no model.' },
        { name: 'Evaluation error', description: 'The judge call failed; recorded as a failure so a broken judge never reads as a good answer.' }
    ],
    scoring: `One criterion per test, all graded from one response per case and group. In findAndFix an error passes only when it is both identified and fixed: guiding a modeler means saying what was wrong, not only changing it.`
});
