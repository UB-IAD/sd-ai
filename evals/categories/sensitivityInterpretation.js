/**
 * This is the sensitivity interpretation test
 *
 * A sensitivity analysis is only useful if someone reads it correctly: which parameters the
 * behavior depends on, which change its shape rather than just its size, and which way each one
 * pushes the outcome. This category hands the engine a model together with the results of a
 * one-at-a-time sensitivity sweep run on it, and asks it to interpret them.
 *
 * The sweeps are run through PySD offline (sensitivityInterpretationData/buildCases.js) on the
 * feedbackExplanation fixture models, and the answer key is computed from the same runs with fixed
 * rules. Only questions with a clear answer are asked: a direction question needs the measure to
 * move monotonically and by a clear margin, and a "most/least influential" question needs the
 * leader to win by a wide margin.
 *
 * A judge reads the engine's interpretation and reports, from closed options, only what the engine
 * concluded for each parameter; this category's code compares that with the key. One question per
 * test; sibling tests share one generation and one judge reading.
 *
 * @module categories/sensitivityInterpretation
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { validateEvaluationResult } from '../evaluationSchema.js';
import { extract } from '../utilities/judge.js';
import { foldName } from '../utilities/modelDiff.js';
import { NO_EFFECT, CLEAR_EFFECT, RANKING_MARGIN } from './sensitivityInterpretationData/buildCases.js';
import { withFloors } from '../floors/statement.js';
import { scenarios } from '../utilities/scenarios/library.js';
import { scenarioModel, SCENARIO_PARAMETERS, SCENARIO_RANGE, HARD_PARAMETERS, MIN_HARD_PAIRS, pairQuestions } from './sensitivityInterpretationData/buildCases.js';
import { splitHeldOut, caseHeldOut, laterBatch } from '../utilities/heldOut.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'sensitivityInterpretationData', 'cases.json'), 'utf8'));
const readModel = (fixture) => JSON.parse(fs.readFileSync(path.join(__dirname, 'feedbackExplanationData', `${fixture}.json`), 'utf8')).model;

export const description = () => {
    return `The sensitivity interpretation test evaluates whether an engine can read the results of a sensitivity analysis correctly. Given a model and the runs of a one-at-a-time parameter sweep, it must say which parameters change the shape of the behavior rather than just its size, which way each parameter moves the outcome, and which parameters matter most and least. Answers are checked against keys computed from the same runs.`;
};

const fmt = (v) => (Math.abs(v) >= 1e5 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(3) : Number(v.toPrecision(4)).toString());

/** The sweep results as the engine sees them: one row per run, the output sampled over time. */
export const renderRuns = function(c) {
    const header = `| run | ${c.runs[0].time.map((t) => `t=${fmt(t)}`).join(' | ')} |`;
    const divider = `|${' --- |'.repeat(c.runs[0].time.length + 1)}`;
    const rows = c.runs.map((run) => {
        const label = run.parameter === null ? 'base (all parameters at base values)' : `${run.parameter} = ${run.value}`;
        return `| ${label} | ${run.values.map(fmt).join(' | ')} |`;
    });
    return [header, divider, ...rows].join('\n');
};

const questionText = function(c, q) {
    switch (q.kind) {
        case 'changesShape': return `Does changing "${q.parameter}" across its range change the shape of ${c.output}'s behavior, or only its size?`;
        case 'direction': return `Does raising "${q.parameter}" increase or decrease ${c.measure.label}?`;
        case 'mostInfluential': return `Which parameter is ${c.measure.label} most sensitive to?`;
        case 'leastInfluential': return `Which parameter is ${c.measure.label} least sensitive to?`;
        default: throw new Error(`Unknown question kind ${q.kind}`);
    }
};

