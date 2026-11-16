/**
 * This is the stock-and-flow-within-boundary test
 *
 * Turning a problem description into a working stock-and-flow model means deciding what belongs
 * inside the model boundary and building the rest well: the mechanisms that drive the behavior,
 * formulated cleanly, and nothing that does not matter to the problem. This category hands the
 * agent a user's account of a problem together with a numbered list of things the user's team
 * believes — some drive the behavior, some do not, and some lie outside the system altogether — and
 * asks for a model that explains the behavior, with a decision on every numbered point.
 *
 * The truth comes from a hidden scenario (evals/utilities/scenarios/library.js): whether a
 * mechanism matters is decided by switching it off in the hidden simulation; points outside the
 * system are irrelevant by construction; mechanisms whose effect falls in the ambiguous band are
 * not asked about.
 *
 * Grading, one criterion per test:
 *   - each point's include/exclude decision, read by a judge from the agent's explanation
 *     (extract, don't grade — the judge is never told the answer)
 *   - each mechanism that matters must really be in the model: the causal path it creates, in
 *     glossary names, must exist in the built model with the right sign
 *   - the model simulates, reproduces the shape of each key quantity the user described, is
 *     unit-consistent, and has no formulation the linter flags
 *
 * @module categories/sfdFromBoundary
 */

import { z } from 'zod';
import { validateEvaluationResult } from '../evaluationSchema.js';
import { extract } from '../utilities/judge.js';
import { bareModel, simulateModel, allFinite } from '../utilities/simulateModel.js';
import { findVariable } from '../utilities/modelDiff.js';
import { shapeOf } from '../utilities/shape.js';
import { sourceGraph, pathPolarities, foldVariable } from '../utilities/causalGraph.js';
import { checkUnits, INCONSISTENCY_KINDS } from '../utilities/units/unitChecker.js';
import { lintFormulations } from '../utilities/formulationLint.js';
import { scenarios } from '../utilities/scenarios/library.js';
import { withFloors } from '../floors/statement.js';
import { splitHeldOut, isHeldOutScenario } from '../utilities/heldOut.js';
import { within, tightened, numbersIn } from './referenceModesData/forecast.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/** The linter rules a built model is held to. "Too many inputs" is left to formulationCritique. */
export const LINT_RULES = new Set(['embedded constant', 'unguarded division', 'hard-coded time switch']);

export const description = () => {
    return `The stock-and-flow-within-boundary test evaluates whether an agent can build a working stock-and-flow model from a problem description, deciding what belongs inside the model boundary. Given a user's account and a numbered list of beliefs — some that drive the behavior, some that do not, some outside the system — it must decide on each, really include the ones that matter, and produce a model that simulates, reproduces the behavior described, is unit-consistent and follows formulation best practice.`;
};

/** The numbered points shown to the agent: mechanisms (minus ambiguous ones) and outside facts, interleaved in a fixed order. */
export const pointsFor = function(s) {
    const mechanisms = s.mechanisms.filter((m) => m.verdict !== 'ambiguous').map((m) => ({ text: m.fact, include: m.verdict === 'matters', mechanism: m }));
    const outside = s.outsideFacts.map((fact) => ({ text: fact.text, include: false, mechanism: null }));
    const points = [];
    for (let i = 0; i < Math.max(mechanisms.length, outside.length); i++) {
        if (mechanisms[i]) points.push(mechanisms[i]);
        if (outside[i]) points.push(outside[i]);
    }
    return points;
};

const promptFor = (s) => {
    const points = pointsFor(s);
    const horizon = `${s.model.specs.stopTime - s.model.specs.startTime} ${s.timeUnits}`;
    return `${s.narrative}

My team believes the following:
${points.map((p, i) => `${i + 1}. ${p.text}`).join('\n')}

Please build a stock-and-flow model of this situation that explains the behavior I described, simulating ${horizon}. Include what matters for the problem and leave out what doesn't. Give every variable its units, and use these names for the quantities you include: ${s.glossary.map((g) => `"${g}"`).join(', ')}. In your explanation, say for each numbered point whether you included it in the model or left it out.`;
};

