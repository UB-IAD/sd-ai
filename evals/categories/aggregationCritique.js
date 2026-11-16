/**
 * This is the aggregation critique test
 *
 * Every model lumps things together — all patients in one waiting list, all products in one
 * inventory — and whether that is good enough depends on the question the model is for. Groups
 * that differ can be averaged away for one question and not for another: two regions with very
 * different demand change how high a pooled waiting list peaks, but not where it ends up. This
 * category gives the agent an aggregate model, a difference between groups that it averages away,
 * and the question the model is for, and asks whether the model must be split into the groups.
 *
 * The key comes from simulation: the model split into the groups, with their own values, against
 * the aggregate. Grading, one test per case: a judge reads the agent's answer and reports, from
 * closed options, whether it says to split or to keep the aggregate; it must match the key.
 *
 * @module categories/aggregationCritique
 */

import { z } from 'zod';
import { validateEvaluationResult } from '../evaluationSchema.js';
import { extract } from '../utilities/judge.js';
import { MATTERS_CHANGE, IRRELEVANT_CHANGE } from '../utilities/scenarios/scenarioKit.js';
import { glossaryModel } from '../utilities/scenarios/renameModel.js';
import { simulateModel } from '../utilities/simulateModel.js';
import { scenarios } from '../utilities/scenarios/library.js';
import { cases, generatedCases } from './aggregationCritiqueData/cases.js';
import { withFloors } from '../floors/statement.js';
import { SHARE_LEVELS } from './aggregationCritiqueData/generate.js';
import { splitHeldOut, caseHeldOut, isHeldOutScenario } from '../utilities/heldOut.js';
import { handCases } from './aggregationCritiqueData/cases.js';
import { STRONG, MILD } from './aggregationCritiqueData/hard.js';
import { hard2CaseFor as hard2RuleCase, directionOf } from './aggregationCritiqueData/hard2.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const description = () => {
    return `The aggregation critique test evaluates whether an agent can tell when a model's aggregation is good enough for the question it is for: given an aggregate model, a difference between groups that it averages away, and the question, the agent must say whether the model needs splitting into the groups. The key comes from simulating the split model against the aggregate.`;
};

/**
 * The key: how far splitting moves the answer to the case's question, and the verdict that follows.
 * @returns {Promise<{aggregate: number, split: number, change: number, verdict: 'split'|'aggregate'|'ambiguous'}>}
 */
export const keyFor = async function(c) {
    const a = await simulateModel(c.aggregate, [c.stock], null);
    const s = await simulateModel(c.split, [`${c.stock} total`], null);
    if (!a.ok || !s.ok) throw new Error(`A key run failed: ${a.error || s.error}`);
    const aggregate = c.measure(a.series[c.stock], a.time);
    const split = c.measure(s.series[`${c.stock} total`], s.time);
    const change = Math.abs(split - aggregate) / Math.abs(aggregate);
    return { aggregate, split, change, verdict: change >= MATTERS_CHANGE ? 'split' : change <= IRRELEVANT_CHANGE ? 'aggregate' : 'ambiguous' };
};

/**
 * The verdict each case is graded against, written here so tests can be generated without
 * simulating, and re-derived from simulation in the unit tests.
 */
const HAND_VERDICTS = {
    'Bike share, chatty and quiet neighbourhoods': 'split',
    'Bike share, two neighbourhoods alike': 'aggregate',
    'Dialysis regions, peak': 'split',
    'Dialysis regions, long run': 'aggregate',
    'Distributor lines, overshoot': 'split',
    'Distributor lines, settled level': 'aggregate',
    'Food bank branches, volunteers at the end': 'split',
    'Food bank branches, volunteer peak': 'aggregate',
    'Delivery depots, breakdown peak': 'split',
    'Delivery depots, fleet size': 'aggregate'
};
export const VERDICTS = { ...HAND_VERDICTS, ...Object.fromEntries(Object.entries(generatedCases).map(([n, c]) => [n, c.verdict])) };

/**
 * The cases grouped into tests: cases about the same split (same scenario, same description of the
 * groups) are asked together, in one conversation, and the test passes only if every answer is
 * right — so answering "split" (or "good enough") to everything scores nothing where a split's two
 * questions have different answers. Cases about different splits stay separate tests.
 */
export const testCases = function() {
    const byKey = new Map();
    for (const name of Object.keys(cases)) {
        const key = `${cases[name].scenario}|${cases[name].heterogeneity}`;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(name);
    }
    return [...byKey.values()];
};

