/**
 * This is the transferability test
 *
 * A policy can work beautifully in a model and fail in the world, because the model assumes what
 * the organization cannot do: chairs that arrive in two weeks when they take nine months, members
 * four times as persuasive with no evidence for it. An assistant should catch those assumptions
 * before a policy is adopted — and should not cry wolf at the numbers that are well founded.
 *
 * Each case gives the agent a model with a policy in place that meets the goal, every number behind
 * it noted with where it comes from, and asks whether the policy would work in practice. The unit
 * tests check that the policy works only because of the unrealistic assumptions. Grading, read by a
 * judge from closed options:
 *   - one test per unrealistic assumption: the answer flags it as unrealistic or doubtful
 *   - one test per sound assumption: the answer does not flag it
 *
 * The transferabilityHard group (transferabilityData/generate.js, generateHardCase) notes three
 * levers pushed past their realistic limits among three sound numbers and every other limited lever
 * at a value within its limit, in the same wording, and asks only whether to adopt the policy.
 *
 * @module categories/transferability
 */

import { z } from 'zod';
import { validateEvaluationResult } from '../evaluationSchema.js';
import { extract } from '../utilities/judge.js';
import { findVariable } from '../utilities/modelDiff.js';
import { glossaryModel } from '../utilities/scenarios/renameModel.js';
import { scenarios } from '../utilities/scenarios/library.js';
import { cases, hardCases, caseModel } from './transferabilityData/cases.js';
import { withFloors } from '../floors/statement.js';
import { splitHeldOut, caseHeldOut, laterBatch } from '../utilities/heldOut.js';

export const description = () => {
    return `The transferability test evaluates whether an agent can tell when a policy that works in a model would not work in practice: given a model in which a policy meets its goal, and a note of where each number behind it comes from, the agent must flag the assumptions that are unrealistic — contradicted by experience or wishful — without flagging the ones that are well founded.`;
};

export const modelFor = (c, reverted) => caseModel(c, glossaryModel(scenarios[c.scenario]), findVariable, reverted);

const prompt = (c) => {
    const s = scenarios[c.scenario];
    return `${s.narrative}${c.context ? ` ${c.context}` : ''}\n\nOur analyst has put a policy into the model: ${c.policy}. In the model it works — it achieves our goal to ${s.goal.label}. The documentation of each variable says where its number comes from. Before we adopt the policy, please tell me whether it would work in practice: which of the assumptions behind it are unrealistic, and which are sound? Please don't change the model.`;
};

const generateTests = function(name) {
    const c = cases[name];
    const base = { prompt: prompt(c), currentModel: modelFor(c, false), additionalParameters: { mode: 'sfd', problemStatement: `I want to know whether ${c.policy.split(' — ')[0]} would work in practice.` } };
    // Each test pairs an unrealistic assumption with a sound one, and passes only when the first is
    // flagged and the second is not: flagging everything, or nothing, scores nothing.
    const unrealistic = c.assumptions.filter((a) => !a.realistic);
    const sound = c.assumptions.filter((a) => a.realistic);
    return unrealistic.map((u, i) => ({
        ...base,
        name: `${name}: flags the unrealistic assumption about ${u.variable} and accepts the sound one about ${sound[i].variable}`,
        expectations: { caseName: name, assumptions: [u.id, sound[i].id] }
    }));
};

/** A case of either group, by name. */
const caseOf = (name) => cases[name] ?? hardCases[name];

/**
 * The hard group's prompt: no hint. It asks only whether to adopt the policy — not which
 * assumptions are unrealistic, nor that any are.
 */
const hardPrompt = (c) => {
    const s = scenarios[c.scenario];
    return `${s.narrative}${c.context ? ` ${c.context}` : ''}\n\nOur analyst has put a policy into the model: ${c.policy}. In the model it achieves our goal to ${s.goal.label}. The documentation of each variable says where its number comes from. Should we adopt it? Please don't change the model.`;
};

/** One test per hard case: every assumption read together, each flagged or not as it should be. */
const generateHardTests = function(name) {
    const c = hardCases[name];
    return [{
        prompt: hardPrompt(c),
        currentModel: modelFor(c, false),
        additionalParameters: { mode: 'sfd', problemStatement: `I want to decide whether to ${c.policy.split(' — ')[0]}.` },
        name: `${name}: flags all three unrealistic assumptions and none of the ${c.assumptions.filter((a) => a.realistic).length} sound ones`,
        expectations: { caseName: name, assumptions: c.assumptions.map((a) => a.id) }
    }];
};

/**
 * Whether a hard case notes at least one limited lever as sound, within its limit — what keeps a
 * lever's having a stated limit from marking its number as one to doubt (the test "three
 * unrealistic, three sound and every other limited lever within its limit").
 */
const notesLeverWithinLimit = function(c) {
    const bounded = Object.keys(scenarios[c.scenario].realistic.bounds).map((b) => b.toLowerCase());
    return c.assumptions.some((a) => a.realistic && bounded.includes(a.variable.toLowerCase()));
};

/** The hard cases the group takes: every first-batch one; a later-batch one only if it meets the rule above. */
export const HARD_TAKEN = Object.keys(hardCases).filter((n) => !laterBatch(hardCases[n]) || notesLeverWithinLimit(hardCases[n]));

const rawGroups = {
    transferability: Object.keys(cases).flatMap(generateTests),
    transferabilityHard: HARD_TAKEN.flatMap(generateHardTests)
};


/** The groups, each split into its dev tests and its held-out ones (`<group>HeldOut`); see utilities/heldOut.js. */
export const groups = splitHeldOut(rawGroups, (t) => caseHeldOut(caseOf(t.expectations.caseName)));
const FLAGGED = 'flagged as unrealistic';

