/**
 * This is the calibration test
 *
 * Calibrating a model to history is two skills: fitting the parameters when the structure is
 * right, and recognizing when no parameter values can make it fit because something is missing.
 * Forcing a fit onto a model that lacks a mechanism produces confident nonsense. This category
 * gives the agent a working model, historical data for one of its stocks, and calibration tools
 * (load_calibration_data, run_calibration, run_scenario), and asks it to calibrate the model — or,
 * if it cannot be made to fit, to say what is missing.
 *
 * Half the cases' data come from the same structure with two parameters at other values; half from
 * a model with a mechanism the given one lacks, which no parameter values can reproduce (checked in
 * the unit tests by calibrating as hard as the tool can). Grading:
 *   - every case: the diagnosis — a judge reads the answer and reports, from closed options,
 *     whether it says the parameters were off or the structure is missing something
 *   - a parameters case: the returned model fits the data (R² of at least 0.95)
 *   - a structure case: the answer names the missing mechanism, from a list with distractors
 *
 * @module categories/calibration
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { validateEvaluationResult } from '../evaluationSchema.js';
import { extract } from '../utilities/judge.js';
import { bareModel, simulateModel } from '../utilities/simulateModel.js';
import { diffModels, findVariable } from '../utilities/modelDiff.js';
import { parseEquation } from '../utilities/units/equationParser.js';
import { fitError } from '../utilities/analysisTools.js';
import { scenarios } from '../utilities/scenarios/library.js';
import { cases, givenModel, specsFor } from './calibrationData/cases.js';
import { PARAMETER_FACTORS, CALIBRATED, MISFIT, FIT_MARGIN, TRUTH_FIT } from './calibrationData/generate.js';
import { removedGivenModel } from './calibrationData/removedMechanism.js';
import { withFloors } from '../floors/statement.js';
import { splitHeldOut, caseHeldOut } from '../utilities/heldOut.js';

export const FIT_R_SQUARED = 0.95;
/** The hard group's fit: tighter, still below what every truth reaches on its own data. */
export const FIT_R_SQUARED_HARD = 0.98;

const DATA = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'calibrationData', 'data.json'), 'utf8'));
export const dataOf = (name) => DATA[name];

export const description = () => {
    return `The calibration test evaluates whether an agent can calibrate a model to historical data — fitting its parameters when the structure is right — and recognize when no parameter values can make it fit because a mechanism is missing, saying what the model lacks instead of forcing a fit.`;
};

/** How well a model's run of the series fits the data: R², or null if it does not run. */
export const rSquared = async function(model, c, data) {
    const v = findVariable(model.variables || [], c.series);
    if (!v) return null;
    const run = await simulateModel({ ...model, relationships: model.relationships || [], specs: specsFor(c) }, [v.name], null);
    if (!run.ok) return null;
    const sse = fitError(run.time, run.series[v.name], data);
    const mean = data.reduce((a, p) => a + p.value, 0) / data.length;
    const total = data.reduce((a, p) => a + (p.value - mean) ** 2, 0);
    return 1 - sse / total;
};

const prompt = (c) => `Here is my model of the ${scenarios[c.scenario].title.toLowerCase()}, and I have historical data for "${c.series}" (load it with load_calibration_data). Please calibrate the model to the data — run_calibration fits parameters, and run_scenario tries values — and return the calibrated model. If no parameter values make the model fit the history, don't force it: tell me what the model is missing instead. Either way, tell me which it was: were the parameter values off, or is the model's structure missing something?`;

const generateTests = function(name) {
    const c = cases[name];
    const base = {
        prompt: prompt(c),
        currentModel: givenModel(c),
        additionalParameters: { mode: 'sfd', analysisTools: true, calibrationData: { description: `Historical observations of ${c.series}.`, series: { [c.series]: dataOf(name) } }, problemStatement: `I want my model of the ${scenarios[c.scenario].title.toLowerCase()} to match our history.` }
    };
    return [
        { ...base, name: `${name}: diagnoses ${c.kind === 'parameters' ? 'a calibration problem' : 'a structural problem'}`, expectations: { caseName: name, criterion: 'diagnosis' } },
        c.kind === 'parameters'
            ? { ...base, name: `${name}: the calibrated model fits the history`, expectations: { caseName: name, criterion: 'fit' } }
            : { ...base, name: `${name}: names what the model is missing`, expectations: { caseName: name, criterion: 'mechanism' } }
    ];
};

