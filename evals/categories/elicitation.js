/**
 * This is the elicitation test
 *
 * Most modeling starts with a client who knows a great deal and says very little. The modeler has
 * to ask: what has happened, what drives it, what the client's people actually do. This category
 * tests that skill. The agent gets a one-line complaint; everything else it must ask for.
 *
 * The user is scripted (evals/utilities/scriptedUser.js) and backed by a hidden scenario
 * (evals/utilities/scenarios/library.js). The user knows the history, every mechanism of the hidden
 * system, and some facts that lie outside it, and gives a fact only when the agent asks about its
 * topic — a fixed sentence, at most a couple per reply, and "I'm not sure" to anything else. After a
 * fixed number of question rounds the user asks for a boundary summary and a causal loop diagram.
 *
 * Grading, one criterion per test:
 *   - for each mechanism the hidden simulation shows matters: the agent asked for it (the fact was
 *     released to it), the diagram contains the causal path it creates, and the boundary summary
 *     puts it inside the model
 *   - for each outside fact the agent drew out: the summary leaves it outside the model
 *   - the agent asked about the history (what has happened over time) at all
 *
 * @module categories/elicitation
 */

import { z } from 'zod';
import { validateEvaluationResult } from '../evaluationSchema.js';
import { extract } from '../utilities/judge.js';
import { graphFromLinks, pathPolarities, foldVariable, cldLinksFromResponse } from '../utilities/causalGraph.js';
import { scenarios } from '../utilities/scenarios/library.js';
import { withFloors } from '../floors/statement.js';
import { splitHeldOut, isHeldOutScenario } from '../utilities/heldOut.js';

export const MAX_QUESTION_TURNS = 6;
export const MAX_FACTS_PER_TURN = 2;

export const description = () => {
    return `The elicitation test evaluates whether an agent asks the questions a modeler needs. Starting from a one-line complaint, it questions a scripted user who answers only what is asked, from a hidden scenario's history and mechanisms. Within a fixed number of rounds it must draw out every mechanism the hidden simulation shows matters, put each into its causal loop diagram and inside its stated model boundary, and keep the irrelevant facts it hears outside.`;
};

/** The scripted user's fact bank: the history, every mechanism, and the outside facts. */
export const userScriptFor = function(s) {
    return {
        id: s.id,
        facts: [
            { id: 'history', topic: 'what has happened over time (the numbers and trends observed)', text: s.history },
            ...s.mechanisms.map((m) => ({ id: `mechanism:${m.id}`, topic: m.topic, text: m.fact })),
            ...s.outsideFacts.map((o, i) => ({ id: `outside:${i}`, topic: o.topic, text: o.text }))
        ],
        unknownReply: "I'm not sure — I don't really know about that.",
        maxQuestionTurns: MAX_QUESTION_TURNS,
        maxFactsPerTurn: MAX_FACTS_PER_TURN,
        closingMessage: `That's everything I can think of for now. Please summarize what you would put inside the model boundary and what you would leave outside, and build, as the model, a causal loop diagram of the situation with a polarity on every link. Use these names for the quantities you include: ${s.glossary.map((g) => `"${g}"`).join(', ')}.`
    };
};

const promptFor = (s) => `${s.opening} I'd like to build a model of this with you eventually, but first I need you to understand the situation. Ask me whatever you need to know — I'll answer as best I can.`;

