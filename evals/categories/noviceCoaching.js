/**
 * This is the novice coaching test
 *
 * A good teacher of system dynamics does not hand a novice the answer: they ask questions that let
 * the novice see why their first idea will not work, and lead them to a policy that will. This
 * category puts the agent with a scripted novice who arrives convinced of a policy that, in the
 * hidden simulation behind the scenario, does not meet their goal.
 *
 * The novice (evals/utilities/scriptedUser.js) knows the history, the mechanisms and the numbers
 * behind them of a hidden scenario (evals/utilities/scenarios/library.js) — enough for a careful
 * agent to rebuild the system — and answers only what is asked. After a fixed number of rounds they
 * list the candidate policies, with their exact values, and ask which to adopt.
 *
 * Which policies work is decided by simulation: each candidate policy is run in the hidden model and
 * either meets the novice's goal or does not, by a margin the unit tests check.
 *
 * Grading, one criterion per test:
 *   - the agent's recommendation, read by a judge against the closed list of candidate policies,
 *     meets the goal when everything it recommends is done together in the hidden simulation
 *   - over the conversation, the agent shows why the novice's favoured policy falls short
 *   - the agent leads with questions: its first reply asks the novice something
 *
 * @module categories/noviceCoaching
 */

import { z } from 'zod';
import { validateEvaluationResult } from '../evaluationSchema.js';
import { extract } from '../utilities/judge.js';
import { scenarios } from '../utilities/scenarios/library.js';
import { evaluatePolicy } from '../utilities/scenarios/scenarioKit.js';
import { withFloors } from '../floors/statement.js';
import { splitHeldOut, isHeldOutScenario } from '../utilities/heldOut.js';
import { HARD_GOALS, hardGoalLabel } from './policyImplementation.js';

export const MAX_QUESTION_TURNS = 6;
export const MAX_FACTS_PER_TURN = 2;

export const description = () => {
    return `The novice coaching test evaluates whether an agent can coach a novice to a policy that works. A scripted novice arrives convinced of a policy that, in the hidden simulation behind the scenario, does not meet their goal. Leading with questions, the agent must show why that policy falls short, and when asked what to do, recommend a policy that the simulation shows works — and none that does not.`;
};

const misconceptionOf = (s) => s.policies.find((p) => p.id === s.misconception);

export const userScriptFor = function(s) {
    return {
        id: `${s.id}:novice`,
        facts: [
            { id: 'history', topic: 'what has happened over time (the numbers and trends observed)', text: s.history },
            ...s.mechanisms.map((m) => ({ id: `mechanism:${m.id}`, topic: m.topic, text: m.fact })),
            ...(s.parameterFacts || []).map((f) => ({ id: `parameter:${f.id}`, topic: f.topic, text: f.text }))
        ],
        unknownReply: "Hmm, I don't know — I hadn't thought about that.",
        maxQuestionTurns: MAX_QUESTION_TURNS,
        maxFactsPerTurn: MAX_FACTS_PER_TURN,
        // The closing question lists the candidate policies with their exact values: whether a
        // policy works depends on its numbers, and the answer must be gradable against the simulation.
        closingMessage: `OK. So, given all that — which of these should we actually do to ${s.goal.label}? Tell me which you recommend (one or more, or none) and why.\n${s.policies.map((p, i) => `${i + 1}. ${p.text}`).join('\n')}`
    };
};

const promptFor = (s) => `${s.opening} I'm new to this kind of thinking. Our goal is to ${s.goal.label}, and I'm pretty sure the answer is simple: ${misconceptionOf(s).text.charAt(0).toLowerCase()}${misconceptionOf(s).text.slice(1)} Can you help me think it through?`;

const generateTests = function(id) {
    const s = scenarios[id];
    const base = {
        prompt: promptFor(s),
        currentModel: null,
        // A discussion mode: coaching needs no model, and a build mode would end the conversation
        // with the harness's model-not-written nudge.
        additionalParameters: { mode: 'sfd-discuss', problemStatement: `I want to ${s.goal.label}.`, userScript: userScriptFor(s) }
    };
    const shared = { scenario: id, policies: s.policies.map((p) => p.text), parts: s.policies.map((p) => (p.parts || []).map((part) => s.policies.findIndex((q) => q.id === part))) };
    return [
        { ...base, name: `${s.title}: recommends a policy that works`, expectations: { ...shared, criterion: 'recommendation', effective: s.policies.map((p) => p.effective) } },
        { ...base, name: `${s.title}: shows why "${misconceptionOf(s).id}" falls short`, expectations: { ...shared, criterion: 'misconception', misconception: misconceptionOf(s).text } },
        { ...base, name: `${s.title}: leads with questions`, expectations: { ...shared, criterion: 'asksFirst' } }
    ];
};