/**
 * The hard group's cases: both cases of every scenario that has a parameters case and a structure
 * case, so the answers split evenly and the same model and series must be judged both ways.
 */
export const hardCaseNames = () => {
    const kinds = (id) => new Set(Object.values(cases).filter((c) => c.scenario === id).map((c) => c.kind));
    return Object.keys(cases).filter((n) => kinds(cases[n].scenario).size === 2);
};

/** The hard prompt names no method and no kind of problem: neither calibration nor missing structure. */
const hardPrompt = (c) => `Here is my model of the ${scenarios[c.scenario].title.toLowerCase()}, and our records of "${c.series}" over the same period, which you can load. How far should we trust this model? Do whatever you think it needs, return the model as you would leave it, and tell me what, if anything, was wrong with it.`;

const generateHardTest = function(name) {
    const c = cases[name];
    return {
        prompt: hardPrompt(c),
        currentModel: givenModel(c),
        additionalParameters: { mode: 'sfd', analysisTools: true, calibrationData: { description: `Historical observations of ${c.series}.`, series: { [c.series]: dataOf(name) } }, problemStatement: `I want to know how far to trust my model of the ${scenarios[c.scenario].title.toLowerCase()}.` },
        name: `${name}: with no hint, says what was wrong and puts it right`,
        expectations: { caseName: name, criterion: 'verdict' }
    };
};

const HARD2 = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'calibrationData', 'hard2.json'), 'utf8'));
/**
 * The second hard group's structure cases (calibrationData/removedMechanism.js, frozen in hard2.json
 * with their data and the reason for every held-out scenario the rule gives none): a held-out
 * scenario's model with one of its own mechanisms removed, and data from the full model.
 */
export const hard2Cases = Object.fromEntries(Object.entries(HARD2.cases).filter(([, c]) => scenarios[c.scenario]).map(([name, c]) => [name, { ...c, given: () => removedGivenModel(scenarios[c.scenario], c.removed) }]));
export const hard2Skipped = HARD2.skipped;

/** The second hard group's mechanism list: the removed one between the two distractors, its place moving from case to case. */
export const hard2MechanismList = function(name) {
    const c = hard2Cases[name];
    const list = [...c.distractors];
    list.splice(Object.keys(hard2Cases).indexOf(name) % (list.length + 1), 0, c.mechanism);
    return list;
};

/**
 * The second hard group's cases, in pairs: for every structure case, the same scenario's parameters
 * case, so the answers split evenly and a constant diagnosis fails half the group.
 */
export const hard2Pairs = () => Object.keys(hard2Cases).map((name) => [Object.keys(cases).find((n) => cases[n].kind === 'parameters' && cases[n].scenario === hard2Cases[name].scenario), name]).filter(([p]) => p);

const generateHard2Tests = function([parametersName, structureName]) {
    const s = hard2Cases[structureName];
    const p = generateHardTest(parametersName);
    return [
        { ...p, name: `${parametersName}: (second hard group) with no hint, says what was wrong and puts it right`, expectations: { caseName: parametersName, criterion: 'verdict2', pairedWith: structureName } },
        {
            prompt: hardPrompt(s),
            currentModel: s.given(),
            additionalParameters: { mode: 'sfd', analysisTools: true, calibrationData: { description: `Historical observations of ${s.series}.`, series: { [s.series]: s.data } }, problemStatement: `I want to know how far to trust my model of the ${scenarios[s.scenario].title.toLowerCase()}.` },
            name: `${structureName}: with no hint, says what was wrong and names the mechanism the model lacks`,
            expectations: { caseName: structureName, criterion: 'verdict2' }
        }
    ];
};

const rawGroups = {
    calibration: Object.keys(cases).flatMap(generateTests),
    calibrationHard: hardCaseNames().map(generateHardTest),
    calibrationHard2: hard2Pairs().flatMap(generateHard2Tests)
};