const prompt = (names) => {
    const c = cases[names[0]];
    const s = scenarios[c.scenario];
    const questions = names.map((n, i) => `${names.length > 1 ? `${i + 1}. ` : ''}${cases[n].question}`).join('\n');
    return `Here is my model of the ${s.title.toLowerCase()}. It treats everything as one group. In reality: ${c.heterogeneity}\n\nWhat I need the model for is ${names.length > 1 ? `each of these:\n${questions}\n\nFor each one` : `${cases[names[0]].question}.`} Does the model need to be split into ${c.groups} to answer ${names.length > 1 ? 'it' : 'that'}, or is the single aggregate good enough for it? Please say which and explain why. Please don't change the model.`;
};

const generateTests = (names) => [{
    prompt: prompt(names),
    currentModel: glossaryModel(scenarios[cases[names[0]].scenario]),
    additionalParameters: { mode: 'sfd', problemStatement: `I want to know whether my model is detailed enough for what I need it for.` },
    name: names.length > 1 ? `${names.join(' + ')}: gets every question's aggregation level right` : `${names[0]}: ${VERDICTS[names[0]] === 'split' ? 'says the model needs splitting' : 'says the aggregate is good enough'}`,
    expectations: { caseNames: names }
}];

/**
 * The hard group's cases, one per scenario: a scenario with hand-written cases is asked about all of
 * them together; every other scenario gets the case the general rule in aggregationCritiqueData/hard.js
 * gives it (frozen in hardCases.json): both measures under a lopsided and a near-even division. Every
 * case has answers of both kinds.
 */
export const HARD_RULE_CASES = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'aggregationCritiqueData', 'hardCases.json'), 'utf8'));

const LETTERS = 'abcdefgh';

/** The hard case of a scenario with hand-written cases: every one of them, asked together. */
export const handHardCase = function(scenario) {
    const names = Object.keys(handCases).filter((n) => handCases[n].scenario === scenario);
    const accounts = [...new Set(names.map((n) => handCases[n].heterogeneity))];
    const which = (n) => (accounts.length > 1 ? `, if (${LETTERS[accounts.indexOf(handCases[n].heterogeneity)]}) is true` : '');
    const context = accounts.length > 1
        ? `We are not sure which of these is true:\n${accounts.map((a, i) => `(${LETTERS[i]}) ${a}`).join('\n')}`
        : accounts[0];
    return { scenario, context, questions: names.map((n) => ({ id: n, text: `${handCases[n].question}${which(n)}`, verdict: VERDICTS[n] })) };
};

export const hardCases = function() {
    const handScenarios = [...new Set(Object.values(handCases).map((c) => c.scenario))];
    return [...handScenarios.map(handHardCase), ...Object.values(HARD_RULE_CASES).filter((c) => scenarios[c.scenario])];
};

/**
 * The hard prompt does not name the choice (split into the groups, or keep the aggregate): the
 * manager says how the groups really differ, lists what the model is for, and asks whether the model
 * can be relied on as it stands.
 */
export const hardPrompt = (c) => `Here is my model of the ${scenarios[c.scenario].title.toLowerCase()}. ${c.context}\n\nThese are the things I need the model to tell me:\n${c.questions.map((q, i) => `${i + 1}. ${q.text}`).join('\n')}\n\nCan I rely on the model as it stands for each of them? Please don't change the model.`;

const generateHardTest = (c) => ({
    prompt: hardPrompt(c),
    currentModel: glossaryModel(scenarios[c.scenario]),
    additionalParameters: { mode: 'sfd', problemStatement: `I want to know whether my model is detailed enough for what I need it for.` },
    name: `${scenarios[c.scenario].title}: (hard) every one of ${c.questions.length} questions' aggregation level right`,
    expectations: { criterion: 'hard', scenario: c.scenario, questions: c.questions.map((q) => ({ id: q.id, text: q.text })), verdicts: c.questions.map((q) => q.verdict) }
});

/**
 * The second hard group's case for a held-out scenario, by the rule in aggregationCritiqueData/hard2.js:
 * a scenario with hand-written cases gets the first hard group's questions about them, each split
 * question with its direction from the hand-written split; every other one, questions on its goal
 * variable or stocks, split and aggregate in equal numbers, with both directions wherever it has them.
 * @param {string} id A scenario id
 * @returns {Promise<Object|null>}
 */
export const hard2CaseFor = async function(id) {
    if (!isHeldOutScenario(id)) return null;
    if (!Object.values(handCases).some((x) => x.scenario === id)) return hard2RuleCase(scenarios[id]);
    const c = handHardCase(id);
    const questions = [];
    for (const q of c.questions) {
        const key = q.verdict === 'split' ? await keyFor(handCases[q.id]) : null;
        questions.push({ id: q.id, text: q.text, verdict: q.verdict, direction: key ? directionOf(key.aggregate, key.split) : null });
    }
    return { scenario: id, context: c.context, questions };
};