const generateTests = function(id) {
    const s = scenarios[id];
    const points = pointsFor(s);
    const base = {
        prompt: promptFor(s),
        currentModel: null,
        additionalParameters: { mode: 'sfd', problemStatement: `I want a simulation model that explains why ${s.title.toLowerCase()} has behaved the way it has.`, unitChecking: true }
    };
    const shared = { scenario: id, points: points.map((p) => p.text) };
    const tests = points.map((p, i) => ({
        ...base,
        name: `${s.title}: ${p.include ? 'includes' : 'leaves out'} "${p.text}"`,
        expectations: { ...shared, criterion: 'decision', number: i + 1, include: p.include }
    }));
    for (const m of s.mechanisms.filter((x) => x.verdict === 'matters' && x.signature)) {
        tests.push({ ...base, name: `${s.title}: the model really contains ${m.id}`, expectations: { ...shared, criterion: 'signature', mechanism: m.id, signature: m.signature } });
    }
    for (const k of s.keyVariables) {
        tests.push({ ...base, name: `${s.title}: ${k.glossary} follows the described pattern (${k.narrativeShape})`, expectations: { ...shared, criterion: 'shape', variable: k.glossary, shape: k.narrativeShape } });
    }
    tests.push({ ...base, name: `${s.title}: the model simulates`, expectations: { ...shared, criterion: 'simulates' } });
    tests.push({ ...base, name: `${s.title}: the model is unit-consistent`, expectations: { ...shared, criterion: 'units' } });
    tests.push({ ...base, name: `${s.title}: formulations follow best practice`, expectations: { ...shared, criterion: 'lint' } });
    return tests;
};

/**
 * The hard group's numbers: for each key quantity, its value at the end of the hidden run and the
 * band around it, and whether any system-blind answer lands in that band — the general rule of the
 * reference modes category's forecasts (referenceModesData/forecast.js, frozen in forecasts.json and
 * re-derived by that category's unit tests). Only quantities no such answer gets right are graded,
 * and only scenarios with one are asked.
 */
export const FORECASTS = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'referenceModesData', 'forecasts.json'), 'utf8'));
/**
 * The graded quantities under the hard group's tighter band (half the forecast band; see
 * referenceModesData/forecast.js): those no system-blind answer lands in — the forecast rule's naive
 * answers, 0, 1, or any number written in the hard prompt. The quantities asked about carry no
 * digits (checked in the unit tests), so the prompt's numbers do not depend on which are asked.
 */
export const gradedQuantities = function(id) {
    if (!FORECASTS[id] || !scenarios[id]) return [];
    const promptNumbers = numbersIn(hardPromptWith(scenarios[id], []));
    return FORECASTS[id].quantities.map((q) => tightened(q, promptNumbers)).filter((q) => q.graded);
};

const unitOf = (timeUnits) => timeUnits.replace(/s$/, '');

const tableText = (f) => [
    `| ${unitOf(f.timeUnits)} | ${f.columns.join(' | ')} |`,
    `|${' --- |'.repeat(f.columns.length + 1)}`,
    ...f.table.map((row) => `| ${row.time} | ${f.columns.map((c) => row[c]).join(' | ')} |`)
].join('\n');

/**
 * The hard prompt: the same beliefs, the numbers the team knows and the forecast rule's rough table of
 * the first half of the run, and the end of the run as the thing the model is for — graded on the
 * numbers the model gives, not on the shapes. The account of the whole period (the narrative and
 * the opening) is left out: it tells how the run ends.
 */
const hardPromptFor = (s) => hardPromptWith(s, gradedQuantities(s.id).map((q) => q.glossary));