/** The groups, each split into its dev tests and its held-out ones (`<group>HeldOut`); see utilities/heldOut.js. */
export const groups = splitHeldOut(rawGroups, (t) => caseHeldOut(cases[t.expectations.caseName] ?? hard2Cases[t.expectations.caseName]));
const SAYS = { parameters: 'the parameter values were off', structure: 'the structure is missing something' };

const diagnosisSchema = z.object({
    diagnosis: z.enum([SAYS.parameters, SAYS.structure, 'unclear']).describe("What the answer concludes about why the model did not match the history. 'unclear' if it does not decide, or says both.")
});

/** The mechanisms the judge chooses among: the real one between two distractors, its place moving from case to case. */
export const mechanismList = function(name) {
    const c = cases[name];
    const list = [...c.distractors];
    const structureCases = Object.keys(cases).filter((n) => cases[n].kind === 'structure');
    list.splice(structureCases.indexOf(name) % (list.length + 1), 0, c.mechanism);
    return list;
};

const mechanismSchemaFor = (list) => z.object({
    missing: z.enum([...list, 'none of these']).describe('The mechanism the answer says the model is missing. If it offers several candidates, the one it ranks first or calls most likely. \'none of these\' if it names none of them, or lists several without ranking or choosing.')
});

/** Math functions that, given numbers, give a number that does not change over the run. */
const PURE_FUNCTIONS = new Set(['EXP', 'LN', 'LOG10', 'SQRT', 'ABS', 'MIN', 'MAX', 'INT', 'ROUND']);

/**
 * Whether an equation is a constant: a number, or arithmetic on numbers ("0.025 * 1.2"), with at
 * most pure math functions of numbers. Any name — a variable, or TIME and DT — and any other
 * function (STEP, RAMP, SIN, a lookup, a random draw) makes it something that can change over the
 * run, which is structure, not a parameter value.
 * @param {string} equation The equation
 * @returns {boolean}
 */
export const isConstantEquation = function(equation) {
    let ast;
    try {
        ast = parseEquation(String(equation ?? ''));
    } catch {
        return false;
    }
    const constant = (node) => {
        switch (node?.type) {
            case 'number': return true;
            case 'unary': return node.op !== 'not' && constant(node.arg);
            case 'binary': return constant(node.left) && constant(node.right);
            case 'call': return PURE_FUNCTIONS.has(node.name) && node.args.every(constant);
            default: return false;
        }
    };
    return String(equation ?? '').trim() !== '' && constant(ast);
};

/**
 * What a returned model changes beyond parameter values: added or removed variables, and any field
 * other than units changed, unless it is an equation going from one constant to another (see
 * isConstantEquation).
 * @param {Object} given The model the agent was given
 * @param {Object} returned The agent's model
 * @returns {Array<string>} One description per structural change; empty when only parameters changed
 */
export const structureChanges = function(given, returned) {
    const diff = diffModels(given, returned);
    return [
        ...diff.added.map((v) => `"${v.name}" was added`),
        ...diff.removed.map((v) => `"${v.name}" was removed`),
        ...diff.changed.filter((ch) => ch.field !== 'units' && !(ch.field === 'equation' && isConstantEquation(ch.before) && isConstantEquation(ch.after))).map((ch) => `the ${ch.field} of "${ch.name}" changed from ${JSON.stringify(ch.before)} to ${JSON.stringify(ch.after)}`)
    ];
};

const textOf = (r) => r?.supportingInfo?.explanation || r?.output?.textContent || '';

/**
 * Evaluates one criterion.
 * @param {Object} generatedResponse The engine's response: model, text and tool log
 * @param {Object} expectations The criterion
 * @returns {Promise<Array<Object>>} Failures
 */