const generateTests = function(id) {
    const s = scenarios[id];
    const base = {
        prompt: promptFor(s),
        currentModel: null,
        additionalParameters: { mode: 'cld', userScript: userScriptFor(s) }
    };
    const shared = { scenario: id };
    const tests = [{ ...base, name: `${s.title}: asks what has happened over time`, expectations: { ...shared, criterion: 'elicited', factId: 'history', label: 'the history' } }];
    for (const m of s.mechanisms.filter((x) => x.verdict === 'matters')) {
        tests.push({ ...base, name: `${s.title}: draws out ${m.id}`, expectations: { ...shared, criterion: 'elicited', factId: `mechanism:${m.id}`, label: m.id } });
        if (m.signature) tests.push({ ...base, name: `${s.title}: diagram contains ${m.id}`, expectations: { ...shared, criterion: 'signature', mechanism: m.id, signature: m.signature } });
        tests.push({ ...base, name: `${s.title}: puts ${m.id} inside the boundary`, expectations: { ...shared, criterion: 'boundary', factId: `mechanism:${m.id}`, include: true, text: m.fact } });
    }
    for (const m of s.mechanisms.filter((x) => x.verdict === 'irrelevant')) {
        tests.push({ ...base, name: `${s.title}: keeps ${m.id} outside the boundary`, expectations: { ...shared, criterion: 'boundary', factId: `mechanism:${m.id}`, include: false, text: m.fact } });
    }
    s.outsideFacts.forEach((o, i) => {
        tests.push({ ...base, name: `${s.title}: keeps "${o.text}" outside the boundary`, expectations: { ...shared, criterion: 'boundary', factId: `outside:${i}`, include: false, text: o.text } });
    });
    return tests;
};

/** The facts that matter in a scenario: its history and every mechanism that matters. */
export const matteringFacts = (s) => ['history', ...s.mechanisms.filter((m) => m.verdict === 'matters').map((m) => `mechanism:${m.id}`)];

/** The hard group's scenarios, by rule: those with at least HARD_MIN_FACTS facts that matter. */
export const HARD_MIN_FACTS = 4;
export const hardIds = Object.keys(scenarios).filter((id) => matteringFacts(scenarios[id]).length >= HARD_MIN_FACTS);

/**
 * The hard question budget: fewer rounds than there are facts that matter — just enough to draw
 * them all out at the user's limit of MAX_FACTS_PER_TURN a reply, so every question has to count.
 */
export const hardBudget = (s) => Math.ceil(matteringFacts(s).length / MAX_FACTS_PER_TURN);

/** The hard prompt: the complaint, and no invitation to ask about anything in particular. */
const hardPromptFor = (s) => `${s.opening} I'd like to build a model of this with you eventually. I don't have long today, so make your questions count.`;

/** Every criterion of a scenario, as the expectations of its own tests. */
const partsFor = (id) => generateTests(id).map((t) => t.expectations);

const generateHardTest = function(id) {
    const s = scenarios[id];
    return {
        prompt: hardPromptFor(s),
        currentModel: null,
        additionalParameters: { mode: 'cld', userScript: { ...userScriptFor(s), maxQuestionTurns: hardBudget(s) } },
        name: `${s.title}: (hard) in ${hardBudget(s)} rounds draws out, diagrams and bounds every fact that matters, and keeps out what it heard that does not`,
        expectations: { scenario: id, criterion: 'hard' }
    };
};

const rawGroups = {
    elicitation: Object.keys(scenarios).flatMap(generateTests),
    elicitationHard: hardIds.map(generateHardTest)
};


/** The groups, each split into its dev tests and its held-out ones (`<group>HeldOut`); see utilities/heldOut.js. */
export const groups = splitHeldOut(rawGroups, (t) => isHeldOutScenario(t.expectations.scenario));
/** Every fact id the scripted user gave the agent, from the transcript. */
export const releasedFacts = function(generatedResponse) {
    return new Set((generatedResponse?.transcript || []).flatMap((t) => t.factsReleasedAfter || []));
};

export const boundarySchema = z.object({
    points: z.array(z.object({
        number: z.number().int().positive().describe('The number of the point'),
        placement: z.enum(['inside', 'outside', 'not mentioned']).describe("Where the summary puts this point: 'inside' the model boundary, 'outside' it, or 'not mentioned'")
    })).describe('One entry for every numbered point')
});

const boundaryMessages = (text, points) => [
    { role: 'system', content: 'You read an assistant\'s summary of a model boundary and report, for each numbered point, whether the summary puts it inside the model, outside it, or does not mention it. Report only what the summary says.' },
    { role: 'user', content: `Points:
${points.map((p, i) => `${i + 1}. ${p}`).join('\n')}

Summary:
"""
${text}
"""

For every numbered point, report where the summary puts it.` }
];

/**
 * The agent's answer to the closing request: its last turn before any message the harness itself
 * sent (the model-not-written nudge), which would otherwise be answered last.
 */