const hardPromptWith = (s, asked) => {
    const f = FORECASTS[s.id];
    const points = pointsFor(s);
    const unit = unitOf(s.timeUnits);
    return `I'm trying to work out where things are heading for our ${s.title.toLowerCase()}. My team believes the following:
${points.map((p, i) => `${i + 1}. ${p.text}`).join('\n')}

These are the numbers we know:
${(s.parameterFacts || []).map((x) => `- ${x.text}`).join('\n')}

Here is what we have recorded so far, by ${unit}; the records are a little rough:

${tableText(f)}

We are at ${unit} ${f.now} now. Please build a stock-and-flow model of this situation that explains what we have recorded, running from ${unit} ${s.model.specs.startTime} to ${unit} ${s.model.specs.stopTime}. Include what matters for the problem and leave out what doesn't. Give every variable its units, and use these names for the quantities you include: ${s.glossary.map((g) => `"${g}"`).join(', ')}. What I need from it is where ${asked.length > 1 ? `${asked.slice(0, -1).join(', ')} and ${asked.at(-1)}` : asked[0]} will be at ${unit} ${s.model.specs.stopTime} if we carry on as we are.`;
};

export const hardIds = Object.keys(scenarios).filter((id) => gradedQuantities(id).length);

const generateHardTest = function(id) {
    const s = scenarios[id];
    const quantities = gradedQuantities(id).map((q) => ({ variable: q.glossary, truth: q.truth, band: q.band }));
    return {
        prompt: hardPromptFor(s),
        currentModel: null,
        additionalParameters: { mode: 'sfd', problemStatement: `I want a simulation model that tells me where ${s.title.toLowerCase()} is heading.`, unitChecking: true },
        name: `${s.title}: (hard) the model puts ${quantities.map((q) => q.variable).join(' and ')} at the right level at ${unitOf(s.timeUnits)} ${s.model.specs.stopTime}`,
        expectations: { scenario: id, criterion: 'endValues', quantities }
    };
};

const rawGroups = {
    sfdFromBoundary: Object.keys(scenarios).flatMap(generateTests),
    sfdFromBoundaryHard: hardIds.map(generateHardTest)
};


/** The groups, each split into its dev tests and its held-out ones (`<group>HeldOut`); see utilities/heldOut.js. */
export const groups = splitHeldOut(rawGroups, (t) => isHeldOutScenario(t.expectations.scenario));
export const decisionSchema = z.object({
    decisions: z.array(z.object({
        number: z.number().int().positive().describe('The number of the point'),
        decision: z.enum(['include', 'exclude', 'unclear']).describe("What the response says it did with this point: 'include' if it put it in the model, 'exclude' if it left it out, 'unclear' if it does not say")
    })).describe('One entry for every numbered point')
});

const decisionMessages = (text, points) => [
    { role: 'system', content: `You read an explanation of a simulation model and report, for each numbered point the user raised, whether the explanation says the point was included in the model or left out. Report only what the explanation says; do not judge whether the decision was right.` },
    { role: 'user', content: `Points:
${points.map((p, i) => `${i + 1}. ${p}`).join('\n')}

Explanation:
"""
${text}
"""

For every numbered point, report the decision the explanation states.` }
];

/**
 * Evaluates one criterion.
 * @param {Object} generatedResponse The agent's response: model and explanation
 * @param {Object} expectations The criterion
 * @returns {Promise<Array<Object>>} Failures
 */
