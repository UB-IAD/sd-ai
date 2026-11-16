/**
 * This is the MECE test
 *
 * The variables of a good model are mutually exclusive and collectively exhaustive: two quantities
 * that overlap must not both be counted, and a total must include every part. Violations are easy
 * to make and hard to see — staff and nurses both added into capacity when nurses are staff, a
 * total population that forgets one group, a stock drained twice for the same demand. This
 * category plants one such error in an otherwise correct model and asks the agent to find
 * overlapping or missing categories and fix them.
 *
 * Grading, one test per case and a behavior test:
 *   - the error is identified (a judge reads the agent's explanation against the real error mixed
 *     with distractors) and fixed: the agent's version of the planted variable, put back into the
 *     correct model, makes it behave like the correct model again
 *
 * The meceHard group (see meceData/hard.js) plants several errors of different kinds at once — a
 * total with a gap, another counting a part twice, a stock drained twice, and, wherever the model
 * admits one, another stock filled twice — in a scenario's full model, asks only whether the model is ready ("fix anything that needs it"), and adds a clean
 * control: the same request on the correct model.
 *
 * @module categories/mece
 */

import { z } from 'zod';
import { validateEvaluationResult } from '../evaluationSchema.js';
import { extract } from '../utilities/judge.js';
import { bareModel, simulateModel } from '../utilities/simulateModel.js';
import { findVariable } from '../utilities/modelDiff.js';
import { hybridModel, behaviorMismatch } from '../utilities/behaviorCompare.js';
import { cases, plantedModel, hardCases, plantedHardModel } from './meceData/cases.js';
import { readyPrompt, pickHard, cleanVerdictFailure, CLEAN_CRITERIA, responseText } from './guidedCorrectionData/hardShared.js';
import { withFloors } from '../floors/statement.js';
import { MIN_DEVIATION } from './guidedCorrectionData/generate.js';
import { splitHeldOut, caseHeldOut } from '../utilities/heldOut.js';

export const BEHAVIOR_TOLERANCE = 0.01;

export const description = () => {
    return `The MECE test evaluates whether an agent can find variables that are not mutually exclusive and collectively exhaustive — quantities counted twice because they overlap, totals that leave a part out — explain the problem and fix it. Each planted error is graded on whether the agent identified it and whether its fix makes the model behave like the correct one.`;
};

export const issueList = function(c) {
    // The real error's place in the list moves from case to case, so a judge's position bias
    // cannot favor it.
    const list = c.distractors.map((text) => ({ text, real: false }));
    list.splice(Math.max(0, Object.keys(cases).findIndex((k) => cases[k].text === c.text)) % (list.length + 1), 0, { text: c.text, real: true });
    return list;
};

const prompt = (c) => `Please check my model of ${c.description} for categories that overlap (something counted twice) or that leave something out (a total or breakdown that misses a part). Explain any you find and fix them, keeping the existing variable names, and return the complete model.`;

const generateTests = function(name) {
    const c = cases[name];
    const base = { prompt: prompt(c), currentModel: plantedModel(c), additionalParameters: { problemStatement: `I want to be sure my model of ${c.description} counts everything exactly once.` } };
    return [
        { ...base, name: `${name}: identifies and fixes the ${c.kind}`, expectations: { caseName: name, criterion: 'error' } },
        { ...base, name: `${name}: corrected model behaves like the correct one`, expectations: { caseName: name, criterion: 'behavior' } }
    ];
};

/** The hard cases the hard group takes (see guidedCorrectionData/hardShared.js). */
export const HARD = pickHard(hardCases, null);

/** The hard issue list: the real errors and the distractors, interleaved. */
export const hardIssueList = function(c) {
    const list = [];
    for (let i = 0; i < Math.max(c.plants.length, c.distractors.length); i++) {
        if (c.plants[i]) list.push({ text: c.plants[i].text, plantId: c.plants[i].id });
        if (c.distractors[i]) list.push({ text: c.distractors[i], plantId: null });
    }
    return list;
};

