/**
 * This is the reference modes test
 *
 * Before modeling anything, a modeler pins down the problem as behavior over time: which quantities
 * matter, and what pattern each has followed — the reference modes a model must be able to explain.
 * Then they propose a dynamic hypothesis: the feedback structure they think produces those
 * patterns. This category runs both steps as one conversation with the agent.
 *
 * Each test is built on a hidden scenario (evals/utilities/scenarios/library.js): a working
 * simulation the agent never sees, and a user's plain account of what they have observed, which
 * also mentions a trend that has nothing to do with the problem.
 *   - Turn 1: the user's account, and the question "which patterns should a model explain?"
 *   - Turn 2: "build a causal loop diagram, as the model, of the structure you think produces
 *     them", with a glossary of names to use.
 *
 * Grading:
 *   - for each key quantity, the agent's turn-1 answer must name it with the shape the hidden
 *     simulation shows (a judge reads the answer against a closed list of quantities and shapes)
 *   - the unrelated trend must not be proposed as something the model should explain
 *   - for each loop that produces the behavior — loops whose mechanism the hidden model shows
 *     matters, by switching it off — the diagram must contain a loop of the same polarity that runs
 *     only through that loop's variables (the modelToCLD rule)
 *
 * @module categories/referenceModes
 */

import { z } from 'zod';
import { validateEvaluationResult } from '../evaluationSchema.js';
import { extract } from '../utilities/judge.js';
import { SHAPES } from '../utilities/shape.js';
import { graphFromLinks, findCycles, foldVariable, cldLinksFromResponse } from '../utilities/causalGraph.js';
import { scenarios } from '../utilities/scenarios/library.js';
import { withFloors } from '../floors/statement.js';
import { splitHeldOut, isHeldOutScenario } from '../utilities/heldOut.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { within, tightened, numbersIn, pointGraded, MIN_TRAJECTORY_TIMES, HORIZONS } from './referenceModesData/forecast.js';

const CYCLE_CAP = 5000;

export const description = () => {
    return `The reference modes test evaluates whether an agent can define a modeling problem as behavior over time and propose a dynamic hypothesis for it. From a user's plain account of what they have observed, it must name the patterns a model should explain — each quantity with the shape the hidden simulation shows, and not the unrelated trend the user also mentioned — and then build a causal loop diagram containing the feedback loops that, by ablation of the hidden model, produce that behavior.`;
};

const firstPrompt = (s) => `${s.narrative}

Before we build anything: what behavior over time should a model of this situation be able to explain? For each quantity that matters to the problem, describe the pattern it has followed.`;

const secondPrompt = (s) => `Now propose a dynamic hypothesis. Build, as the model, a causal loop diagram of the feedback structure you think produces those patterns, giving every link its polarity. Use these names for the quantities you include: ${s.glossary.map((g) => `"${g}"`).join(', ')}.`;

/** The quantities the judge reads the first answer against: key quantities and distractors. */
export const candidateQuantities = (s) => [...s.keyVariables.map((k) => k.glossary), ...s.distractorTrends.map((d) => d.glossary)];

const generateTests = function(id) {
    const s = scenarios[id];
    const base = {
        prompt: firstPrompt(s),
        currentModel: null,
        additionalParameters: {
            mode: 'cld',
            problemStatement: `I want to understand why ${s.title.toLowerCase()} has behaved the way it has.`,
            turns: [secondPrompt(s)]
        }
    };
    const shared = { scenario: id, quantities: candidateQuantities(s) };
    return [
        ...s.keyVariables.map((k) => ({ ...base, name: `${s.title}: names the pattern of ${k.glossary} (${k.narrativeShape})`, expectations: { ...shared, criterion: 'pattern', quantity: k.glossary, shape: k.narrativeShape } })),
        ...s.distractorTrends.map((d) => ({ ...base, name: `${s.title}: leaves out the unrelated ${d.glossary} trend`, expectations: { ...shared, criterion: 'distractor', quantity: d.glossary } })),
        ...s.loops.map((l) => ({ ...base, name: `${s.title}: hypothesis contains the ${l.id} loop`, expectations: { ...shared, criterion: 'loop', loop: l, glossary: s.glossary } }))
    ];
};

