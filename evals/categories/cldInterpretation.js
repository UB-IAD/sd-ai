/**
 * This is the CLD interpretation test
 *
 * Reading a causal loop diagram correctly is the foundation of every conversation about one: which
 * loops are reinforcing and which balancing, what a change in one variable does to another, where
 * the feedback concentrates. This category hands the agent an existing diagram and asks.
 *
 * The diagrams are the modelToCLD category's (read, never changed): twenty gibberish-named diagrams
 * generated from a seed, so nothing but the diagram can answer the questions, and two real-domain
 * ones. Every answer key is computed from the diagram's graph:
 *   - loop polarity: the product of the link signs around the loop
 *   - effect of a change: asked only for pairs where every causal path from one to the other has
 *     the same sign and no path leads back, so "it depends" is never the right answer
 *   - loop count through a variable: the number of simple cycles through it
 *
 * A judge reads the agent's answers against the options given for each question; this category's
 * code compares them with the keys. One question per test; siblings share one generation.
 *
 * The gibberishCLDsHard group asks about the bigger hard flowers with no reading instruction,
 * balanced answers, every question in one test, and two dependent answers per hub: how many loops
 * pass through it and how many of those are reinforcing (hardQuestionsFor).
 *
 * @module categories/cldInterpretation
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { validateEvaluationResult } from '../evaluationSchema.js';
import { extract } from '../utilities/judge.js';
import { sourceGraph, findCycles, pathPolarities } from '../utilities/causalGraph.js';
import { withFloors } from '../floors/statement.js';
import { HELD_OUT_CLDS, GIBBERISH_CLDS, HARD_CLDS, HELD_OUT_HARD_CLDS } from './modelToCLDData/buildClds.js';
import { splitHeldOut } from '../utilities/heldOut.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = ['gibberishSmall', 'gibberishMedium', 'gibberishLarge', 'softwareRework', 'trafficCongestion', ...HELD_OUT_CLDS];
const EFFECT_QUESTIONS = 3;

export const description = () => {
    return `The CLD interpretation test evaluates whether an agent reads an existing causal loop diagram correctly: whether each loop is reinforcing or balancing, which way a change in one variable moves another, and how many loops pass through a variable. Every answer is computed from the diagram itself.`;
};

const readFixture = (key) => JSON.parse(fs.readFileSync(path.join(__dirname, 'modelToCLDData', `${key}.json`), 'utf8'));

/**
 * The questions for one diagram, with their keys, in a fixed order.
 * @param {Object} model The CLD
 * @returns {Array<{text: string, options: Array<string>, answer: string}>} Questions
 */
export const questionsFor = function(model) {
    const graph = sourceGraph(model, null);
    const display = (n) => graph.names.get(n);
    const cycles = findCycles(graph, 5000);
    const questions = [];
    for (const cycle of cycles) {
        questions.push({
            text: `Is the feedback loop ${[...cycle.nodes, cycle.nodes[0]].map((n) => `"${display(n)}"`).join(' -> ')} reinforcing or balancing?`,
            options: ['reinforcing', 'balancing'],
            answer: cycle.polarity === '+' ? 'reinforcing' : 'balancing'
        });
    }
    // Pairs, at least two links apart, where every causal path agrees on its sign.
    const names = [...graph.names.keys()].sort();
    const pairs = [];
    for (const from of names) {
        for (const to of names) {
            if (from === to || graph.edges.get(from)?.has(to)) continue;
            // No path back from the effect to the cause: under feedback, "does it rise or fall?"
            // has an answer that changes over time, so such pairs are not asked about.
            if (pathPolarities(graph, to, from, new Set()).size > 0) continue;
            const paths = pathPolarities(graph, from, to, new Set());
            if (paths.size === 1 && !paths.has('?')) pairs.push({ from, to, sign: [...paths][0] });
        }
    }
    const step = Math.max(1, Math.floor(pairs.length / EFFECT_QUESTIONS));
    for (let i = 0; i < pairs.length && questions.filter((q) => q.kind === 'effect').length < EFFECT_QUESTIONS; i += step) {
        const { from, to, sign } = pairs[i];
        questions.push({
            kind: 'effect',
            text: `If "${display(from)}" increases, with nothing else changing, does "${display(to)}" increase or decrease as a result?`,
            options: ['increases', 'decreases'],
            answer: sign === '+' ? 'increases' : 'decreases'
        });
    }
    const loopsThrough = (n) => cycles.filter((c) => c.nodes.includes(n)).length;
    const hub = names.reduce((best, n) => (loopsThrough(n) > loopsThrough(best) ? n : best), names[0]);
    questions.push({
        text: `How many distinct feedback loops pass through "${display(hub)}"?`,
        options: ['0', '1', '2', '3', '4', '5', '6 or more'],
        answer: loopsThrough(hub) >= 6 ? '6 or more' : String(loopsThrough(hub))
    });
    return questions.map(({ text, options, answer }) => ({ text, options, answer }));
};