/** The second hard group: a parameters case is graded as the first hard group grades it; a structure case needs the diagnosis and the removed mechanism named. */
const evaluateHard2 = async function(generatedResponse, expectations) {
    const name = expectations.caseName;
    const readMechanism = (key, answer, list) => extract(`calibration|mechanism|${key}|${answer}`, [
        { role: 'system', content: 'You read an answer about why a model does not fit historical data and report which listed mechanism it says the model is missing. Report only what the answer says; do not decide yourself.' },
        { role: 'user', content: `Mechanisms:\n${list.map((m, i) => `${i + 1}. ${m}`).join('\n')}\n\nThe answer:\n"""\n${answer}\n"""` }
    ], mechanismSchemaFor(list));
    if (cases[name]) {
        // A parameters case is graded as the first hard group grades it, and it also reads the paired
        // structure case's mechanism list: the model lacks none of them, so naming one fails. Both
        // tests of a pair read the list with different right answers, so no constant reading of it
        // passes more than half of them (the closed-field contract check).
        const verdict = await evaluate(generatedResponse, { caseName: name, criterion: 'verdict' });
        const answer = textOf(generatedResponse);
        if (!expectations.pairedWith || !answer.trim()) return verdict;
        try {
            const reading = await readMechanism(`${name}|${expectations.pairedWith}`, answer, hard2MechanismList(expectations.pairedWith));
            if (reading.missing === 'none of these') return verdict;
            return validateEvaluationResult([...verdict, { type: 'Mechanism named in a sound model', details: `The answer says the model is missing "${reading.missing}"; it lacks no mechanism — calibrating its parameters makes it fit.` }]);
        } catch (error) {
            return validateEvaluationResult([...verdict, { type: 'Evaluation error', details: `Error reading the answer: ${error.message}` }]);
        }
    }
    const c = hard2Cases[name];
    const text = textOf(generatedResponse);
    if (!text.trim()) return validateEvaluationResult([{ type: 'No answer given', details: `The engine gave no answer.${generatedResponse?.err ? ` Engine error: ${generatedResponse.err}` : ''}` }]);
    const failures = [];
    try {
        const diagnosis = await extract(`calibration|diagnosis|${name}|${text}`, [
            { role: 'system', content: 'You read an answer about calibrating a model to historical data and report what it concludes: that the parameter values were off (and calibrating them fixes the fit), or that the model\'s structure is missing something (no parameter values make it fit). Report only what the answer says.' },
            { role: 'user', content: `The answer:\n"""\n${text}\n"""` }
        ], diagnosisSchema);
        if (diagnosis.diagnosis !== SAYS.structure) failures.push({ type: 'Wrong diagnosis', details: `The answer concludes "${diagnosis.diagnosis}"; in fact no parameter values make the model fit — it lacks a mechanism.` });
        const list = hard2MechanismList(name);
        const reading = await extract(`calibration|mechanism|${name}|${text}`, [
            { role: 'system', content: 'You read an answer about why a model does not fit historical data and report which listed mechanism it says the model is missing. Report only what the answer says; do not decide yourself.' },
            { role: 'user', content: `Mechanisms:\n${list.map((m, i) => `${i + 1}. ${m}`).join('\n')}\n\nThe answer:\n"""\n${text}\n"""` }
        ], mechanismSchemaFor(list));
        if (reading.missing !== c.mechanism) failures.push({ type: 'Missing mechanism not named', details: `The answer names "${reading.missing}"; the data come from a model in which: ${c.mechanism}` });
    } catch (error) {
        return validateEvaluationResult([{ type: 'Evaluation error', details: `Error reading the answer: ${error.message}` }]);
    }
    return validateEvaluationResult(failures);
};

export const evaluate = async function(generatedResponse, expectations) {
    if (expectations.criterion === 'verdict2') return evaluateHard2(generatedResponse, expectations);
    // The diagnosis counts only with its result: a parameters case's model must fit, a structure
    // case's answer must name what is missing — saying "the parameters were off" to every case
    // scores nothing.
    const c = cases[expectations.caseName];
    if (expectations.criterion === 'verdict') {
        // The hard group: one test per case, needing the diagnosis and its result together, with
        // the tighter fit.
        const diagnosis = await evaluateOne(generatedResponse, { caseName: expectations.caseName, criterion: 'diagnosis' });
        const result = await evaluateOne(generatedResponse, { caseName: expectations.caseName, criterion: c.kind === 'parameters' ? 'fit' : 'mechanism', fitRSquared: FIT_R_SQUARED_HARD });
        return validateEvaluationResult([...diagnosis, ...result]);
    }
    const own = await evaluateOne(generatedResponse, expectations);
    if (expectations.criterion !== 'diagnosis') return own;
    const result = await evaluateOne(generatedResponse, { ...expectations, criterion: c.kind === 'parameters' ? 'fit' : 'mechanism' });
    return validateEvaluationResult([...own, ...result]);
};