const finalAnswer = function(generatedResponse) {
    const transcript = generatedResponse?.transcript || [];
    const firstSynthetic = transcript.findIndex((t) => t.role === 'user' && t.synthetic);
    const upTo = firstSynthetic === -1 ? transcript : transcript.slice(0, firstSynthetic);
    const agentTurns = upTo.filter((t) => t.role === 'agent');
    return agentTurns.length ? agentTurns[agentTurns.length - 1].text : '';
};

/**
 * Evaluates one criterion.
 * @param {Object} generatedResponse The conversation engine's response
 * @param {Object} expectations The criterion
 * @returns {Promise<Array<Object>>} Failures
 */
export const evaluate = async function(generatedResponse, expectations) {
    // Keeping something outside the boundary counts only once the agent has drawn out some
    // mechanism that matters: an agent that asks nothing keeps everything outside, and would pass.
    const own = await evaluateOne(generatedResponse, expectations);
    if (!(expectations.criterion === 'boundary' && expectations.include === false)) return own;
    const s = scenarios[expectations.scenario];
    const mattering = s.mechanisms.filter((m) => m.verdict === 'matters').map((m) => `mechanism:${m.id}`);
    const siblings = rawGroups.elicitation.filter((t) => t.expectations.scenario === expectations.scenario && t.expectations.criterion === 'elicited' && mattering.includes(t.expectations.factId));
    for (const t of siblings) if (!(await evaluateOne(generatedResponse, t.expectations)).length) return own;
    return validateEvaluationResult([...own, { type: 'Not elicited', details: 'This test counts only once at least one mechanism that matters has been drawn out; none has.' }]);
};

const evaluateOne = async function(generatedResponse, expectations) {
    if (expectations.criterion === 'hard') {
        // Every criterion of the scenario at once, each graded exactly as in its own test; an
        // outside fact the agent never heard cannot be misplaced, as there.
        const failures = [];
        for (const part of partsFor(expectations.scenario)) failures.push(...(await evaluateOne(generatedResponse, { ...part, budget: hardBudget(scenarios[expectations.scenario]) })));
        const first = failures.find((f) => f.type === 'No response produced');
        return validateEvaluationResult(first ? [first] : failures);
    }
    if (generatedResponse?.err) return validateEvaluationResult([{ type: 'No response produced', details: `The engine failed: ${generatedResponse.err}` }]);
    if (!Array.isArray(generatedResponse?.transcript)) return validateEvaluationResult([{ type: 'No response produced', details: 'The response has no transcript; this category needs the test-agent-converse engine.' }]);
    const s = scenarios[expectations.scenario];
    const released = releasedFacts(generatedResponse);
    const failures = [];
    switch (expectations.criterion) {
        case 'elicited': {
            if (!released.has(expectations.factId)) failures.push({ type: 'Not elicited', details: `In ${expectations.budget ?? MAX_QUESTION_TURNS} rounds the agent never asked about ${expectations.label}, so it never learned it.` });
            break;
        }
        case 'signature': {
            if (!released.has(`mechanism:${expectations.mechanism}`)) { failures.push({ type: 'Mechanism missing from diagram', details: `The agent never asked about ${expectations.mechanism}, so it cannot have modeled it from what the user said.` }); break; }
            const links = cldLinksFromResponse(generatedResponse);
            if (!links.length) { failures.push({ type: 'Mechanism missing from diagram', details: 'The agent built no diagram with signed links.' }); break; }
            const graph = graphFromLinks(links);
            const { from, to, polarity } = expectations.signature;
            const paths = graph.names.has(foldVariable(from)) && graph.names.has(foldVariable(to)) ? pathPolarities(graph, foldVariable(from), foldVariable(to), new Set()) : new Set();
            if (!paths.has(polarity)) failures.push({ type: 'Mechanism missing from diagram', details: paths.size ? `The diagram links "${from}" to "${to}" only with polarity ${[...paths].join('/')}; ${expectations.mechanism} needs ${polarity}.` : `The diagram has no path from "${from}" to "${to}", which ${expectations.mechanism} creates.` });
            break;
        }
        case 'boundary': {
            // An outside fact the agent never heard cannot be misplaced; one it never drew out of a
            // mechanism that matters is already failed by the elicitation test, and fails here too.
            if (!expectations.include && !released.has(expectations.factId)) break;
            if (expectations.include && !released.has(expectations.factId)) { failures.push({ type: 'Boundary wrong', details: `The agent never learned that "${expectations.text}", so it cannot be inside its boundary.` }); break; }
            const text = finalAnswer(generatedResponse);
            const points = [...s.mechanisms.filter((m) => m.verdict !== 'ambiguous').map((m) => m.fact), ...s.outsideFacts.map((o) => o.text)];
            let reading;
            try {
                reading = await extract(`elicitation|${expectations.scenario}|${text}`, boundaryMessages(text, points), boundarySchema);
            } catch (error) {
                failures.push({ type: 'Evaluation error', details: `Error reading the summary: ${error.message}` });
                break;
            }
            const number = points.indexOf(expectations.text) + 1;
            const placement = (reading.points || []).find((p) => p.number === number)?.placement ?? 'not mentioned';
            if (expectations.include && placement !== 'inside') failures.push({ type: 'Boundary wrong', details: `"${expectations.text}" matters to the behavior, but the summary ${placement === 'outside' ? 'leaves it outside' : 'does not place it'}.` });
            if (!expectations.include && placement === 'inside') failures.push({ type: 'Boundary wrong', details: `"${expectations.text}" has nothing to do with the problem, but the summary puts it inside the model.` });
            break;
        }
        default:
            throw new Error(`Unknown criterion ${expectations.criterion}`);
    }
    return validateEvaluationResult(failures);
};