const promptFor = (questions) => `Here is my causal loop diagram. Please answer these questions about it from the links in the diagram only — not from what you know about the subject — each on its own line, numbered:

${questions.map((q, i) => `${i + 1}. ${q.text}`).join('\n')}`;

const generateTests = function(key) {
    const fixture = readFixture(key);
    const questions = questionsFor(fixture.model);
    const base = {
        prompt: promptFor(questions),
        currentModel: fixture.model,
        additionalParameters: { mode: 'cld-discuss', problemStatement: 'I want to make sure I understand what my causal loop diagram says.' }
    };
    return questions.map((q, i) => ({
        ...base,
        name: `${key}: ${q.text}`,
        expectations: { fixture: key, number: i + 1, questions: questions.map((x) => ({ text: x.text, options: x.options })), answer: q.answer }
    }));
};

/** How many effect questions of each sign a hard diagram is asked. */
export const HARD_EFFECTS_PER_SIGN = 2;

/**
 * The hard group's questions for one diagram, balanced so that a constant answer is wrong about half
 * the time: as many reinforcing loops as balancing ones (the smaller count of each, in the
 * diagram's cycle order), as many effects that increase as decrease (HARD_EFFECTS_PER_SIGN of each,
 * evenly spaced among the qualifying pairs of that sign), and — for every variable two or more loops
 * pass through, the busiest first — two dependent answers from one analysis: how many loops pass
 * through it and how many of those are reinforcing. Keys are computed from the graph exactly as
 * questionsFor does.
 * @param {Object} model The CLD
 * @returns {Array<{text: string, options: Array<string>, answer: string}>} Questions
 */