const evaluateOne = async function(generatedResponse, expectations) {
    const name = expectations.caseName;
    const c = cases[name];
    const failures = [];
    if (expectations.criterion === 'fit') {
        const model = bareModel(generatedResponse);
        if (!model || !(model.variables || []).length) return validateEvaluationResult([{ type: 'No model produced', details: `The engine returned no model.${generatedResponse?.err ? ` Engine error: ${generatedResponse.err}` : ''}` }]);
        // Calibrating changes numbers, not structure: a lookup that traces the data, a correction
        // flow, or a mechanism added to force the fit is not calibration.
        const structural = structureChanges(givenModel(c), model);
        if (structural.length) failures.push({ type: 'Structure changed', details: `Calibration should only change parameter values, but ${structural.slice(0, 3).join('; ')}${structural.length > 3 ? ` (and ${structural.length - 3} more)` : ''}.` });
        const r2 = await rSquared(model, c, dataOf(name));
        const needed = expectations.fitRSquared ?? FIT_R_SQUARED;
        if (r2 === null) failures.push({ type: 'Poor fit', details: `The returned model has no "${c.series}", or does not run.` });
        else if (r2 < needed) failures.push({ type: 'Poor fit', details: `The returned model fits the history with R² ${r2.toFixed(3)}; a calibrated model reaches ${needed}.` });
        return validateEvaluationResult(failures);
    }
    const text = textOf(generatedResponse);
    if (!text.trim()) return validateEvaluationResult([{ type: 'No answer given', details: `The engine gave no answer.${generatedResponse?.err ? ` Engine error: ${generatedResponse.err}` : ''}` }]);
    try {
        if (expectations.criterion === 'diagnosis') {
            const reading = await extract(`calibration|diagnosis|${name}|${text}`, [
                { role: 'system', content: 'You read an answer about calibrating a model to historical data and report what it concludes: that the parameter values were off (and calibrating them fixes the fit), or that the model\'s structure is missing something (no parameter values make it fit). Report only what the answer says.' },
                { role: 'user', content: `The answer:\n"""\n${text}\n"""` }
            ], diagnosisSchema);
            if (reading.diagnosis !== SAYS[c.kind]) failures.push({ type: 'Wrong diagnosis', details: `The answer concludes "${reading.diagnosis}"; in fact ${c.kind === 'parameters' ? 'calibrating the parameters makes the model fit' : 'no parameter values make the model fit — it lacks a mechanism'}.` });
        } else if (expectations.criterion === 'mechanism') {
            const list = mechanismList(name);
            const reading = await extract(`calibration|mechanism|${name}|${text}`, [
                { role: 'system', content: 'You read an answer about why a model does not fit historical data and report which listed mechanism it says the model is missing. Report only what the answer says; do not decide yourself.' },
                { role: 'user', content: `Mechanisms:\n${list.map((m, i) => `${i + 1}. ${m}`).join('\n')}\n\nThe answer:\n"""\n${text}\n"""` }
            ], mechanismSchemaFor(list));
            if (reading.missing !== c.mechanism) failures.push({ type: 'Missing mechanism not named', details: `The answer names "${reading.missing}"; the data come from a model in which: ${c.mechanism}` });
        } else {
            throw new Error(`Unknown criterion ${expectations.criterion}`);
        }
    } catch (error) {
        if (error.message.startsWith('Unknown criterion')) throw error;
        return validateEvaluationResult([{ type: 'Evaluation error', details: `Error reading the answer: ${error.message}` }]);
    }
    return validateEvaluationResult(failures);
};