const generateHard = function(name) {
    const c = hardCases[name];
    const base = { prompt: readyPrompt(c.description), currentModel: plantedHardModel(c), additionalParameters: { problemStatement: `I want my model of ${c.description} to be right.` } };
    const shared = { caseName: name, hard: true };
    return [
        ...c.plants.map((p) => ({ ...base, name: `${name}: identifies and fixes "${p.id}" unprompted`, expectations: { ...shared, criterion: 'error', plantId: p.id } })),
        { ...base, name: `${name}: corrected model behaves like the correct one`, expectations: { ...shared, criterion: 'behavior' } }
    ];
};

const generateClean = (name) => [{
    prompt: readyPrompt(hardCases[name].description),
    currentModel: structuredClone(hardCases[name].correct),
    additionalParameters: { problemStatement: `I want my model of ${hardCases[name].description} to be right.` },
    name: `${name} (clean control): finds nothing to fix and leaves the correct model as it is`,
    expectations: { caseName: name, hard: true, criterion: 'clean' }
}];

const rawGroups = {
    mece: Object.keys(cases).flatMap(generateTests),
    meceHard: [...HARD.faulty.flatMap(generateHard), ...HARD.clean.flatMap(generateClean)]
};


/** The groups, each split into its dev tests and its held-out ones (`<group>HeldOut`); see utilities/heldOut.js. */
export const groups = splitHeldOut(rawGroups, (t) => caseHeldOut((t.expectations.hard ? hardCases : cases)[t.expectations.caseName]));
const identificationSchema = z.object({
    issues: z.array(z.object({ number: z.number().int().positive(), identified: z.enum(['yes', 'no']).describe("'yes' if the response identifies this issue in substance") }))
});

/**
 * Whether a model fixes the error outside the planted variable: every variable of the correct model
 * — stocks, flows and auxiliaries, the planted one among them — runs in the agent's model as it does
 * in the correct one. A compensation that zeroes an input (setting a real share to 0 so the total
 * comes out right) changes that input's run and fails.
 */
export const fixedElsewhere = async function(generated, c) {
    if (await behaviorMismatch(generated, c.correct, BEHAVIOR_TOLERANCE)) return false;
    const names = c.correct.variables.map((v) => v.name);
    const mine = names.map((n) => findVariable(generated.variables || [], n));
    if (mine.some((v) => !v)) return false;
    const [a, b] = await Promise.all([
        simulateModel({ ...generated, relationships: generated.relationships || [], specs: c.correct.specs }, mine.map((v) => v.name), null),
        simulateModel(c.correct, names, null)
    ]);
    if (!a.ok || !b.ok) return false;
    return names.every((n, k) => {
        const x = a.series[mine[k].name];
        const y = b.series[n];
        if (!x || !y || x.length !== y.length) return false;
        const scale = Math.max(...y.map(Math.abs), 1e-9);
        return x.every((v, i) => Number.isFinite(v) && Math.abs(v - y[i]) <= BEHAVIOR_TOLERANCE * scale);
    });
};

/**
 * Evaluates one criterion.
 * @param {Object} generatedResponse The engine's response
 * @param {Object} expectations The criterion
 * @returns {Promise<Array<Object>>} Failures
 */