export const methodology = () => withFloors('elicitation', {
    howItWorks: [
        `Each test is built on a hidden scenario: a small working simulation the agent never sees. The agent starts with only the user's one-line complaint and an invitation to ask questions.`,
        `The user is scripted. They know the history of the problem, every mechanism of the hidden system, and a couple of facts that lie outside it, each filed under a topic. A router — a fixed judge model reading only the agent's message and the list of topics — decides which topics the agent specifically asked about; the user then answers with those facts' fixed sentences, at most ${MAX_FACTS_PER_TURN} per reply, or with "I'm not sure" when nothing matches. A catch-all request such as "tell me everything" asks about no topic. The router's decisions are cached by the agent's text, so the same question always gets the same answer.`,
        `After at most ${MAX_QUESTION_TURNS} rounds of questions, or as soon as the agent stops asking, the user asks for a summary of the model boundary and a causal loop diagram built as the model, in a glossary of names.`,
        `A mechanism matters when switching it off in the hidden simulation changes the behavior the problem is about (checked in the unit tests). For each, the agent must have drawn it out, its diagram must contain the causal path the mechanism creates with the right sign, and its summary must put it inside the boundary (read by a judge that reports only what the summary says). Outside facts the agent drew out must not be put inside.`,
        `Hard group (elicitationHard): every scenario with at least ${HARD_MIN_FACTS} facts that matter (its history and the mechanisms that matter) is asked again with a question budget smaller than that number — just enough rounds to draw them all out at ${MAX_FACTS_PER_TURN} a reply — and a prompt that invites no particular question, and one test needs every one of the scenario's criteria met at once.`
    ],
    criteria: [
        { name: 'Not elicited', description: 'Within the question rounds, the agent never asked about the history or about a mechanism that matters.' },
        { name: 'Mechanism missing from diagram', description: 'The diagram lacks the causal path a mechanism that matters creates, or gives it the wrong sign.' },
        { name: 'Boundary wrong', description: 'The summary leaves out (or never learned) a mechanism that matters, or puts inside the model a mechanism the simulation shows does not matter or a fact from outside the system.' },
        { name: 'No response produced', description: 'The engine failed or returned no transcript.' },
        { name: 'Evaluation error', description: 'The judge call failed; recorded as a failure so a broken judge never reads as a good answer.' }
    ],
    scoring: `One criterion per test, all graded from one conversation per scenario; in the hard group, one test per scenario with every criterion graded together. A mechanism the agent never asked about fails its elicitation, diagram and boundary tests: what was never learned cannot be modeled.`
});