/**
 * The hard group's forecast questions, by the general rule in referenceModesData/forecast.js
 * (frozen in forecasts.json): numbers instead of shapes. The agent hears how the situation works
 * and gets a rough table of the first half of the run, and is asked, with no hint of how, where each
 * key quantity will be at the end of the run. Only quantities no system-blind answer gets right are
 * graded, and only scenarios with at least one such quantity are asked.
 */
export const FORECASTS = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'referenceModesData', 'forecasts.json'), 'utf8'));

const unitOf = (timeUnits) => timeUnits.replace(/s$/, '');
const tableText = (f) => [
    `| ${unitOf(f.timeUnits)} | ${f.columns.join(' | ')} |`,
    `|${' --- |'.repeat(f.columns.length + 1)}`,
    ...f.table.map((row) => `| ${row.time} | ${f.columns.map((c) => row[c]).join(' | ')} |`)
].join('\n');

export const forecastPrompt = function(s, f) {
    const facts = [...s.mechanisms.map((m) => m.fact), ...(s.parameterFacts || []).map((p) => p.text)];
    const asked = f.quantities.map((q) => q.glossary);
    return `I'm trying to work out where things are heading for our ${s.title.toLowerCase()}. Here is how things work here, as far as we know:
${facts.map((x) => `- ${x}`).join('\n')}

Here is what we have recorded so far, by ${unitOf(f.timeUnits)}; the records are a little rough:

${tableText(f)}

We are at ${unitOf(f.timeUnits)} ${f.now} now. If we carry on as we are and change nothing, what will ${asked.length > 1 ? `${asked.slice(0, -1).join(', ')} and ${asked.at(-1)}` : asked[0]} be at ${unitOf(f.timeUnits)} ${f.at}? I need a number for each.`;
};

/**
 * A scenario's forecast quantities under the hard group's tighter band (forecast.js: half the
 * forecast band), each graded only when no system-blind answer — the forecast rule's naive answers,
 * 0, 1, or any number written in the prompt — lands in it.
 * @param {string} id A scenario id
 * @returns {Array<Object>}
 */
export const hardQuantities = function(id) {
    const f = FORECASTS[id];
    if (!f) return [];
    const promptNumbers = numbersIn(forecastPrompt(scenarios[id], f));
    return f.quantities.map((q) => tightened(q, promptNumbers));
};

const generateHardTests = function(id) {
    const s = scenarios[id];
    const f = FORECASTS[id];
    if (!f || !hardQuantities(id).some((q) => q.graded)) return [];
    const base = { prompt: forecastPrompt(s, f), currentModel: null, additionalParameters: { mode: 'sfd', problemStatement: `I want to know where ${s.title.toLowerCase()} is heading.` } };
    const quantities = f.quantities.map((q) => q.glossary);
    return hardQuantities(id).filter((q) => q.graded).map((q) => ({
        ...base,
        name: `${s.title}: forecasts ${q.glossary} at ${unitOf(f.timeUnits)} ${f.at} within the band`,
        expectations: { scenario: id, criterion: 'forecast', quantity: q.glossary, quantities, at: f.at, timeUnits: f.timeUnits, truth: q.truth, band: q.band }
    }));
};

/**
 * The second hard group's questions, by the rule in referenceModesData/forecast.js (trajectoryFor;
 * frozen in trajectories.json): the hard group's facts and table, and every key quantity asked at
 * several times through the rest of the run, all graded together.
 */
export const TRAJECTORIES = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'referenceModesData', 'trajectories.json'), 'utf8'));

const listOf = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : String(xs[0]));

export const trajectoryPrompt = function(s, f, tr) {
    const facts = [...s.mechanisms.map((m) => m.fact), ...(s.parameterFacts || []).map((p) => p.text)];
    const asked = s.keyVariables.map((k) => k.glossary);
    return `I'm trying to work out where things are heading for our ${s.title.toLowerCase()}. Here is how things work here, as far as we know:
${facts.map((x) => `- ${x}`).join('\n')}

Here is what we have recorded so far, by ${unitOf(f.timeUnits)}; the records are a little rough:

${tableText(f)}

We are at ${unitOf(f.timeUnits)} ${f.now} now. If we carry on as we are and change nothing, what will ${listOf(asked)} be at ${f.timeUnits} ${listOf(tr.times)}? I need a number for each of them at each of those times.`;
};