/** The second hard group's cases, frozen in hard2Cases.json by aggregationCritiqueData/buildHard2.js. */
export const HARD2_CASES = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'aggregationCritiqueData', 'hard2Cases.json'), 'utf8'));

/** The second hard prompt: the first hard prompt's request, and which way the model errs where it cannot be relied on. */
export const hard2Prompt = (c) => `Here is my model of the ${scenarios[c.scenario].title.toLowerCase()}. ${c.context}\n\nThese are the things I need the model to tell me:\n${c.questions.map((q, i) => `${i + 1}. ${q.text}`).join('\n')}\n\nCan I rely on the model as it stands for each of them? Where I can't, would the model as it stands put the number too high or too low? Please don't change the model.`;

const generateHard2Test = (c) => ({
    prompt: hard2Prompt(c),
    currentModel: glossaryModel(scenarios[c.scenario]),
    additionalParameters: { mode: 'sfd', problemStatement: `I want to know whether my model is detailed enough for what I need it for.` },
    name: `${scenarios[c.scenario].title}: (hard 2) every one of ${c.questions.length} questions' aggregation level right, and which way the model errs where it cannot be relied on`,
    expectations: { criterion: 'hard2', scenario: c.scenario, questions: c.questions.map((q) => ({ id: q.id, text: q.text })), verdicts: c.questions.map((q) => q.verdict), directions: c.questions.map((q) => q.direction) }
});

const rawGroups = {
    aggregationCritique: testCases().flatMap(generateTests),
    aggregationCritiqueHard: hardCases().map(generateHardTest),
    aggregationCritiqueHard2: Object.values(HARD2_CASES).filter((c) => scenarios[c.scenario] && isHeldOutScenario(c.scenario)).map(generateHard2Test)
};


/** The groups, each split into its dev tests and its held-out ones (`<group>HeldOut`); see utilities/heldOut.js. */
export const groups = splitHeldOut(rawGroups, (t) => (t.expectations.criterion === 'hard' || t.expectations.criterion === 'hard2' ? isHeldOutScenario(t.expectations.scenario) : t.expectations.caseNames.some((n) => caseHeldOut(cases[n]))));
const SAYS = { split: 'split into the groups', aggregate: 'the aggregate is good enough' };

const verdictSchemaFor = (names) => z.object(Object.fromEntries(names.map((n, i) => [
    `q${i + 1}`,
    z.enum([SAYS.split, SAYS.aggregate, 'unclear']).describe(`What the answer concludes for question ${i + 1} (${cases[n].question}). 'unclear' if it does not decide or says both.`)
])));

/**
 * Evaluates one test: every case in it must get the right verdict.
 * @param {Object} generatedResponse The engine's response
 * @param {Object} expectations The cases
 * @returns {Promise<Array<Object>>} Failures
 */
export const evaluate = async function(generatedResponse, expectations) {
    if (expectations.criterion === 'hard') return evaluateHard(generatedResponse, expectations);
    if (expectations.criterion === 'hard2') return evaluateHard2(generatedResponse, expectations);
    const names = expectations.caseNames;
    const text = generatedResponse?.supportingInfo?.explanation || generatedResponse?.output?.textContent || '';
    if (!text.trim()) return validateEvaluationResult([{ type: 'No answer given', details: `The engine gave no answer.${generatedResponse?.err ? ` Engine error: ${generatedResponse.err}` : ''}` }]);
    let reading;
    try {
        reading = await extract(`aggregationCritique|${names.join('+')}|${text}`, [
            { role: 'system', content: 'You read an answer about whether a model needs to be split into groups to answer each of some questions, and report what it concludes for each. Report only what the answer says; do not decide yourself.' },
            { role: 'user', content: `The questions the model is for:\n${names.map((n, i) => `${i + 1}. ${cases[n].question}`).join('\n')}\n\nThe answer:\n"""\n${text}\n"""` }
        ], verdictSchemaFor(names));
    } catch (error) {
        return validateEvaluationResult([{ type: 'Evaluation error', details: `Error reading the answer: ${error.message}` }]);
    }
    const failures = [];
    names.forEach((n, i) => {
        const right = VERDICTS[n];
        const said = reading[`q${i + 1}`];
        if (said !== SAYS[right]) failures.push({ type: 'Wrong aggregation level', details: `For ${cases[n].question}, the answer concludes "${said}"; ${right === 'split' ? 'splitting into the groups changes the answer by more than a quarter' : 'splitting into the groups changes the answer by under a tenth'}.` });
    });
    return validateEvaluationResult(failures);
};