const promptFor = function(c) {
    const params = c.parameters.map((p) => `- "${p.name}": base ${p.base}, tried at ${p.values.join(' and ')}`).join('\n');
    return `I ran a one-at-a-time sensitivity analysis on my model: each parameter below was set to a low and a high value with everything else at base, and the model was re-run. The table shows ${c.output} over time (in ${c.timeUnits}) for every run.

Parameters varied:
${params}

${renderRuns(c)}

By the shape of the behavior I mean the pattern ${c.output} follows over the simulated period shown in the table — for example rising, falling, rising then falling, or oscillating — as opposed to its size.

Please interpret these results for me. For each parameter, tell me whether changing it changes the shape of ${c.output}'s behavior or only its size, and whether raising it increases or decreases ${c.measure.label} (or has no clear effect). Then tell me which parameter ${c.measure.label} is most sensitive to and which it is least sensitive to.`;
};

/**
 * The hard group's prompt: the same runs, but nothing names the method or the questions — no
 * "sensitivity analysis", no "shape or size", no "most or least sensitive". The user asks what the
 * runs say about each assumption, and a good interpretation answers the graded questions unasked.
 */
const hardPromptFor = function(c) {
    const params = c.parameters.map((p) => `- "${p.name}": normally ${p.base}, tried at ${p.values.join(' and ')}`).join('\n');
    return `I re-ran my model a number of times, changing one assumption at a time and leaving the rest as they normally are. The table shows ${c.output} over time (in ${c.timeUnits}) in every run.

Assumptions changed:
${params}

${renderRuns(c)}

What do these runs tell me? I care about ${c.measure.label}, and about how ${c.output} behaves over time. Go through the assumptions and tell me what each one does.`;
};

const generateTests = function(name) {
    const c = cases[name];
    if (c.group.endsWith('Hard')) return generateHardTests(name);
    const base = {
        prompt: promptFor(c),
        currentModel: c.scenario ? scenarioModel(scenarios[c.scenario]) : readModel(c.fixture),
        additionalParameters: {
            problemStatement: `I want to know which assumptions in my model of ${c.output} matter, and how.`
        }
    };
    return c.questions.map((q) => ({
        ...base,
        name: `${name}: ${questionText(c, q)}`,
        expectations: {
            caseName: name,
            output: c.output,
            measureLabel: c.measure.label,
            parameters: c.parameters.map((p) => p.name),
            question: q
        }
    }));
};

/**
 * A hard case's tests: one per pair of questions with different answers (pairQuestions), passing
 * only when both are answered right, so answering every parameter alike scores nothing.
 */
const generateHardTests = function(name) {
    const c = cases[name];
    const base = {
        prompt: hardPromptFor(c),
        currentModel: scenarioModel(scenarios[c.scenario]),
        additionalParameters: { problemStatement: `I want to know what the assumptions in my model of ${c.output} do.` }
    };
    return pairQuestions(c.questions).map((pair) => ({
        ...base,
        name: `${name}: ${pair.map((q) => questionText(c, q)).join(' And: ')}`,
        expectations: { caseName: name, output: c.output, measureLabel: c.measure.label, parameters: c.parameters.map((p) => p.name), questions: pair }
    }));
};

/** Words the hard prompt must not use: they would name the method or the questions. */
export const HARD_PROMPT_WORDS = /sensitiv|shape|size|most|least/i;

/**
 * The cases the groups take: every first-batch one; a later-batch hard case only if its prompt names
 * neither the method nor the questions, as every hard prompt must (the test "hard tests: each pairs
 * two questions with different answers, no method is named, …") — a scenario's own variable name can
 * carry such a word ("most jobs per electrician").
 */
export const TAKEN = Object.keys(cases).filter((n) => !laterBatch(cases[n]) || !cases[n].group.endsWith('Hard') || !HARD_PROMPT_WORDS.test(generateTests(n)[0].prompt));

const rawGroups = TAKEN.reduce((acc, name) => {
    (acc[cases[name].group] = acc[cases[name].group] || []).push(...generateTests(name));
    return acc;
}, {});


