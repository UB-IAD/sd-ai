/**
 * This is the archetypes test
 *
 * Many problems fit one of a handful of classic system archetypes — a fix that backfires, growth
 * that runs into a limit, a quick fix that crowds out the real solution — and recognizing the
 * archetype tells a modeler which loops to look for and which interventions tend to work. This
 * category tells the agent a situation in a manager's words, never naming an archetype or using
 * modeling vocabulary, and asks for a causal loop diagram and the archetype it fits.
 *
 * Grading, per situation:
 *   - the archetype: a judge reads the answer and reports, from the closed list of archetypes,
 *     which one it names; it must be the right one
 *   - one test per loop of the archetype's signature: the diagram has a loop of the right polarity
 *     through the loop's core quantities, passing through no named quantity that is off that loop
 *
 * @module categories/archetypes
 */

import { z } from 'zod';
import { validateEvaluationResult } from '../evaluationSchema.js';
import { extract } from '../utilities/judge.js';
import { graphFromLinks, findCycles, cldLinksFromResponse } from '../utilities/causalGraph.js';
import { matchingLoops } from './referenceModes.js';
import { ARCHETYPES, cases, HELD_OUT_ARCHETYPES, DISTRACTOR_OF } from './archetypesData/cases.js';
import { withFloors } from '../floors/statement.js';
import { splitHeldOut, caseHeldOut } from '../utilities/heldOut.js';

export const CYCLE_CAP = 5000;

export const description = () => {
    return `The archetypes test evaluates whether an agent recognizes which classic system archetype a situation fits — told in a manager's words, with no archetype named — and draws a causal loop diagram containing the archetype's loops with the right polarities.`;
};

const prompt = (c) => `${c.narrative}\n\nPlease draw a causal loop diagram of what is going on, using these names for the quantities: ${c.glossary.join(', ')}. Then tell me whether this situation fits one of the classic system archetypes, and if so which one fits best and why.`;

const generateTests = function(name) {
    const c = cases[name];
    const base = { prompt: prompt(c), currentModel: { variables: [], relationships: [] }, additionalParameters: { mode: 'cld', problemStatement: c.narrative.split('. ')[0] + '.' } };
    return [
        { ...base, name: `${name}: identifies the archetype`, expectations: { caseName: name, criterion: 'archetype' } },
        ...c.loops.map((loop) => ({ ...base, name: `${name}: the diagram has the ${loop.id} loop`, expectations: { caseName: name, criterion: 'loop', loop: loop.id } }))
    ];
};

/** The hard group's cases, by rule: the situations whose archetype has the most loops (four or more). */
export const HARD_MIN_LOOPS = 4;
export const hardCaseNames = Object.keys(cases).filter((n) => cases[n].loops.length >= HARD_MIN_LOOPS);

/**
 * The hard prompt asks for no archetype and names no method beyond the diagram: the manager asks
 * what is going on and what to watch out for. The situation is told with a distractor archetype's
 * surface features (DISTRACTOR_OF in archetypesData/cases.js): after the narrative, someone's
 * reading of it in the terms of the archetype most easily mistaken for it.
 */
export const hardPrompt = (c) => `${c.narrative} ${c.distractor}\n\nPlease draw a causal loop diagram of this, using these names for the quantities: ${c.glossary.join(', ')}. What's going on here, and what would you watch out for?`;

const generateHardTest = (name) => {
    const c = cases[name];
    return {
        prompt: hardPrompt(c),
        currentModel: { variables: [], relationships: [] },
        additionalParameters: { mode: 'cld', problemStatement: c.narrative.split('. ')[0] + '.' },
        name: `${name}: (hard) names the archetype and draws every one of its ${c.loops.length} loops`,
        expectations: { caseName: name, criterion: 'hard' }
    };
};

const rawGroups = {
    archetypes: Object.keys(cases).flatMap(generateTests),
    archetypesHard: hardCaseNames.map(generateHardTest)
};


/** The groups, each split into its dev tests and its held-out ones (`<group>HeldOut`); see utilities/heldOut.js. */
export const groups = splitHeldOut(rawGroups, (t) => caseHeldOut(cases[t.expectations.caseName]));
const archetypeSchema = z.object({
    archetype: z.enum([...ARCHETYPES, 'none or several']).describe("The archetype the answer says fits best, in any wording ('a fix that backfires' is Fixes that Fail). 'none or several' if it names none, or several without choosing.")
});

/**
 * Evaluates one criterion.
 * @param {Object} generatedResponse The engine's response
 * @param {Object} expectations The criterion
 * @returns {Promise<Array<Object>>} Failures
 */