export const evaluate = async function(generatedResponse, expectations) {
    const s = scenarios[expectations.scenario];
    const model = bareModel(generatedResponse);
    if (!model || (model.variables || []).length === 0) {
        return validateEvaluationResult([{ type: 'No model produced', details: `The agent did not return a model.${generatedResponse?.err ? ` Engine error: ${generatedResponse.err}` : ''}` }]);
    }
    const failures = [];
    // Always the scenario's own run: its start, stop and step. An agent's coarser step or shorter
    // horizon would change the behavior being graded (or let a short run land on the wanted shape);
    // only its time units are kept, for the unit check.
    const runnable = { ...model, relationships: model.relationships || [], specs: { ...s.model.specs, timeUnits: model.specs?.timeUnits || s.model.specs.timeUnits } };

    switch (expectations.criterion) {
        case 'decision': {
            const text = generatedResponse?.supportingInfo?.explanation || generatedResponse?.output?.textContent || '';
            if (!text.trim()) { failures.push({ type: 'Boundary decision wrong', details: 'The agent gave no explanation of what it included.' }); break; }
            let reading;
            try {
                reading = await extract(`sfdFromBoundary|${expectations.scenario}|${text}`, decisionMessages(text, expectations.points), decisionSchema);
            } catch (error) {
                failures.push({ type: 'Evaluation error', details: `Error reading the explanation: ${error.message}` });
                break;
            }
            const said = (reading.decisions || []).find((d) => d.number === expectations.number)?.decision ?? 'unclear';
            const wanted = expectations.include ? 'include' : 'exclude';
            if (said !== wanted) {
                failures.push({ type: 'Boundary decision wrong', details: `Point ${expectations.number} ("${expectations.points[expectations.number - 1]}") should be ${expectations.include ? 'included: switching it off in the true system changes the behavior' : 'left out: it does not change the behavior the problem is about'}; the agent ${said === 'unclear' ? 'did not say' : `chose to ${said} it`}.` });
            }
            break;
        }
        case 'signature': {
            const { from, to, polarity } = expectations.signature;
            const graph = sourceGraph(model, null);
            const missing = [from, to].filter((n) => !graph.names.has(foldVariable(n)));
            if (missing.length) { failures.push({ type: 'Mechanism not in model', details: `The model has no ${missing.map((n) => `"${n}"`).join(' or ')}, so ${expectations.mechanism} cannot be in it.` }); break; }
            const stocks = new Set(model.variables.filter((v) => v.type === 'stock').map((v) => foldVariable(v.name)));
            const blocked = expectations.signature.throughStocks ? new Set() : stocks;
            const paths = pathPolarities(graph, foldVariable(from), foldVariable(to), blocked);
            if (paths.size === 0) failures.push({ type: 'Mechanism not in model', details: `Nothing in the model links "${from}" to "${to}", which ${expectations.mechanism} requires.` });
            // A path whose sign the equations leave open (an IF on the input, a lookup that turns)
            // counts, unless some path has the opposite sign.
            else if (!paths.has(polarity) && !(paths.has('?') && !paths.has(polarity === '+' ? '-' : '+'))) failures.push({ type: 'Mechanism not in model', details: paths.has('?') && paths.size === 1 ? `The model links "${from}" to "${to}", but its equations do not settle the direction of the effect, so ${expectations.mechanism} (${polarity}) cannot be confirmed.` : `The model links "${from}" to "${to}" only with polarity ${[...paths].join('/')}; ${expectations.mechanism} needs ${polarity}.` });
            break;
        }
        case 'shape': {
            const variable = findVariable(model.variables, expectations.variable);
            if (!variable) { failures.push({ type: 'Behavior not reproduced', details: `The model has no "${expectations.variable}".` }); break; }
            const run = await simulateModel(runnable, [variable.name], null);
            if (!run.ok || !allFinite(run.series[variable.name])) { failures.push({ type: 'Behavior not reproduced', details: run.ok ? `"${variable.name}" produced non-finite values.` : run.error }); break; }
            const shape = shapeOf(run.series[variable.name]);
            if (shape !== expectations.shape) failures.push({ type: 'Behavior not reproduced', details: `In the model "${variable.name}" is ${shape}; the user described it as ${expectations.shape}.` });
            break;
        }
        case 'endValues': {
            // The hard group: every graded quantity at the end of the scenario's own run, within its band.
            const named = expectations.quantities.map((q) => ({ ...q, v: findVariable(model.variables, q.variable) }));
            for (const q of named.filter((x) => !x.v)) failures.push({ type: 'End value off', details: `The model has no "${q.variable}".` });
            const present = named.filter((x) => x.v);
            if (!present.length) break;
            const run = await simulateModel(runnable, present.map((q) => q.v.name), null);
            if (!run.ok) { failures.push({ type: 'Model does not simulate', details: run.error }); break; }
            for (const q of present) {
                const end = run.series[q.v.name].at(-1);
                if (!within(end, q)) failures.push({ type: 'End value off', details: `In the model "${q.v.name}" ends at ${Number.isFinite(end) ? Number(end.toPrecision(4)) : end}; the hidden simulation has ${q.truth} (within ${q.band} counts).` });
            }
            break;
        }
        case 'simulates': {
            const run = await simulateModel(runnable, null, null);
            if (!run.ok) failures.push({ type: 'Model does not simulate', details: run.error });
            else {
                const bad = Object.entries(run.series).find(([, v]) => !allFinite(v));
                if (bad) failures.push({ type: 'Model does not simulate', details: `"${bad[0]}" produced non-finite values.` });
            }
            break;
        }
        case 'units': {
            for (const w of checkUnits(runnable).filter((x) => INCONSISTENCY_KINDS.has(x.kind) || x.kind === 'missing')) {
                failures.push({ type: 'Unit inconsistency', details: w.message });
            }
            break;
        }
        case 'lint': {
            for (const f of lintFormulations(model).filter((x) => LINT_RULES.has(x.rule))) failures.push({ type: 'Formulation not best practice', details: f.message });
            break;
        }
        default:
            throw new Error(`Unknown criterion ${expectations.criterion}`);
    }
    return validateEvaluationResult(failures);
};