/**
 * The hard group's scenarios and goals: the policy implementation category's hard goals (a tighter
 * threshold no single policy on the list meets but the listed combination does, re-derived by
 * simulation in that category's unit tests), so the recommendation must be a combination.
 */
export const hardIds = Object.keys(scenarios).filter((id) => scenarios[id].goal && HARD_GOALS[id]);

/** The hard novice's closing question lists the options but does not say several may be chosen. */
export const hardUserScriptFor = function(s) {
    return {
        ...userScriptFor(s),
        closingMessage: `OK. So, given all that — what should we do to ${hardGoalLabel(s, HARD_GOALS[s.id].threshold)}? These are the options on the table:\n${s.policies.map((p, i) => `${i + 1}. ${p.text}`).join('\n')}`
    };
};

const hardPromptFor = (s) => `${s.opening} I'm new to this kind of thinking. We want to ${hardGoalLabel(s, HARD_GOALS[s.id].threshold)}, and I'm pretty sure the answer is simple: ${misconceptionOf(s).text.charAt(0).toLowerCase()}${misconceptionOf(s).text.slice(1)} Can you help me think it through?`;

const generateHardTest = function(id) {
    const s = scenarios[id];
    const label = hardGoalLabel(s, HARD_GOALS[id].threshold);
    return {
        prompt: hardPromptFor(s),
        currentModel: null,
        additionalParameters: { mode: 'sfd-discuss', problemStatement: `I want to ${label}.`, userScript: hardUserScriptFor(s) },
        name: `${s.title}: (hard) recommends what meets the tighter goal and shows why "${misconceptionOf(s).id}" falls short`,
        expectations: {
            scenario: id,
            criterion: 'hard',
            policies: s.policies.map((p) => p.text),
            parts: s.policies.map((p) => (p.parts || []).map((part) => s.policies.findIndex((q) => q.id === part))),
            effective: s.policies.map((p) => p.effective),
            misconception: misconceptionOf(s).text,
            threshold: HARD_GOALS[id].threshold,
            goalLabel: label
        }
    };
};

const rawGroups = {
    noviceCoaching: Object.keys(scenarios).filter((id) => scenarios[id].goal).flatMap(generateTests),
    noviceCoachingHard: hardIds.map(generateHardTest)
};


/** The groups, each split into its dev tests and its held-out ones (`<group>HeldOut`); see utilities/heldOut.js. */
export const groups = splitHeldOut(rawGroups, (t) => isHeldOutScenario(t.expectations.scenario));
export const recommendationSchema = z.object({
    policies: z.array(z.object({
        number: z.number().int().positive().describe('The number of the policy'),
        recommended: z.enum(['yes', 'no']).describe("'yes' if the final answer recommends doing exactly what this option says; if it recommends a combination that is listed as its own option, mark that option and not its parts; 'no' otherwise")
    })).describe('One entry for every numbered policy')
});

export const asksFirstSchema = z.object({
    asksBeforeAdvising: z.enum(['yes', 'no']).describe("'yes' if this first reply asks the user for information or for their own thinking before giving any advice on what to do; 'no' if it gives advice or an answer first, or only asks rhetorically")
});

export const misconceptionSchema = z.object({
    addressed: z.enum(['yes', 'no']).describe("'yes' if, anywhere in the conversation, the assistant explains or leads the user to see that the user's favoured policy would not be enough on its own or would not work; 'no' if it endorses it or never deals with it")
});

/** The agent's turns up to the first message the harness itself sent (a nudge is not the user). */
const agentTurns = (r) => {
    const transcript = r?.transcript || [];
    const firstSynthetic = transcript.findIndex((t) => t.role === 'user' && t.synthetic);
    return (firstSynthetic === -1 ? transcript : transcript.slice(0, firstSynthetic)).filter((t) => t.role === 'agent');
};

/**
 * Evaluates one criterion.
 * @param {Object} generatedResponse The conversation engine's response
 * @param {Object} expectations The criterion
 * @returns {Promise<Array<Object>>} Failures
 */