export const hardQuestionsFor = function(model) {
    const graph = sourceGraph(model, null);
    const display = (n) => graph.names.get(n);
    const cycles = findCycles(graph, 5000);
    const loopQuestion = (cycle) => ({
        text: `Is the feedback loop ${[...cycle.nodes, cycle.nodes[0]].map((n) => `"${display(n)}"`).join(' -> ')} reinforcing or balancing?`,
        options: ['reinforcing', 'balancing'],
        answer: cycle.polarity === '+' ? 'reinforcing' : 'balancing'
    });
    const reinforcing = cycles.filter((c) => c.polarity === '+');
    const balancing = cycles.filter((c) => c.polarity === '-');
    const nLoops = Math.min(reinforcing.length, balancing.length);
    const loops = cycles.filter((c) => (c.polarity === '+' ? reinforcing : balancing).indexOf(c) < nLoops).map(loopQuestion);
    const names = [...graph.names.keys()].sort();
    const pairs = [];
    for (const from of names) {
        for (const to of names) {
            if (from === to || graph.edges.get(from)?.has(to)) continue;
            if (pathPolarities(graph, to, from, new Set()).size > 0) continue;
            const paths = pathPolarities(graph, from, to, new Set());
            if (paths.size === 1 && !paths.has('?')) pairs.push({ from, to, sign: [...paths][0] });
        }
    }
    const evenly = (list, n) => list.length <= n ? list : Array.from({ length: n }, (_, i) => list[Math.floor((i * list.length) / n)]);
    const nEffects = Math.min(HARD_EFFECTS_PER_SIGN, pairs.filter((p) => p.sign === '+').length, pairs.filter((p) => p.sign === '-').length);
    const effects = [...evenly(pairs.filter((p) => p.sign === '+'), nEffects), ...evenly(pairs.filter((p) => p.sign === '-'), nEffects)]
        .sort((a, b) => pairs.indexOf(a) - pairs.indexOf(b))
        .map(({ from, to, sign }) => ({
            text: `If "${display(from)}" increases, with nothing else changing, does "${display(to)}" increase or decrease as a result?`,
            options: ['increases', 'decreases'],
            answer: sign === '+' ? 'increases' : 'decreases'
        }));
    const loopsThrough = (n) => cycles.filter((c) => c.nodes.includes(n)).length;
    const hub = names.reduce((best, n) => (loopsThrough(n) > loopsThrough(best) ? n : best), names[0]);
    const COUNTS = ['0', '1', '2', '3', '4', '5', '6 or more'];
    const asOption = (k) => (k >= 6 ? '6 or more' : String(k));
    // Two dependent answers from one analysis, for every variable two or more loops pass through
    // (the busiest first, then by loop count and name): how many loops pass through it, and how
    // many of those are reinforcing — found only by listing its loops and reading each one's sign.
    const shared = names.filter((n) => loopsThrough(n) >= 2)
        .sort((a, b) => (a === hub ? -1 : b === hub ? 1 : loopsThrough(b) - loopsThrough(a) || a.localeCompare(b)));
    const counts = (shared.length ? shared : [hub]).flatMap((n) => [
        { text: `How many distinct feedback loops pass through "${display(n)}"?`, options: COUNTS, answer: asOption(loopsThrough(n)) },
        { text: `Of the feedback loops that pass through "${display(n)}", how many are reinforcing?`, options: COUNTS, answer: asOption(cycles.filter((c) => c.nodes.includes(n) && c.polarity === '+').length) }
    ]);
    return [...loops, ...effects, ...counts];
};

/** The hard prompt: the questions alone, with no instruction on how to read the diagram. */
const hardPromptFor = (questions) => `Here is my causal loop diagram. I'd like to check I understand it:

${questions.map((q, i) => `${i + 1}. ${q.text}`).join('\n')}`;

const generateHardTest = function(key) {
    const fixture = readFixture(key);
    const questions = hardQuestionsFor(fixture.model);
    return {
        prompt: hardPromptFor(questions),
        currentModel: fixture.model,
        additionalParameters: { mode: 'cld-discuss', problemStatement: 'I want to make sure I understand what my causal loop diagram says.' },
        name: `${key}: (hard) every one of ${questions.length} questions answered right`,
        expectations: { fixture: key, criterion: 'all', questions: questions.map((x) => ({ text: x.text, options: x.options })), answers: questions.map((x) => x.answer) }
    };
};

const rawGroups = {
    gibberishCLDs: FIXTURES.filter((k) => GIBBERISH_CLDS.includes(k)).flatMap(generateTests),
    realDomainCLDs: FIXTURES.filter((k) => !GIBBERISH_CLDS.includes(k)).flatMap(generateTests),
    gibberishCLDsHard: HARD_CLDS.map(generateHardTest)
};


/** The groups, each split into its dev tests and its held-out ones (`<group>HeldOut`); see utilities/heldOut.js. */
export const groups = splitHeldOut(rawGroups, (t) => HELD_OUT_CLDS.includes(t.expectations.fixture) || HELD_OUT_HARD_CLDS.includes(t.expectations.fixture));
/**
 * The judge's reading, built per diagram: one field per question, restricted to that question's
 * options (plus 'unclear'), so the judge picks an option rather than copying the agent's wording.
 * @param {Array<{text: string, options: Array<string>}>} questions The questions
 * @returns {import('zod').ZodType} The schema
 */
export const readingSchemaFor = function(questions) {
    return z.object(Object.fromEntries(questions.map((q, i) => [
        `q${i + 1}`,
        z.enum([...q.options, 'unclear']).describe(`Question ${i + 1}: ${q.text} Which option did the answer give (in any wording: "increase" means "increases")? 'unclear' only if it gave none or several.`)
    ])));
};