export const evaluate = async function(generatedResponse, expectations) {
    const c = cases[expectations.caseName];
    const failures = [];
    if (expectations.criterion === 'hard') {
        // The archetype and every loop, graded together, each exactly as in its own test.
        // The hard prompt asks for no archetype, so the answer may describe one without its name.
        for (const part of [{ criterion: 'archetype', described: true }, ...c.loops.map((l) => ({ criterion: 'loop', loop: l.id }))]) {
            failures.push(...(await evaluate(generatedResponse, { caseName: expectations.caseName, ...part })));
        }
        return validateEvaluationResult(failures);
    }
    if (expectations.criterion === 'archetype') {
        const text = generatedResponse?.supportingInfo?.explanation || generatedResponse?.output?.textContent || '';
        if (!text.trim()) return validateEvaluationResult([{ type: 'Archetype not identified', details: `The engine gave no explanation.${generatedResponse?.err ? ` Engine error: ${generatedResponse.err}` : ''}` }]);
        let reading;
        try {
            reading = await extract(`archetypes|${expectations.described ? 'described|' : ''}${expectations.caseName}|${text}`, [
                { role: 'system', content: expectations.described
                    ? 'You read an answer about a situation and report which classic system archetype the answer says it fits best, by name or by describing its defining structure in its own words (several users each overusing one shared resource for their own gain until it fails them all is Tragedy of the Commons). Report an archetype only if the answer names it or states its defining structure; do not decide yourself from the situation.'
                    : 'You read an answer about a situation and report which classic system archetype the answer says it fits best. Report only what the answer says; do not decide yourself.' },
                { role: 'user', content: `Archetypes: ${ARCHETYPES.join('; ')}\n\nAnswer:\n"""\n${text}\n"""` }
            ], archetypeSchema);
        } catch (error) {
            return validateEvaluationResult([{ type: 'Evaluation error', details: `Error reading the answer: ${error.message}` }]);
        }
        if (reading.archetype !== c.archetype) failures.push({ type: 'Archetype not identified', details: `The answer names "${reading.archetype}"; the situation is ${c.archetype}.` });
        return validateEvaluationResult(failures);
    }
    if (expectations.criterion !== 'loop') throw new Error(`Unknown criterion ${expectations.criterion}`);
    const links = cldLinksFromResponse(generatedResponse);
    if (!links.length) return validateEvaluationResult([{ type: 'No diagram produced', details: `The engine returned no causal links.${generatedResponse?.err ? ` Engine error: ${generatedResponse.err}` : ''}` }]);
    const loop = c.loops.find((l) => l.id === expectations.loop);
    const candidates = matchingLoops(findCycles(graphFromLinks(links), CYCLE_CAP), loop, c.glossary);
    if (!candidates.some((x) => x.polarity === loop.polarity)) {
        failures.push({
            type: 'Archetype loop missing',
            details: candidates.length
                ? `The diagram has a loop through ${candidates[0].nodes.join(' -> ')} but with the wrong polarity; the ${loop.id} loop is ${loop.polarity === '+' ? 'reinforcing' : 'balancing'}.`
                : `No loop in the diagram runs through ${loop.core.join(' and ')} along the ${loop.id} loop (${loop.variables.join(', ')}).`
        });
    }
    return validateEvaluationResult(failures);
};

export const methodology = () => withFloors('archetypes', {
    howItWorks: [
        `Each situation is told in a manager's words, with no archetype named and no modeling vocabulary (checked by the unit tests), and fits one classic archetype — for example machines whose maintenance is cut to catch up on output (Fixes that Fail), a restaurant whose bookings stall as the wait grows (Limits to Growth), two villages fishing one lake (Tragedy of the Commons). Every one of the ${ARCHETYPES.length} archetypes has one or two situations, ${Object.keys(cases).length} in all, ${HELD_OUT_ARCHETYPES.length} of them held out: written after this grader was frozen, at least one for every archetype, in settings the dev cases do not use (a hospital ward, a school orchestra, a vegetable-box co-op, a software support team, a local newspaper, a coding bootcamp, a building firm, two resorts sharing a reef, two town councils), and never used to tune it, so dev and held-out results can be compared within each archetype.`,
        `The agent is asked for a causal loop diagram in the situation's own names and for the archetype it fits best. A fixed judge model reads the answer and reports, from the closed list of ${ARCHETYPES.length} archetypes, which one it names. Each loop of the archetype is a test: the diagram must have a loop of the same polarity through the loop's core quantities, passing through no named quantity that is off that loop (intermediate quantities the agent adds are allowed). The unit tests check every loop and polarity against a reference diagram.`,
        `Hard group (archetypesHard): the situations whose archetype has ${HARD_MIN_LOOPS} or more loops (${hardCaseNames.length}: ${hardCaseNames.filter((n) => !cases[n].heldOut).length} dev, ${hardCaseNames.filter((n) => cases[n].heldOut).length} held out), each told with a distractor archetype's surface features — after the narrative, someone's reading of the situation in the terms of the archetype most easily mistaken for it (${Object.entries(DISTRACTOR_OF).map(([a, d]) => `${d} for ${a}`).join(', ')}), adding no fact — with a prompt that asks for the diagram and then only "what's going on here, and what would you watch out for?" — no archetype asked for — and one test that needs the archetype named and every one of its loops drawn, all at once.`
    ],
    criteria: [
        { name: 'Archetype not identified', description: 'The answer names another archetype, none, or several without choosing.' },
        { name: 'Archetype loop missing', description: 'The diagram has no loop of the right polarity through the loop\'s core quantities.' },
        { name: 'No diagram produced', description: 'The engine returned no causal links.' },
        { name: 'Evaluation error', description: 'The judge call failed; recorded as a failure so a broken judge never reads as a good answer.' }
    ],
    scoring: `One archetype test and one test per loop for each situation, graded from one generation; in the hard group, one test per situation with the archetype and every loop graded together.`
});