const hardSchemaFor = (questions) => z.object(Object.fromEntries(questions.map((q, i) => [
    `q${i + 1}`,
    z.enum([SAYS.split, SAYS.aggregate, 'unclear']).describe(`What the answer concludes for question ${i + 1} (${q.text}): '${SAYS.split}' if it says the model as it stands cannot be relied on for it and the parts need modelling separately; '${SAYS.aggregate}' if it says the model as it stands is good enough for it; 'unclear' if it does not decide or says both.`)
])));

/** The hard group: every question of the scenario, graded together. */
const evaluateHard = async function(generatedResponse, expectations) {
    const { questions, verdicts } = expectations;
    const text = generatedResponse?.supportingInfo?.explanation || generatedResponse?.output?.textContent || '';
    if (!text.trim()) return validateEvaluationResult([{ type: 'No answer given', details: `The engine gave no answer.${generatedResponse?.err ? ` Engine error: ${generatedResponse.err}` : ''}` }]);
    let reading;
    try {
        reading = await extract(`aggregationCritique|${questions.map((q) => q.id).join('+')}|hard|${text}`, [
            { role: 'system', content: 'You read an answer about whether a model that lumps two groups together can be relied on for each of some questions, or needs the groups modelled separately, and report what it concludes for each. Report only what the answer says; do not decide yourself.' },
            { role: 'user', content: `The questions the model is for:\n${questions.map((q, i) => `${i + 1}. ${q.text}`).join('\n')}\n\nThe answer:\n"""\n${text}\n"""` }
        ], hardSchemaFor(questions));
    } catch (error) {
        return validateEvaluationResult([{ type: 'Evaluation error', details: `Error reading the answer: ${error.message}` }]);
    }
    const failures = [];
    questions.forEach((q, i) => {
        const said = reading[`q${i + 1}`];
        if (said !== SAYS[verdicts[i]]) failures.push({ type: 'Wrong aggregation level', details: `For ${q.text}, the answer concludes "${said}"; ${verdicts[i] === 'split' ? 'splitting into the groups changes the answer by more than a quarter' : 'splitting into the groups barely changes the answer'}.` });
    });
    return validateEvaluationResult(failures);
};

/** The second hard group's closed reading of which way the model errs, asked of each question apart from its verdict. */
export const DIRECTIONS = { high: 'too high', low: 'too low', none: 'not said' };

const hard2SchemaFor = (questions) => z.object(Object.fromEntries(questions.flatMap((q, i) => [
    [`q${i + 1}`, z.enum([SAYS.split, SAYS.aggregate, 'unclear']).describe(`What the answer concludes for question ${i + 1} (${q.text}): '${SAYS.split}' if it says the model as it stands cannot be relied on for it and the parts need modelling separately; '${SAYS.aggregate}' if it says the model as it stands is good enough for it; 'unclear' if it does not decide or says both.`)],
    [`d${i + 1}`, z.enum([DIRECTIONS.high, DIRECTIONS.low, DIRECTIONS.none]).describe(`For question ${i + 1}: whether the answer says the model as it stands gives too high or too low a number for it; '${DIRECTIONS.none}' if it says neither, or says both.`)]
])));

/** The second hard group: every question's verdict, and for each that needs the split, which way the model errs. */
const evaluateHard2 = async function(generatedResponse, expectations) {
    const { questions, verdicts, directions } = expectations;
    const text = generatedResponse?.supportingInfo?.explanation || generatedResponse?.output?.textContent || '';
    if (!text.trim()) return validateEvaluationResult([{ type: 'No answer given', details: `The engine gave no answer.${generatedResponse?.err ? ` Engine error: ${generatedResponse.err}` : ''}` }]);
    let reading;
    try {
        reading = await extract(`aggregationCritique|${questions.map((q) => q.id).join('+')}|hard2|${text}`, [
            { role: 'system', content: 'You read an answer about whether a model that lumps two groups together can be relied on for each of some questions, and, where it cannot, whether the model as it stands gives too high or too low a number; report what it concludes for each. Report only what the answer says; do not decide yourself.' },
            { role: 'user', content: `The questions the model is for:\n${questions.map((q, i) => `${i + 1}. ${q.text}`).join('\n')}\n\nThe answer:\n"""\n${text}\n"""` }
        ], hard2SchemaFor(questions));
    } catch (error) {
        return validateEvaluationResult([{ type: 'Evaluation error', details: `Error reading the answer: ${error.message}` }]);
    }
    const failures = [];
    questions.forEach((q, i) => {
        const said = reading[`q${i + 1}`];
        const way = reading[`d${i + 1}`];
        if (said !== SAYS[verdicts[i]]) {
            failures.push({ type: 'Wrong aggregation level', details: `For ${q.text}, the answer concludes "${said}"; ${verdicts[i] === 'split' ? 'splitting into the groups changes the answer by more than a quarter' : 'splitting into the groups barely changes the answer'}.` });
        } else if (verdicts[i] === 'split' && way !== DIRECTIONS[directions[i]]) {
            failures.push({ type: 'Wrong direction', details: `For ${q.text}, the answer says the model as it stands gives a number that is "${way}"; with the groups modelled separately the number is ${directions[i] === 'high' ? 'lower' : 'higher'}, so the model puts it too ${directions[i]}.` });
        }
    });
    return validateEvaluationResult(failures);
};