export const evaluate = async function(generatedResponse, expectations) {
    // Showing why the misconception falls short, and leading with questions, count only when the
    // coaching ends in advice that works: agreeing with every reading, or asking and never landing
    // anywhere, scores nothing.
    if (expectations.criterion === 'hard') {
        // The recommendation against the tighter goal, and the misconception shown to fall short,
        // together; each graded as in its own test.
        const failures = [];
        for (const criterion of ['recommendation', 'misconception']) failures.push(...(await evaluateOne(generatedResponse, { ...expectations, criterion })));
        const first = failures.find((f) => f.type === 'No response produced');
        return validateEvaluationResult(first ? [first] : failures);
    }
    const own = await evaluateOne(generatedResponse, expectations);
    if (expectations.criterion === 'recommendation') return own;
    const sibling = rawGroups.noviceCoaching.find((t) => t.expectations.scenario === expectations.scenario && t.expectations.criterion === 'recommendation');
    const recommendation = sibling ? await evaluateOne(generatedResponse, sibling.expectations) : [];
    return validateEvaluationResult([...own, ...recommendation]);
};

const evaluateOne = async function(generatedResponse, expectations) {
    if (generatedResponse?.err) return validateEvaluationResult([{ type: 'No response produced', details: `The engine failed: ${generatedResponse.err}` }]);
    if (!Array.isArray(generatedResponse?.transcript)) return validateEvaluationResult([{ type: 'No response produced', details: 'The response has no transcript; this category needs the test-agent-converse engine.' }]);
    const turns = agentTurns(generatedResponse);
    if (!turns.length) return validateEvaluationResult([{ type: 'No response produced', details: 'The agent said nothing.' }]);
    const failures = [];
    switch (expectations.criterion) {
        case 'recommendation': {
            const finalText = turns[turns.length - 1].text;
            let reading;
            try {
                reading = await extract(`noviceCoaching|rec|${expectations.scenario}|${finalText}`, [
                    { role: 'system', content: 'You read an assistant\'s final advice and report which of a numbered list of policies it recommends. Report only what the advice says.' },
                    { role: 'user', content: `Policies:\n${expectations.policies.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\nAdvice:\n"""\n${finalText}\n"""\n\nFor every numbered policy, report whether the advice recommends it.` }
                ], recommendationSchema);
            } catch (error) {
                failures.push({ type: 'Evaluation error', details: `Error reading the advice: ${error.message}` });
                break;
            }
            let recommended = (reading.policies || []).filter((p) => p.recommended === 'yes').map((p) => p.number - 1);
            // A recommended combination stands for its parts: marking a part as well adds nothing.
            const covered = new Set(recommended.flatMap((i) => expectations.parts[i] || []));
            recommended = recommended.filter((i) => !covered.has(i));
            if (!recommended.length) {
                failures.push({ type: 'Ineffective recommendation', details: 'The final advice recommends none of the policies.' });
                break;
            }
            // The advice is judged as a whole: everything it recommends, done together, run in the
            // hidden simulation. Recommending a helpful extra alongside a policy that works is good
            // advice — even the novice's own idea, as an extra, if the advice as a whole works (whether
            // the agent showed why that idea falls short alone is its own test). Two kinds of advice
            // fail before any simulation: advice that contradicts itself (two recommendations setting
            // the same lever differently), and recommending every option, which is no coaching.
            const s = scenarios[expectations.scenario];
            if (recommended.length === s.policies.length) {
                failures.push({ type: 'Ineffective recommendation', details: 'The advice recommends every option; that leaves the novice no wiser about what works.' });
                break;
            }
            const overrides = {};
            for (const i of recommended) {
                for (const [lever, value] of Object.entries(s.policies[i].overrides)) {
                    if (lever in overrides && overrides[lever] !== value) {
                        failures.push({ type: 'Ineffective recommendation', details: `The advice contradicts itself: two of its recommendations set "${lever}" to different values.` });
                    }
                    overrides[lever] = value;
                }
            }
            if (failures.length) break;
            // The hard group carries its own, tighter threshold; every other test is graded on the scenario's.
            const goal = expectations.threshold === undefined ? s.goal : { ...s.goal, threshold: expectations.threshold, label: expectations.goalLabel };
            const outcome = await evaluatePolicy({ ...s, goal }, overrides);
            if (!outcome.meets) {
                failures.push({ type: 'Ineffective recommendation', details: `Following all of the advice — ${recommended.map((i) => `"${expectations.policies[i]}"`).join(' and ')} — does not ${goal.label} in the simulation (the measure comes to ${Number(outcome.value.toPrecision(4))} against a threshold of ${goal.threshold}).` });
            }
            break;
        }
        case 'misconception': {
            const text = turns.map((t) => t.text).join('\n\n---\n\n');
            let reading;
            try {
                reading = await extract(`noviceCoaching|mis|${expectations.scenario}|${text}`, [
                    { role: 'system', content: 'You read the assistant\'s side of a conversation and report one thing: whether it shows the user that the user\'s favoured policy would not be enough or would not work. Report only what the conversation shows.' },
                    { role: 'user', content: `The user's favoured policy: "${expectations.misconception}"\n\nThe assistant's messages:\n"""\n${text}\n"""` }
                ], misconceptionSchema);
            } catch (error) {
                failures.push({ type: 'Evaluation error', details: `Error reading the conversation: ${error.message}` });
                break;
            }
            if (reading.addressed !== 'yes') failures.push({ type: 'Misconception not addressed', details: `The agent never showed why "${expectations.misconception}" would not meet the goal.` });
            break;
        }
        case 'asksFirst': {
            let reading;
            try {
                reading = await extract(`noviceCoaching|ask|${expectations.scenario}|${turns[0].text}`, [
                    { role: 'system', content: 'You read the first reply an assistant gave a user and report one thing: whether it asks the user for information or for their own thinking before giving any advice. Report only what the reply does.' },
                    { role: 'user', content: `Reply:\n"""\n${turns[0].text}\n"""` }
                ], asksFirstSchema);
            } catch (error) {
                failures.push({ type: 'Evaluation error', details: `Error reading the first reply: ${error.message}` });
                break;
            }
            if (reading.asksBeforeAdvising !== 'yes') failures.push({ type: 'Told instead of asked', details: 'The agent\'s first reply gives advice before asking the novice anything.' });
            break;
        }
        default:
            throw new Error(`Unknown criterion ${expectations.criterion}`);
    }
    return validateEvaluationResult(failures);
};