/** The numbered list the judge reads a trajectory answer against: every key quantity at every time asked. */
const trajectoryItems = (tr) => tr.points.map((p) => ({ quantity: p.glossary, at: p.at }));

/**
 * A scenario's trajectory points, each marked `graded` when no system-blind answer — a naive
 * answer from the table, 0, 1, or any number written in the prompt — lands in its band.
 */
export const trajectoryPoints = function(id) {
    const tr = TRAJECTORIES[id];
    if (!tr || !FORECASTS[id]) return [];
    const promptNumbers = numbersIn(trajectoryPrompt(scenarios[id], FORECASTS[id], tr));
    return tr.points.map((p) => ({ ...p, graded: pointGraded(p, promptNumbers) }));
};

/** Whether a scenario is asked in the second hard group: held out, with graded points at enough different times. */
export const trajectoryAsked = (id) => isHeldOutScenario(id) && new Set(trajectoryPoints(id).filter((p) => p.graded).map((p) => p.at)).size >= MIN_TRAJECTORY_TIMES;

const generateHard2Tests = function(id) {
    const s = scenarios[id];
    const f = FORECASTS[id];
    const tr = TRAJECTORIES[id];
    const points = trajectoryPoints(id);
    return [{
        prompt: trajectoryPrompt(s, f, tr),
        currentModel: null,
        additionalParameters: { mode: 'sfd', problemStatement: `I want to know where ${s.title.toLowerCase()} is heading.` },
        name: `${s.title}: (hard 2) forecasts every key quantity at ${listOf(tr.times)} ${f.timeUnits}, all within the band`,
        expectations: { scenario: id, criterion: 'trajectory', items: trajectoryItems(tr), timeUnits: f.timeUnits, graded: points.flatMap((p, i) => (p.graded ? [{ item: i, truth: p.truth, band: p.band }] : [])) }
    }];
};

const rawGroups = {
    referenceModes: Object.keys(scenarios).flatMap(generateTests),
    referenceModesHard: Object.keys(scenarios).flatMap(generateHardTests),
    referenceModesHard2: Object.keys(scenarios).filter(trajectoryAsked).flatMap(generateHard2Tests)
};


/** The groups, each split into its dev tests and its held-out ones (`<group>HeldOut`); see utilities/heldOut.js. */
export const groups = splitHeldOut(rawGroups, (t) => isHeldOutScenario(t.expectations.scenario));
export const readingSchema = z.object({
    quantities: z.array(z.object({
        number: z.number().int().positive().describe('The quantity number'),
        proposed: z.enum(['yes', 'no']).describe("'yes' if the response proposes this quantity's behavior as something a model of the problem should explain; 'no' if it leaves it out or sets it aside as unrelated"),
        shape: z.enum([...SHAPES, 'unclear']).describe("The pattern the response describes for it. 'rising' includes S-shaped growth that levels off; 'oscillating' includes swings that die down; 'unclear' if no single pattern is described")
    })).describe('One entry for every numbered quantity')
});

const readingMessages = function(text, quantities) {
    return [
        { role: 'system', content: `You read an answer to the question "what behavior over time should a model of this situation explain?" and report, for a list of quantities, whether the answer proposes each as a behavior to explain and what pattern it describes. Report only what the answer says, not what you think is right. Patterns: ${SHAPES.join(', ')}.` },
        { role: 'user', content: `Quantities:
${quantities.map((q, i) => `${i + 1}. ${q}`).join('\n')}

Answer:
"""
${text}
"""

For every numbered quantity, report whether the answer proposes it and the pattern it describes.` }
    ];
};

/**
 * The diagram loops that stand for a scenario loop: they keep every core variable, and every
 * glossary quantity they pass through is on the scenario loop. Quantities outside the glossary
 * (an intermediate such as "desired chairs" or "inventory gap") are allowed: the glossary only asks
 * the agent to use its names for the quantities it includes.
 * @param {Array<{nodes: Array<string>, polarity: string}>} cycles The diagram's loops
 * @param {{variables: Array<string>, core: Array<string>}} loop The scenario loop
 * @param {Array<string>} glossary The scenario glossary
 * @returns {Array<Object>} The matching loops
 */