export const methodology = () => withFloors('sfdFromBoundary', {
    howItWorks: [
        `Each test is built on a hidden scenario: a small working simulation of an ordinary situation that the agent never sees. The user describes what they have observed in plain words, then lists numbered things their team believes. Some are mechanisms of the hidden system; switching one off in the hidden simulation either changes the behavior the problem is about (it matters: shape changes, or a peak or final value moves by 25% or more) or barely touches it (under 10%). Mechanisms in between are not listed. Others are true statements that lie outside the system altogether.`,
        `The agent is asked to build a stock-and-flow model that explains the behavior, using a glossary of names, and to say for each numbered point whether it included it. Agents run with the unit checker's warnings reported to them.`,
        `Each decision is read from the agent's explanation by a fixed judge model that reports only what the explanation says. A mechanism that matters must also really be in the model: the causal path it creates — for example from the waiting list to the number of chairs, with a positive sign — must exist in the built model. Link signs come from the model's own equations (the sign of each equation's dependence on its inputs, assuming positive quantities), so a mechanism built backwards does not count.`,
        `The model must simulate, reproduce the shape the user described for each key quantity (labelled by counting turning points), pass the unit checker with units on every variable, and avoid the formulations the linter flags: numbers written into equations instead of named constants, division by a stock with no guard, and comparisons of TIME to a number.`,
        `Hard group (sfdFromBoundaryHard): numbers instead of shapes. The agent gets the same beliefs, the numbers the team knows and the reference modes category's rough table of the first half of the run — not the account of the whole period, which tells how it ends — and is told the model is for where the key quantities will be at the end of the run; each key quantity whose end value no system-blind answer gets right (the reference modes category's forecast rule: not its first, last, lowest or highest value over the first half of the run, not the straight-line trend, not 0 or 1) must end, in the agent's simulated model, within a tightened band — 7.5% of the hidden simulation's value (or 1% of its largest value, for one ending near zero), half the forecast band, because the prompt gives every number behind the hidden run, so the model is limited only by how it formulates the mechanisms — and only quantities whose band no number written in the prompt lands in are graded, all in one test.`
    ],
    criteria: [
        { name: 'Boundary decision wrong', description: 'The agent included a point that should be left out, left out one that should be included, or did not say.' },
        { name: 'Mechanism not in model', description: 'A mechanism that matters is not in the model: the causal path it creates is missing or has the wrong sign.' },
        { name: 'Behavior not reproduced', description: 'A key quantity in the model does not follow the shape the user described, or is missing.' },
        { name: 'Model does not simulate', description: 'The model fails to simulate or produces non-finite values.' },
        { name: 'Unit inconsistency', description: 'The unit checker found an inconsistency, or a variable without readable units.' },
        { name: 'Formulation not best practice', description: 'The linter flagged an embedded constant, an unguarded division by a stock, or a hard-coded time switch.' },
        { name: 'End value off', description: 'Hard group: a key quantity is missing from the model, or ends the run outside the band around the hidden simulation\'s value.' },
        { name: 'No model produced', description: 'The agent returned no model.' },
        { name: 'Evaluation error', description: 'The judge call failed; recorded as a failure so a broken judge never reads as a good answer.' }
    ],
    scoring: `One criterion per test, all graded from one model and explanation per scenario; in the hard group, one test per scenario with every graded end value together.`
});