export const evaluate = async function(generatedResponse, expectations) {
    if (expectations.hard) return evaluateHard(generatedResponse, expectations);
    const c = cases[expectations.caseName];
    const generated = bareModel(generatedResponse);
    if (!generated || (generated.variables || []).length === 0) {
        return validateEvaluationResult([{ type: 'No model produced', details: `The engine did not return a model.${generatedResponse?.err ? ` Engine error: ${generatedResponse.err}` : ''}` }]);
    }
    const failures = [];
    if (expectations.criterion === 'behavior') {
        const mismatch = await behaviorMismatch(generated, c.correct, BEHAVIOR_TOLERANCE);
        if (mismatch) failures.push({ type: 'Model still miscounts', details: mismatch });
        return validateEvaluationResult(failures);
    }
    const hybrid = hybridModel(c.correct, generated, c.plant.variable, Object.keys(c.plant.change));
    const hybridMismatch = hybrid ? await behaviorMismatch(hybrid, c.correct, BEHAVIOR_TOLERANCE) : `The revised model no longer has "${c.plant.variable}".`;
    // The fix may be built outside the planted variable's own fields — the miscounted total rebuilt
    // through a new helper the correct model lacks, say. That counts when the whole model behaves
    // like the correct one and the miscounted quantity itself now computes the right thing; a
    // compensation elsewhere that leaves it wrong (subtracting the missing part where the total is
    // used) does not.
    if (hybridMismatch && !(await fixedElsewhere(generated, c))) {
        failures.push({ type: 'MECE error not fixed', details: hybrid ? `With the revised "${c.plant.variable}" the model still miscounts: ${hybridMismatch}` : hybridMismatch });
    }
    const text = generatedResponse?.supportingInfo?.explanation || generatedResponse?.output?.textContent || '';
    const list = issueList(c);
    if (!text.trim()) failures.push({ type: 'MECE error not identified', details: 'The engine gave no explanation.' });
    else {
        try {
            const reading = await extract(`mece|${expectations.caseName}|${text}`, [
                { role: 'system', content: 'You read a review of a model and report which of a list of possible issues the review identified. Do NOT judge whether the issues are real.' },
                { role: 'user', content: `Possible issues:\n${list.map((x, i) => `${i + 1}. ${x.text}`).join('\n')}\n\nReview:\n"""\n${text}\n"""` }
            ], identificationSchema);
            const number = list.findIndex((x) => x.real) + 1;
            if ((reading.issues || []).find((x) => x.number === number)?.identified !== 'yes') failures.push({ type: 'MECE error not identified', details: `The review does not identify the problem: ${c.text}` });
        } catch (error) {
            failures.push({ type: 'Evaluation error', details: `Error reading the review: ${error.message}` });
        }
    }
    return validateEvaluationResult(failures);
};

/** One criterion of a hard-group test: one of several plants, the whole model, or a clean control. */
const evaluateHard = async function(generatedResponse, expectations) {
    const c = hardCases[expectations.caseName];
    const generated = bareModel(generatedResponse);
    if (!generated || (generated.variables || []).length === 0) {
        return validateEvaluationResult([{ type: 'No model produced', details: `The engine did not return a model.${generatedResponse?.err ? ` Engine error: ${generatedResponse.err}` : ''}` }]);
    }
    const failures = [];
    const text = responseText(generatedResponse);
    if (expectations.criterion === 'behavior') {
        const mismatch = await behaviorMismatch(generated, c.correct, BEHAVIOR_TOLERANCE);
        if (mismatch) failures.push({ type: 'Model still miscounts', details: mismatch });
        return validateEvaluationResult(failures);
    }
    if (expectations.criterion === 'clean') {
        const mismatch = await behaviorMismatch(generated, c.correct, BEHAVIOR_TOLERANCE);
        if (mismatch) failures.push({ type: 'Correct model changed', details: `The model needed no fixing, but the returned model behaves differently: ${mismatch}` });
        const said = await cleanVerdictFailure(`mece|clean|${expectations.caseName}|${text}`, c.description, text);
        if (said) failures.push(said);
        return validateEvaluationResult(failures);
    }
    // One plant: fixed in place (the agent's version of its variable, put into the correct model,
    // behaves like it) or elsewhere (the whole model runs like the correct one, variable by variable).
    const plant = c.plants.find((p) => p.id === expectations.plantId);
    const hybrid = hybridModel(c.correct, generated, plant.variable, Object.keys(plant.change));
    const hybridMismatch = hybrid ? await behaviorMismatch(hybrid, c.correct, BEHAVIOR_TOLERANCE) : `The revised model no longer has "${plant.variable}".`;
    if (hybridMismatch && !(await fixedElsewhere(generated, c))) {
        failures.push({ type: 'MECE error not fixed', details: hybrid ? `With the revised "${plant.variable}" the model still miscounts: ${hybridMismatch}` : hybridMismatch });
    }
    const list = hardIssueList(c);
    if (!text.trim()) failures.push({ type: 'MECE error not identified', details: 'The engine gave no explanation.' });
    else {
        try {
            const reading = await extract(`mece|${expectations.caseName}|${text}`, [
                { role: 'system', content: 'You read a review of a model and report which of a list of possible issues the review identified. Do NOT judge whether the issues are real.' },
                { role: 'user', content: `Possible issues:\n${list.map((x, i) => `${i + 1}. ${x.text}`).join('\n')}\n\nReview:\n"""\n${text}\n"""` }
            ], identificationSchema);
            const number = list.findIndex((x) => x.plantId === plant.id) + 1;
            if ((reading.issues || []).find((x) => x.number === number)?.identified !== 'yes') failures.push({ type: 'MECE error not identified', details: `The review does not identify the problem: ${plant.text}` });
        } catch (error) {
            failures.push({ type: 'Evaluation error', details: `Error reading the review: ${error.message}` });
        }
    }
    return validateEvaluationResult(failures);
};