export const matchingLoops = function(cycles, loop, glossary) {
    const onLoop = new Set(loop.variables.map(foldVariable));
    const inGlossary = new Set(glossary.map(foldVariable));
    const core = loop.core.map(foldVariable);
    return cycles.filter((c) => core.every((n) => c.nodes.includes(n)) && c.nodes.every((n) => onLoop.has(n) || !inGlossary.has(n)));
};

export const forecastSchema = z.object({
    forecasts: z.array(z.object({
        number: z.number().int().positive().describe('The quantity number'),
        value: z.number().nullable().describe('The single number the answer gives for this quantity at the time asked about; the midpoint if it gives a range; null if it gives no number for it')
    })).describe('One entry for every numbered quantity')
});

const forecastMessages = (text, expectations) => [
    { role: 'system', content: 'You read an answer to the question "where will these quantities be at a given time?" and report the number the answer gives for each listed quantity at that time. Report only what the answer says, not what you think is right.' },
    { role: 'user', content: `Time asked about: ${unitOf(expectations.timeUnits)} ${expectations.at}

Quantities:
${expectations.quantities.map((q, i) => `${i + 1}. ${q}`).join('\n')}

Answer:
"""
${text}
"""

For every numbered quantity, report the number the answer gives for it at that time.` }
];

const trajectoryMessages = (text, expectations) => [
    { role: 'system', content: 'You read an answer to the question "where will these quantities be at given times?" and report the number the answer gives for each listed quantity at the time listed with it. Report only what the answer says, not what you think is right.' },
    { role: 'user', content: `Quantities and times:
${expectations.items.map((x, i) => `${i + 1}. ${x.quantity} at ${unitOf(expectations.timeUnits)} ${x.at}`).join('\n')}

Answer:
"""
${text}
"""

For every numbered quantity, report the number the answer gives for it at its time.` }
];

/** The agent's answer to the first question: its first turn in the transcript. */
const firstAnswer = function(generatedResponse) {
    const turn = (generatedResponse?.transcript || []).find((t) => t.role === 'agent' && t.turn === 1);
    return turn ? turn.text : '';
};

/**
 * Evaluates one criterion.
 * @param {Object} generatedResponse The conversation engine's response (transcript and final model)
 * @param {Object} expectations The criterion
 * @returns {Promise<Array<Object>>} Failures
 */
export const evaluate = async function(generatedResponse, expectations) {
    // Leaving out the unrelated trend counts only once some key pattern is named: an answer that
    // names nothing would otherwise pass.
    const own = await evaluateOne(generatedResponse, expectations);
    if (expectations.criterion !== 'distractor') return own;
    const siblings = rawGroups.referenceModes.filter((t) => t.expectations.scenario === expectations.scenario && t.expectations.criterion === 'pattern');
    for (const t of siblings) if (!(await evaluateOne(generatedResponse, t.expectations)).length) return own;
    return validateEvaluationResult([...own, { type: 'Reference mode missing', details: 'This test counts only once at least one key trend is named with its pattern; none is.' }]);
};