/** The groups, each split into its dev tests and its held-out ones (`<group>HeldOut`); see utilities/heldOut.js. */
export const groups = splitHeldOut(rawGroups, (t) => caseHeldOut(cases[t.expectations.caseName]));
/** The judge's structured reading: what the engine concluded, per parameter. */
export const readingSchema = z.object({
    parameters: z.array(z.object({
        parameter: z.string().describe('The parameter name, exactly as listed'),
        changesShape: z.enum(['yes', 'no', 'unclear']).describe("'yes' if the response says changing this parameter changes the shape or pattern of the behavior over the period shown (not just its size); 'no' if it says only the size or level changes; 'unclear' if it does not say or hedges between the two"),
        direction: z.enum(['increases', 'decreases', 'no clear effect', 'unclear']).describe("What the response says raising this parameter does to the named measure: 'increases', 'decreases', 'no clear effect' if it says the effect is negligible or absent, 'unclear' if it does not say or contradicts itself")
    })).describe('One entry for every parameter listed'),
    mostInfluential: z.string().describe("The parameter the response names as the one the measure is most sensitive to, exactly as listed, or 'unclear'"),
    leastInfluential: z.string().describe("The parameter the response names as the one the measure is least sensitive to, exactly as listed, or 'unclear'")
});

const judgeMessages = function(text, expectations) {
    return [
        {
            role: 'system',
            content: `You read a response that interprets the results of a sensitivity analysis and report what the response concluded. Do NOT apply your own judgment about what the results show; report only what the response itself says. If the response does not clearly commit to an answer, report 'unclear'.`
        },
        {
            role: 'user',
            content: `The model output analysed was "${expectations.output}", and the measure discussed was ${expectations.measureLabel}. The parameters varied were:
${expectations.parameters.map((p) => `- ${p}`).join('\n')}

Here is the response:
"""
${text}
"""

For every parameter, report what the response concluded about whether it changes the shape of the behavior and which way raising it moves ${expectations.measureLabel}. Then report which parameter the response says the measure is most and least sensitive to.`
        }
    ];
};

const sameName = (a, b) => foldName(a) === foldName(b);

/**
 * Compare a judge reading with the key for one question.
 * @param {Object} reading The judge's reading of the response
 * @param {Object} expectations The test expectations (the question and its answer)
 * @returns {Array<Object>} Failures
 */
export const gradeReading = function(reading, expectations) {
    // A hard test asks several questions together; it fails on any one of them.
    if (expectations.questions) return expectations.questions.flatMap((question) => gradeReading(reading, { ...expectations, questions: undefined, question }));
    const q = expectations.question;
    const failures = [];
    const entry = (reading.parameters || []).find((p) => sameName(p.parameter, q.parameter));
    switch (q.kind) {
        case 'changesShape': {
            const said = entry?.changesShape ?? 'unclear';
            if (said !== q.answer) {
                failures.push({ type: 'Shape change misread', details: `For "${q.parameter}" the response ${said === 'unclear' ? 'did not say' : `said "${said}"`} whether the shape of ${expectations.output}'s behavior changes; the runs show ${q.answer === 'yes' ? 'it does' : 'it does not — only the size changes'}.` });
            }
            break;
        }
        case 'direction': {
            const said = entry?.direction ?? 'unclear';
            if (said !== q.answer) {
                failures.push({ type: 'Direction of effect misread', details: `For "${q.parameter}" the response ${said === 'unclear' ? 'did not say' : `said raising it ${said === 'no clear effect' ? 'has no clear effect on' : said}`} ${expectations.measureLabel}; the runs show it ${q.answer === 'no clear effect' ? 'has no clear effect' : q.answer}.` });
            }
            break;
        }
        case 'mostInfluential':
        case 'leastInfluential': {
            const said = q.kind === 'mostInfluential' ? reading.mostInfluential : reading.leastInfluential;
            if (!sameName(said, q.answer)) {
                failures.push({ type: 'Influence ranking misread', details: `The response named ${said && !sameName(said, 'unclear') ? `"${said}"` : 'no parameter'} as the one ${expectations.measureLabel} is ${q.kind === 'mostInfluential' ? 'most' : 'least'} sensitive to; the runs show it is "${q.answer}".` });
            }
            break;
        }
        default:
            throw new Error(`Unknown question kind ${q.kind}`);
    }
    return failures;
};

/**
 * Evaluates one question of an engine's sensitivity interpretation.
 * @param {Object} generatedResponse The engine's response
 * @param {Object} expectations The question and its answer
 * @returns {Promise<Array<Object>>} Failures
 */