export const methodology = () => withFloors('aggregationCritique', {
    howItWorks: [
        `Each case is a hidden scenario's aggregate model, a difference between groups it averages away — two neighbourhoods whose riders talk about the scheme at different rates, two regions with very different demand whose patients cannot travel, two product lines with fast and slow suppliers — and the question the model is for. The groups' values average to the aggregate's.`,
        `The key comes from simulation: the model copied per group, with the groups' own values, against the aggregate. Splitting is needed when it moves the answer to the question by at least ${100 * MATTERS_CHANGE}%; the aggregate is good enough when it moves it by at most ${100 * IRRELEVANT_CHANGE}% (checked in the unit tests). The same split appears with two questions (how high the regions' waiting list peaks, and where it ends up), and two splits with the same question (neighbourhoods that differ in how much they talk, and ones that differ only in size), so the answer depends on what the model is for and which difference it is.`,
        `Questions about the same split are asked together in one conversation and scored as one test, passing only if every answer is right, so answering the same way to everything scores nothing where the two have different answers. A fixed judge model reads each answer from closed options — split, or keep the aggregate — and it must match the key.`,
        `Besides the hand-written cases, every scenario in the shared scenario library whose goal is an amount gets cases by a general rule (aggregationCritiqueData/generate.js): its input divided between two independent parts, North and South at ${SHARE_LEVELS.map((x) => x.map((y) => 100 * y).join('/')).join(' and at ')} with the amounts found by forward selection so that an even division reproduces the aggregate exactly; a question is kept only if its verdict is clear both against the run's scale and as the plain relative change, and its measure does not end near zero.`,
        `Hard group (aggregationCritiqueHard): one test per scenario with every question it has answers for, asked together and all of which must be right — a scenario with hand-written cases gets all of them (accounts of the groups that differ offered as alternatives), every other scenario the general rule's questions on both measures under a lopsided (${STRONG.map((x) => 100 * x).join('/')}) and a near-even (${MILD.map((x) => 100 * x).join('/')}) division, kept only when they have answers of both kinds — and a prompt that does not name the choice, asking only whether the model can be relied on as it stands for each.`,
        `Second hard group (aggregationCritiqueHard2, held-out scenarios only; the lever: a second answer that depends on the first): where the model cannot be relied on, the agent must also say which way it errs — whether the model as it stands puts the number too high or too low, from the same simulation as the verdict (the aggregate's answer above or below the split model's, by at least ${100 * MATTERS_CHANGE}%). By rule (aggregationCritiqueData/hard2.js), a held-out scenario the generated cases can split is split as in the first hard group (${STRONG.map((x) => 100 * x).join('/')} or ${MILD.map((x) => 100 * x).join('/')}) and asked about any stock the even split reproduces — how high it peaks, where it ends — taking the first split question of each direction there is and as many aggregate questions as split ones, so every case has both verdicts and, wherever the scenario allows, both directions. One test per scenario: every verdict, and every direction, must be right; the judge reads, for each question, the verdict (split, good enough, unclear) and the direction (too high, too low, not said) as separate closed fields.`
    ],
    criteria: [
        { name: 'Wrong aggregation level', description: 'The answer says to split when the aggregate is good enough for the question, says the aggregate is good enough when splitting changes the answer, or does not decide.' },
        { name: 'Wrong direction', description: 'Second hard group: the answer rightly says the model cannot be relied on for a question, but says it puts the number too high when it puts it too low, the other way round, or neither.' },
        { name: 'No answer given', description: 'The engine gave no answer.' },
        { name: 'Evaluation error', description: 'The judge call failed; recorded as a failure so a broken judge never reads as a good answer.' }
    ],
    scoring: `One test per split: its questions asked together in one generation, all of which must be right. The hard group has one test per scenario, every question graded together; the second hard group likewise, with every direction too.`
});