const evaluateOne = async function(generatedResponse, expectations) {
    const failures = [];
    if (generatedResponse?.err) {
        return validateEvaluationResult([{ type: 'No response produced', details: `The engine failed: ${generatedResponse.err}` }]);
    }
    switch (expectations.criterion) {
        case 'pattern':
        case 'distractor': {
            const text = firstAnswer(generatedResponse);
            if (!text.trim()) {
                failures.push({ type: 'No response produced', details: generatedResponse?.transcript ? 'The agent gave no answer to the first question.' : 'The response has no transcript; this category needs the test-agent-converse engine.' });
                break;
            }
            let reading;
            try {
                reading = await extract(`referenceModes|${expectations.scenario}|${text}`, readingMessages(text, expectations.quantities), readingSchema);
            } catch (error) {
                failures.push({ type: 'Evaluation error', details: `Error reading the answer: ${error.message}` });
                break;
            }
            const number = expectations.quantities.indexOf(expectations.quantity) + 1;
            const entry = (reading.quantities || []).find((q) => q.number === number);
            if (expectations.criterion === 'pattern') {
                if (entry?.proposed !== 'yes') failures.push({ type: 'Reference mode missing', details: `The answer does not propose the behavior of ${expectations.quantity} as something the model should explain.` });
                else if (entry.shape !== expectations.shape) failures.push({ type: 'Reference mode misdescribed', details: `The answer describes ${expectations.quantity} as ${entry.shape}; it has been ${expectations.shape}.` });
            } else if (entry?.proposed === 'yes') {
                failures.push({ type: 'Unrelated trend proposed', details: `The answer proposes the ${expectations.quantity} trend as something the model should explain; it has nothing to do with the problem.` });
            }
            break;
        }
        case 'forecast': {
            // The forecast is asked in one turn; an engine that keeps no transcript for it still
            // gives the answer as its explanation.
            const text = firstAnswer(generatedResponse) || generatedResponse?.supportingInfo?.explanation || generatedResponse?.output?.textContent || '';
            if (!text.trim()) {
                failures.push({ type: 'No response produced', details: generatedResponse?.transcript ? 'The agent gave no answer.' : 'The response has no transcript; this category needs the test-agent-converse engine.' });
                break;
            }
            let reading;
            try {
                reading = await extract(`referenceModes|forecast|${expectations.scenario}|${text}`, forecastMessages(text, expectations), forecastSchema);
            } catch (error) {
                failures.push({ type: 'Evaluation error', details: `Error reading the answer: ${error.message}` });
                break;
            }
            const number = expectations.quantities.indexOf(expectations.quantity) + 1;
            const value = (reading.forecasts || []).find((q) => q.number === number)?.value;
            if (typeof value !== 'number') failures.push({ type: 'Forecast missing', details: `The answer gives no number for ${expectations.quantity} at ${unitOf(expectations.timeUnits)} ${expectations.at}.` });
            else if (!within(value, expectations)) failures.push({ type: 'Forecast off', details: `The answer puts ${expectations.quantity} at ${value} at ${unitOf(expectations.timeUnits)} ${expectations.at}; the hidden simulation has ${expectations.truth} (within ${expectations.band} counts).` });
            break;
        }
        case 'trajectory': {
            // Every graded point of the path at once: one number per quantity and time.
            const text = firstAnswer(generatedResponse) || generatedResponse?.supportingInfo?.explanation || generatedResponse?.output?.textContent || '';
            if (!text.trim()) {
                failures.push({ type: 'No response produced', details: generatedResponse?.transcript ? 'The agent gave no answer.' : 'The response has no transcript; this category needs the test-agent-converse engine.' });
                break;
            }
            let reading;
            try {
                reading = await extract(`referenceModes|trajectory|${expectations.scenario}|${text}`, trajectoryMessages(text, expectations), forecastSchema);
            } catch (error) {
                failures.push({ type: 'Evaluation error', details: `Error reading the answer: ${error.message}` });
                break;
            }
            for (const g of expectations.graded) {
                const { quantity, at } = expectations.items[g.item];
                const value = (reading.forecasts || []).find((q) => q.number === g.item + 1)?.value;
                if (typeof value !== 'number') failures.push({ type: 'Forecast missing', details: `The answer gives no number for ${quantity} at ${unitOf(expectations.timeUnits)} ${at}.` });
                else if (!within(value, g)) failures.push({ type: 'Forecast off', details: `The answer puts ${quantity} at ${value} at ${unitOf(expectations.timeUnits)} ${at}; the hidden simulation has ${g.truth} (within ${g.band} counts).` });
            }
            break;
        }
        case 'loop': {
            const links = cldLinksFromResponse(generatedResponse);
            if (links.length === 0) {
                failures.push({ type: 'No causal loop diagram produced', details: 'The model the agent built holds no relationships with a polarity.' });
                break;
            }
            const { loop, glossary } = expectations;
            const candidates = matchingLoops(findCycles(graphFromLinks(links), CYCLE_CAP), loop, glossary);
            if (!candidates.some((c) => c.polarity === loop.polarity)) {
                failures.push({
                    type: 'Explaining loop missing',
                    details: candidates.length
                        ? `The diagram has a loop through ${candidates[0].nodes.join(' -> ')} but with the wrong polarity; the ${loop.id} loop is ${loop.polarity === '+' ? 'reinforcing' : 'balancing'}.`
                        : `No loop in the diagram runs through ${loop.core.join(' and ')} along the ${loop.id} loop (${loop.variables.join(', ')}); without it the hypothesis cannot produce the behavior.`
                });
            }
            break;
        }
        default:
            throw new Error(`Unknown criterion ${expectations.criterion}`);
    }
    return validateEvaluationResult(failures);
};