export const evaluate = async function(generatedResponse, expectations) {
    const text = generatedResponse?.output?.textContent || generatedResponse?.supportingInfo?.explanation || '';
    if (!text.trim()) {
        return validateEvaluationResult([{ type: 'No response produced', details: `The engine returned no interpretation.${generatedResponse?.err ? ` Engine error: ${generatedResponse.err}` : ''}` }]);
    }
    let reading;
    try {
        reading = await extract(`sensitivityInterpretation|${expectations.caseName}|${text}`, judgeMessages(text, expectations), readingSchema);
    } catch (error) {
        return validateEvaluationResult([{ type: 'Evaluation error', details: `Error reading the interpretation: ${error.message}` }]);
    }
    return validateEvaluationResult(gradeReading(reading, expectations));
};

export const methodology = () => withFloors('sensitivityInterpretation', {
    howItWorks: [
        `Each case takes a model from the feedback-explanation fixtures and runs a one-at-a-time sensitivity sweep on it through PySD: every listed parameter is set to a low and a high value in turn, with everything else at base. The engine is given the model and a table of the swept output over time for every run, and asked to interpret it.`,
        `Besides those fixtures, every scenario in the shared scenario library gets a case by a general rule (scenarioSpec in sensitivityInterpretationData/buildCases.js): its goal variable, measured as its goal is (the peak, the value at the goal's time, or the overshoot), swept over the ${SCENARIO_PARAMETERS} constants that move that measure most, each tried at ${SCENARIO_RANGE.join(' and ')} times its value, with the key from the same rules; a scenario whose sweep runs away or gives no clear question gets no case.`,
        `The answer key comes from the same runs, by fixed rules. Every answer is computed from the sampled table the engine is shown, not from the full-resolution runs behind it. A parameter changes the shape of the behavior when some run's shape — flat, rising, falling, rising then falling, falling then rising, or oscillating, labelled by counting turning points — differs from the base run's; "only the size changes" is asked only when every run keeps the base run's shape and number of turning points and the behavior is not an oscillation, since changes in damping or period are fairly read either way. A direction is asked only when the measure moves monotonically from the low run through base to the high run; a swing under ${100 * NO_EFFECT}% is "no clear effect", and one between ${100 * NO_EFFECT}% and ${100 * CLEAR_EFFECT}% is too ambiguous to ask about. "Most" and "least influential" are asked only when the leader beats the next parameter by ${RANKING_MARGIN}× or more. Sweeps that send the model unbounded are narrowed until they do not.`,
        `The hard group (scenarioSensitivityHard) sweeps the ${HARD_PARAMETERS} constants of each scenario's goal measure that move it most, a bigger table to read, and keeps the scenarios whose questions give at least ${MIN_HARD_PAIRS} pairs; its prompt names neither the method nor the questions (it asks what the runs say about each assumption), and each test pairs two questions of one kind with different answers (a shape change with an unchanged shape, an increase with a decrease or no effect, or most with least influential), passing only when both are answered right, so no constant answer scores.`,
        `A fixed judge model reads the engine's interpretation and reports, for each parameter, only what the engine concluded, choosing from closed options; it never sees the key. This category's code compares that reading with the key.`
    ],
    criteria: [
        { name: 'Shape change misread', description: 'The engine said a parameter changes the shape of the behavior when the runs show only its size changes, or the reverse, or did not say.' },
        { name: 'Direction of effect misread', description: 'The engine got wrong, or did not say, which way raising a parameter moves the measure.' },
        { name: 'Influence ranking misread', description: 'The engine named the wrong parameter, or none, as the one the measure is most or least sensitive to.' },
        { name: 'No response produced', description: 'The engine returned no text.' },
        { name: 'Evaluation error', description: 'The judge call failed; recorded as a failure so a broken judge never reads as a good answer.' }
    ],
    scoring: `One question per test (a pair of questions in the hard group), all graded from one interpretation. An answer the engine did not commit to fails its question: the point of an interpretation is to say what the runs show.`
});