const readingMessages = (text, questions) => [
    { role: 'system', content: 'You read answers to numbered questions about a diagram and report, for each question, which of its listed options the answer chose, whatever words it used. Report only what the answer says; do not work anything out yourself.' },
    { role: 'user', content: `Questions and their options:\n${questions.map((q, i) => `${i + 1}. ${q.text} Options: ${q.options.join(' / ')}`).join('\n')}\n\nAnswers:\n"""\n${text}\n"""` }
];

/**
 * Evaluates one question.
 * @param {Object} generatedResponse The engine's response
 * @param {Object} expectations The question and its key
 * @returns {Promise<Array<Object>>} Failures
 */
export const evaluate = async function(generatedResponse, expectations) {
    const text = generatedResponse?.output?.textContent || generatedResponse?.supportingInfo?.explanation || '';
    if (!text.trim()) return validateEvaluationResult([{ type: 'No response produced', details: `The engine returned no answers.${generatedResponse?.err ? ` Engine error: ${generatedResponse.err}` : ''}` }]);
    let reading;
    try {
        reading = await extract(`cldInterpretation|${expectations.fixture}|${text}`, readingMessages(text, expectations.questions), readingSchemaFor(expectations.questions));
    } catch (error) {
        return validateEvaluationResult([{ type: 'Evaluation error', details: `Error reading the answers: ${error.message}` }]);
    }
    const failures = [];
    if (expectations.criterion === 'all') {
        // The hard group: every question of the diagram, graded together.
        expectations.answers.forEach((answer, i) => {
            const said = reading[`q${i + 1}`] ?? 'unclear';
            if (String(said).trim().toLowerCase() !== answer) failures.push({ type: 'Diagram misread', details: `Question ${i + 1} ("${expectations.questions[i].text}"): the answer was "${said}"; the diagram says "${answer}".` });
        });
        return validateEvaluationResult(failures);
    }
    const said = reading[`q${expectations.number}`] ?? 'unclear';
    if (String(said).trim().toLowerCase() !== expectations.answer) {
        failures.push({ type: 'Diagram misread', details: `Question ${expectations.number} ("${expectations.questions[expectations.number - 1].text}"): the answer was "${said}"; the diagram says "${expectations.answer}".` });
    }
    return validateEvaluationResult(failures);
};

export const methodology = () => withFloors('cldInterpretation', {
    howItWorks: [
        `Each test hands the agent an existing causal loop diagram as its current model and a numbered list of questions about it. The diagrams are the ones the model-to-CLD category uses: twenty generated from a seed with invented variable names, so only the diagram can answer (seventeen of them held out: written after this grader was frozen and never used to tune it), and two real-domain diagrams.`,
        `Every answer is computed from the diagram's graph. A loop's polarity is the product of its link signs. An effect question is asked only for a pair of variables at least two links apart where every causal path between them has the same sign and no path leads back from the second to the first (under feedback the answer would change over time). The loop count for the variable with the most loops through it counts its simple cycles.`,
        `The agent is told to answer from the diagram's links only, not from what it knows about the subject: the real-domain diagrams leave out links that common sense would add, and the keys are what the diagram says.`,
        `Hard group (gibberishCLDsHard): the five bigger generated diagrams of six loops each (two dev, three held out), with no instruction on how to read them, and one test per diagram that needs every question right at once: as many reinforcing loops as balancing ones, two effects that increase and two that decrease, and — the lever added last — two dependent answers from one analysis for every variable two or more loops pass through (each hub of the flower): how many loops pass through it, and how many of those are reinforcing, which takes listing its loops and reading each one's sign. Any constant answer fails.`,
        `A fixed judge model reads the answers and reports, for each question, which of its listed options the answer chose — its structured output allows only those options — and is never shown the keys.`
    ],
    criteria: [
        { name: 'Diagram misread', description: 'The answer to a question differs from what the diagram says, or the agent gave none.' },
        { name: 'No response produced', description: 'The engine returned no answers.' },
        { name: 'Evaluation error', description: 'The judge call failed; recorded as a failure so a broken judge never reads as a good answer.' }
    ],
    scoring: `One question per test, all graded from one set of answers per diagram; in the hard group, one test per diagram with all its questions graded together.`
});