export const methodology = () => withFloors('referenceModes', {
    howItWorks: [
        `Each test is built on a hidden scenario: a small working simulation of an ordinary situation — a dialysis waiting list, a bike-share scheme, a distributor's inventory — that the agent never sees. The user describes what they have observed in plain words, with no modeling vocabulary, and also mentions a trend that has nothing to do with the problem. The shapes the account describes are checked against the hidden simulation in the category's unit tests, so the account and the truth cannot disagree.`,
        `The conversation has two turns. First the user asks which behavior over time a model should explain. Then the user asks for a dynamic hypothesis: a causal loop diagram, built as the model, of the structure that produces those patterns, using a glossary of names so the diagram can be read without guessing.`,
        `The first answer is read by a fixed judge model against a closed list — the key quantities and the unrelated trend — reporting for each whether the answer proposes it and with what shape (flat, rising, falling, rising then falling, falling then rising, oscillating). The judge is never told the right answers. The diagram is read from the model the agent built.`,
        `The loops a hypothesis must contain are the ones whose mechanism matters: switching that mechanism off in the hidden model changes a key quantity's shape (checked in the unit tests). A loop is present when the diagram has a loop of the same polarity that keeps the loop's core quantities (for capacity expansion, the waiting list and the chairs) and passes through no glossary quantity that is off the loop; intermediate quantities outside the glossary are allowed.`,
        `The hard group (referenceModesHard) asks for numbers instead of shapes, with no hint of method: the agent hears only how the situation works and gets a rough table (3% fixed noise) of the first half of the hidden run, and must say where each key quantity will be at the end of the run, graded within a tightened band: 7.5% of the hidden simulation's value (or 1% of the quantity's largest recorded value, for one ending near zero) — half the 15% forecast band, because the prompt gives every number behind the hidden run, so a forecast worked out from them is limited only by how the mechanisms are formulated; a quantity is graded only when neither the first, last, lowest or highest recorded value, the straight-line trend of the last four rows, the constants 0 and 1, nor any number written in the prompt lands in that band, and only scenarios with such a quantity are asked.`,
        `The second hard group (referenceModesHard2, held-out scenarios only; the lever: several answers graded together, all needed to pass) gives the same facts and table but asks for every key quantity at several times through the rest of the run — ${HORIZONS.map((h) => `${100 * h}%`).join(', ')} of the way through it, not only at its end — and one test needs every graded number within the hard group's tighter band at its time (7.5% of the hidden value there, or 1% of the quantity's largest value up to now); a point is graded only when no naive answer from the table (first, last, lowest, highest, the straight-line trend of the last four rows read at that time), 0, 1 or number written in the prompt lands in its band, and a scenario is asked only when its graded points fall at ${MIN_TRAJECTORY_TIMES} different times or more, so the answer has to be a path through time that the mechanisms produce.`
    ],
    criteria: [
        { name: 'Reference mode missing', description: 'The first answer does not propose a key quantity\'s behavior as something the model should explain.' },
        { name: 'Reference mode misdescribed', description: 'The first answer proposes a key quantity but describes the wrong pattern.' },
        { name: 'Unrelated trend proposed', description: 'The first answer proposes the unrelated trend as something the model should explain.' },
        { name: 'Explaining loop missing', description: 'The diagram has no loop of the right polarity through the quantities of a loop that produces the behavior.' },
        { name: 'Forecast missing', description: 'Hard group: the answer gives no number for a quantity it was asked to forecast.' },
        { name: 'Forecast off', description: 'Hard group: the forecast is outside the band around the hidden simulation\'s value.' },
        { name: 'No causal loop diagram produced', description: 'The agent built no diagram with signed links.' },
        { name: 'No response produced', description: 'The agent gave no first answer, or the engine failed.' },
        { name: 'Evaluation error', description: 'The judge call failed; recorded as a failure so a broken judge never reads as a good answer.' }
    ],
    scoring: `One criterion per test, all graded from one conversation per scenario; in the hard group, one test per graded forecast, all read from one answer per scenario; in the second hard group, one test per scenario, every graded point of the path read from one answer.`
});