export const methodology = () => withFloors('noviceCoaching', {
    howItWorks: [
        `Each test is built on a hidden scenario with a goal for its key behavior — for example, keep a dialysis waiting list from ever going above 80 patients — and a handful of candidate policies. Each policy is run in the hidden simulation and either meets the goal or does not; the unit tests check every outcome sits clearly on one side of the threshold.`,
        `The agent talks with a scripted novice who arrives convinced of one policy that does not work. The novice knows the history, the mechanisms and the numbers behind them — enough to rebuild the system — and answers only what the agent specifically asks (routed by a fixed judge model, answered with fixed sentences, at most ${MAX_FACTS_PER_TURN} per reply). After at most ${MAX_QUESTION_TURNS} rounds of questions, or as soon as the agent stops asking, the novice lists the candidate policies with their exact values and asks which to adopt.`,
        `A fixed judge model reads the agent's answer to the novice's closing question against the closed list of candidate policies and reports which it recommends; advice that recommends every option or contradicts itself fails, and otherwise everything recommended is applied together in the hidden simulation and the advice passes when that meets the goal; a second reading reports whether, anywhere in the conversation, the agent showed why the novice's favoured policy falls short; a third reports whether the agent's first reply asks before it advises. The judge is never told which policies work.`,
        `Hard group (noviceCoachingHard): every scenario with a hard goal in the policy implementation category — a tighter threshold, midway between the best single policy on the list and the best combination, so no single policy meets it — is coached again toward that goal; the novice's closing question lists the options without saying several may be chosen, and one test needs advice that meets the tighter goal in the hidden simulation (in effect, a combination) and the favoured policy shown to fall short, together.`
    ],
    criteria: [
        { name: 'Ineffective recommendation', description: 'The final advice recommends nothing; recommends every option; contradicts itself (two recommendations set the same lever differently); or what it recommends, all done together, does not meet the goal when run in the hidden simulation.' },
        { name: 'Misconception not addressed', description: 'The agent never showed why the novice\'s favoured policy would not meet the goal.' },
        { name: 'Told instead of asked', description: 'The agent\'s first reply gave advice before asking the novice anything.' },
        { name: 'No response produced', description: 'The engine failed, returned no transcript, or the agent said nothing.' },
        { name: 'Evaluation error', description: 'The judge call failed; recorded as a failure so a broken judge never reads as a good answer.' }
    ],
    scoring: `One criterion per test, all graded from one conversation per scenario; in the hard group, one test per scenario with the recommendation and the misconception graded together. The misconception and leads-with-questions tests also require advice that works, so coaching that never lands on a working policy scores nothing.`
});