const readingSchemaFor = (assumptions) => z.object(Object.fromEntries(assumptions.map((a, i) => [
    `q${i + 1}`,
    z.enum([FLAGGED, 'accepted with minor caveats', 'accepted as sound', 'not discussed']).describe(`Assumption ${i + 1} ("${a.variable}"): ${a.note} '${FLAGGED}' only if the answer says it is wrong, contradicted by experience, unsupported by any evidence, or a reason the policy would not work in practice; 'accepted with minor caveats' if it accepts it while noting some uncertainty, calling it an assumption, or suggesting it be checked or confirmed; 'accepted as sound' if it says it is reasonable or uses it without question. The answer may refer to the assumption by its variable's name or its value rather than by the note.`)
])));

/**
 * Evaluates one assumption.
 * @param {Object} generatedResponse The engine's response
 * @param {Object} expectations The assumption
 * @returns {Promise<Array<Object>>} Failures
 */
export const evaluate = async function(generatedResponse, expectations) {
    const c = caseOf(expectations.caseName);
    const text = generatedResponse?.supportingInfo?.explanation || generatedResponse?.output?.textContent || '';
    if (!text.trim()) return validateEvaluationResult([{ type: 'No answer given', details: `The engine gave no answer.${generatedResponse?.err ? ` Engine error: ${generatedResponse.err}` : ''}` }]);
    let reading;
    try {
        reading = await extract(`transferability|${expectations.caseName}|${text}`, [
            { role: 'system', content: 'You read a review of a policy and report, for each listed assumption behind it, whether the review flags it as unrealistic, accepts it with minor caveats, accepts it as sound, or does not discuss it. Report only what the review says; do not judge the assumptions yourself.' },
            { role: 'user', content: `Assumptions (each the note on a variable of the model):\n${c.assumptions.map((x, i) => `${i + 1}. [${x.variable}] ${x.note}`).join('\n')}\n\nReview:\n"""\n${text}\n"""` }
        ], readingSchemaFor(c.assumptions));
    } catch (error) {
        return validateEvaluationResult([{ type: 'Evaluation error', details: `Error reading the review: ${error.message}` }]);
    }
    const failures = [];
    for (const a of expectations.assumptions.map((id) => c.assumptions.find((x) => x.id === id))) {
    const said = reading[`q${c.assumptions.indexOf(a) + 1}`];
    if (!a.realistic && said !== FLAGGED) failures.push({ type: 'Unrealistic assumption missed', details: `"${a.note}" is what makes the policy work in the model, and it would not hold in practice; the review ${said === 'accepted as sound' ? 'accepts it' : 'does not question it'}.` });
    if (a.realistic && said === FLAGGED) failures.push({ type: 'Sound assumption doubted', details: `"${a.note}" is well founded, but the review flags it as unrealistic.` });
    }
    return validateEvaluationResult(failures);
};

export const methodology = () => withFloors('transferability', {
    howItWorks: [
        `Each case is a hidden scenario's model — a dialysis network, a bike-share scheme, a distributor — with a policy an analyst has put in, which meets the scenario's goal in the model. Every number the policy rests on has a note in its documentation of where it comes from. Two notes per case are unrealistic: contradicted by what the manager has seen (chairs in two weeks when they take nine months; demand that stays at 100 when it has already stepped up), or wishful with no evidence (members four times as persuasive). Two are sound, in line with the account and the records. The wording gives nothing away: in each case one unrealistic note cites a source (a catalogue, a census) and one sound note is written as an assumption, so each note has to be checked against the manager's account. The unit tests check that the policy meets the goal as given and misses it once the unrealistic assumptions are put back to what experience says, so the policy really does work only because of them.`,
        `The agent is given the manager's account, the model and the policy, and asked whether the policy would work in practice: which assumptions are unrealistic and which are sound. A fixed judge model reads the answer and reports, for each assumption, whether it flags it as unrealistic, accepts it with minor caveats, accepts it, or does not discuss it. Each test pairs one unrealistic assumption with one sound one: it passes only when the unrealistic one is flagged and the sound one is not (accepting it with a caveat is fine), so flagging everything, or nothing, scores nothing.`,
        `The hard group (transferabilityHard) applies a general rule to every scenario that can give a case: the scenario's misconception made to work by pushing three bounded levers just past their realistic limits (by the smallest of 1.25, 1.5, 2, 3, 5 or 10 times that does it), noted among three sound numbers with source-citing and assumed wording on both sides, and every other lever the account puts a limit on noted too, as sound, at its value in the model where that is within the limit (the policy's own lever at its new value) and in the same wording as the pushed ones — so a lever's having a stated limit does not by itself make its number one to doubt, and each value has to be checked against its limit; the prompt only asks whether to adopt the policy, with no hint that any assumption is in doubt, and the one test per case passes only when all three unrealistic assumptions are flagged and none of the sound ones is. Only the flags are graded, not the verdict: the library's realistic limits are set so the best realistic setting meets the goal, so the policy may well work with the three levers at their limits, and "adopt it, with these numbers brought back to what is achievable" is a passing answer — numbers past a stated limit are unrealistic whatever the outcome.`
    ],
    criteria: [
        { name: 'Unrealistic assumption missed', description: 'An assumption the policy depends on, which would not hold in practice, is not flagged.' },
        { name: 'Sound assumption doubted', description: 'A well-founded assumption is flagged as unrealistic.' },
        { name: 'No answer given', description: 'The engine gave no answer.' },
        { name: 'Evaluation error', description: 'The judge call failed; recorded as a failure so a broken judge never reads as a good answer.' }
    ],
    scoring: `Two tests per case, each an unrealistic assumption paired with a sound one, graded from one generation; in the hard group, one test per case covering every assumption.`
});
