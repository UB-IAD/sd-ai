/**
 * What the hard groups of the model-repair categories (guidedCorrection, mece, formulationCritique,
 * extremeConditions, unitConsistency, mentalModelVsBug) share.
 *
 * A hard group is built by general rules — difficulty levers — never by picking cases an agent
 * failed:
 *   - several faults at once, of different kinds the category's generators already know
 *   - no hint: the request does not name the kind of problem (READY_PROMPT)
 *   - a clean-model control: the same request on the correct model, where the right answer is that
 *     nothing needs fixing, graded as "the model is left behaving as it did, and the response says
 *     it needs no fixing" (cleanVerdictFailure)
 *   - the full scenario model rather than a small one
 * Which of a category's eligible cases make the group is a rule too (pickHard): the first dev case
 * and the first two held-out ones in the order the category lists them; the clean control is run
 * on the first dev and the first held-out of those. Held-out scenarios of a later batch (written
 * after Phase 2's runs, `batch` 2 in the scenario library) are not counted toward the two: every
 * eligible case from them joins the group as well, so adding them leaves every case picked before
 * picked and unchanged, and adds only their own.
 *
 * @module categories/guidedCorrectionData/hardShared
 */

import { z } from 'zod';
import { extract } from '../../utilities/judge.js';
import { caseHeldOut, laterBatch } from '../../utilities/heldOut.js';

/** How many eligible dev and held-out cases a hard group takes, and how many get a clean control. */
export const HARD_PICK = { dev: 1, heldOut: 2, cleanDev: 1, cleanHeldOut: 1 };

/**
 * The hard request: it asks whether the model is ready and to fix what needs it, naming no kind of
 * problem. `extra` adds a sentence a category needs (the tools at hand, say), never a hint.
 */
export const readyPrompt = (description, extra) => `Is my model of ${description} ready to use for policy analysis? Fix anything that needs it and explain what you changed and why — or, if nothing needs changing, say so and leave the model as it is.${extra ? ` ${extra}` : ''} Keep the existing variable names and return the complete model.`;

/**
 * The hard cases a group takes, by the rule above.
 * @param {Object<string, Object>} hardCases Every eligible hard case, in the category's order
 * @param {function(Object): boolean} [admit] What a later-batch case must meet to join: an invariant
 *   the category's tests assert of every case its group takes
 * @returns {{faulty: Array<string>, clean: Array<string>}} Case names
 */
export const pickHard = function(hardCases, admit) {
    const names = Object.keys(hardCases);
    const dev = names.filter((n) => !caseHeldOut(hardCases[n])).slice(0, HARD_PICK.dev);
    const held = names.filter((n) => caseHeldOut(hardCases[n]) && !laterBatch(hardCases[n])).slice(0, HARD_PICK.heldOut);
    // A later-batch case joins only if it meets what the category's own tests assert of every case
    // the group takes (`admit`); every first-batch case already does, so none of them can move.
    const later = names.filter((n) => caseHeldOut(hardCases[n]) && laterBatch(hardCases[n]) && (!admit || admit(hardCases[n])));
    return { faulty: [...dev, ...held, ...later], clean: [...dev.slice(0, HARD_PICK.cleanDev), ...held.slice(0, HARD_PICK.cleanHeldOut)] };
};

export const CLEAN_VERDICTS = {
    problems: 'the response says the model had problems that needed fixing',
    ready: 'the response says the model is ready to use as it is, with nothing that needed fixing',
    silent: 'the response does not say either way'
};

/**
 * The closed reading of a clean-control answer. Its options are ordered so that neither the most
 * assertive reading (the first option) nor the most noncommittal one (the last) is the right answer.
 */
export const cleanVerdictSchema = z.object({
    verdict: z.enum([CLEAN_VERDICTS.problems, CLEAN_VERDICTS.ready, CLEAN_VERDICTS.silent]).describe("What the response concludes about the model. Optional suggestions for later do not count as problems; a change the response says it made to correct something does.")
});

/** The failure types a clean control adds to a category. */
export const CLEAN_CRITERIA = [
    { name: 'Correct model changed', description: 'In a clean control (the hard request on the correct model), the returned model no longer behaves like the correct one, or no longer passes the check the category grades by.' },
    { name: 'Problem reported in a correct model', description: 'In a clean control, the response does not say the model is ready as it is: it reports problems the model does not have, or does not say.' }
];

/**
 * Whether a clean-control answer says the model needs no fixing, read by the judge.
 * @param {string} cacheKey The judge cache key
 * @param {string} description What the model is of
 * @param {string} text The response's explanation
 * @returns {Promise<Object|null>} A failure, or null when it says the model is ready
 */
export const cleanVerdictFailure = async function(cacheKey, description, text) {
    if (!String(text || '').trim()) return { type: 'Problem reported in a correct model', details: 'The response gave no explanation, so it never says the model is ready.' };
    let reading;
    try {
        reading = await extract(cacheKey, [
            { role: 'system', content: 'You read a response to a modeler who asked whether their model is ready to use and to fix anything that needs it. Report what the response concludes about the model. Report only what it says; do not judge whether it is right.' },
            { role: 'user', content: `The model is of ${description}.\n\nThe response:\n"""\n${text}\n"""` }
        ], cleanVerdictSchema);
    } catch (error) {
        return { type: 'Evaluation error', details: `Error reading the response: ${error.message}` };
    }
    return reading?.verdict === CLEAN_VERDICTS.ready ? null : { type: 'Problem reported in a correct model', details: `The model has nothing that needs fixing, but the reading of the response is "${reading?.verdict}".` };
};

/** The text of a response a judge reads. */
export const responseText = (r) => r?.supportingInfo?.explanation || r?.output?.textContent || '';