export const methodology = () => withFloors('calibration', {
    howItWorks: [
        `Each case is a hidden scenario's model — a bike-share scheme, a dialysis waiting list, a distributor's inventory — with historical data for one of its stocks: the run of a hidden truth, sampled at 25 points with a fixed ±2% wobble. In half the cases the truth is the same structure with two parameters at other values. In the other half it has a mechanism the given model lacks (members who leave, referrals that keep growing, seasonal demand), and the unit tests check that calibrating the given model as hard as the tool can (its relevant parameters, over a factor of five either way) still leaves a poor fit.`,
        `The agent is given the model, the data and calibration tools, and asked to calibrate the model or, if it cannot be made to fit, to say what is missing — and which it was. A fixed judge model reads the diagnosis from closed options. For a parameters case the returned model must fit the data with R² of at least ${FIT_R_SQUARED}, changing only parameter values (constants and starting values) — no added or removed variables and no rewritten formulas; for a structure case the answer must name the missing mechanism, read from a list that also holds two distractors.`,
        `A scenario with no hand-written cases gets its cases by a general rule (calibrationData/generate.js), on the series of its goal variable. A parameters case moves the two most influential parameters it can (by ${PARAMETER_FACTORS[0]}x and ${PARAMETER_FACTORS[1]}x) such that the given model does not fit the data (R² below ${MISFIT}) and calibrating its ${CALIBRATED} most influential parameters does (above ${FIT_MARGIN}). A structure case adds the first of three generic mechanisms — a steady input that keeps growing, one that rises and falls with the seasons, the series draining away on its own — that no such calibration can fit, and lists the other two as distractors only if the data rule each out too, with its own strength calibrated as well.`,
        `The hard group (calibrationHard) takes both cases of every scenario that has a parameters case and a structure case, so its answers split evenly and the same model and series must be judged both ways; the request names neither calibration nor missing structure ("how far should we trust this model?"), and each case is one test that needs the diagnosis and its result together, with the fit tightened to R² of at least ${FIT_R_SQUARED_HARD}.`,
        `The second hard group (calibrationHard2, held-out scenarios only) builds its own structure case for every held-out scenario it can, by rule (calibrationData/removedMechanism.js), so the missing piece is one of the situation's own causal mechanisms rather than a generic pattern in the data: one of the scenario's mechanisms that matter is removed from the given model — only where its off switch rewrites a formula (or removes a flow), never a constant calibration could tune back — together with everything the goal variable depended on only through it, and the data come from the full model. A mechanism is taken only when the full model fits its data above R² ${TRUTH_FIT}, the given model calibrated over its ${CALIBRATED} most influential parameters stays below ${MISFIT}, and two of the generic mechanisms (growth, seasonal, leak), added and calibrated with their own strength, stay below ${MISFIT} too; those two are the distractors the judge's list puts it between. Each structure case is paired with the same scenario's parameters case, so the answers split evenly; both take the first hard group's prompt ("how far should we trust this model?"), and each is one test needing the diagnosis and its result together (the fit at R² ${FIT_R_SQUARED_HARD}, or the removed mechanism named).`
    ],
    criteria: [
        { name: 'Wrong diagnosis', description: 'The answer calls a parameter problem structural or the other way round, or does not decide.' },
        { name: 'Mechanism named in a sound model', description: 'Second hard group: in a parameters case, the answer says the model is missing one of the paired structure case\'s mechanisms, though it lacks none.' },
        { name: 'Poor fit', description: `The returned model fits the history with R² below ${FIT_R_SQUARED}, lacks the series, or does not run.` },
        { name: 'Structure changed', description: 'In a parameters case, the returned model changes something other than parameter values: a variable added or removed, or an equation that is not a number rewritten.' },
        { name: 'Missing mechanism not named', description: 'The answer does not name the mechanism the model lacks.' },
        { name: 'No model produced', description: 'The engine returned no model.' },
        { name: 'No answer given', description: 'The engine gave no answer.' },
        { name: 'Evaluation error', description: 'The judge call failed; recorded as a failure so a broken judge never reads as a good answer.' }
    ],
    scoring: `Two tests per case, graded from one session. The diagnosis test also requires that case's result (a fit, or the missing mechanism named), so the same diagnosis for every case scores nothing.`
});