export const methodology = () => withFloors('mece', {
    howItWorks: [
        `Each case is a correct model with one MECE error planted in one variable: an overlap (staff and nurses both counted when nurses are staff; a stock drained twice for the same demand) or a gap (a total population that leaves out one group). The planted error changes what the model computes, which the unit tests check by simulation.`,
        `Besides the hand-written cases, every scenario in the shared scenario library gets cases by a general rule (meceData/generate.js) from its totals — variables that add up two or more of its stocks: the total leaving one stock out (a gap), and the total counting one stock twice (an overlap), each kept only if it moves some stock by at least ${100 * MIN_DEVIATION}% of its largest value; the distractors are claims of the same kinds about other parts of the model.`,
        `The agent is asked to find categories that overlap or leave something out, explain them and fix them.`,
        `The meceHard group is built by difficulty levers applied by rule (meceData/hard.js) to every model with a total — the scenarios' full models, then the hand cases' — never by picking cases an agent failed: two or three MECE errors of different kinds at once (the first total leaving a stock out, a second total counting one twice, a stock drained twice by a copy of one of its outflows), plus one more fault wherever the model admits one — another stock filled twice by a copy of one of its inflows, the first stock no other error names whose copy alone moves some stock by at least ${100 * MIN_DEVIATION}% and keeps the whole planted model running — a request that names no kind of problem ("is it ready for policy analysis? fix anything that needs it"), and a clean control — the same request on the correct model, which passes only when the model comes back behaving as it did and the response says it needed no fixing. Each error is graded as above, against a list that mixes all of them with distractors.`,
        `The error is fixed when the agent's version of the planted variable, put back into the correct model, makes every stock stay within ${100 * BEHAVIOR_TOLERANCE}% of the correct run — or, where the fix is built elsewhere, when every variable of the correct model, the planted one among them, runs within it in the agent's model. It is identified when a fixed judge model, reading the explanation against the real error mixed with distractors, reports that the explanation names it.`
    ],
    criteria: [
        { name: 'MECE error not fixed', description: 'With the agent\'s version of the planted variable the model still does not behave like the correct one — unless the fix sits elsewhere and every variable of the correct model, the miscounted one among them, runs as it does in the correct model.' },
        { name: 'MECE error not identified', description: 'The explanation does not name the planted overlap or gap.' },
        { name: 'Model still miscounts', description: 'The whole revised model does not behave like the correct one.' },
        ...CLEAN_CRITERIA,
        { name: 'No model produced', description: 'The engine returned no model.' },
        { name: 'Evaluation error', description: 'The judge call failed; recorded as a failure so a broken judge never reads as a good answer.' }
    ],
    scoring: `Two tests per case: the error identified and fixed, and the whole model behaving correctly.`
});
