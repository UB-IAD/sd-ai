/**
 * This is the multiple perspectives test
 *
 * Group model building lives or dies on whether every stakeholder's view can be expressed. A tool
 * that quietly adopts one account and drops the other ends the conversation the model was meant to
 * start. This category puts two stakeholders' conflicting explanations in front of the agent and
 * checks that it keeps both, says they disagree, and proposes a way to find out who is right that
 * would actually tell them apart.
 *
 * Each test is built on a hidden scenario (evals/utilities/scenarios/library.js) with two
 * perspectives. Each perspective comes with a variant of the hidden model in which the world works
 * only the way that stakeholder says. Candidate experiments are run under both variants: an
 * experiment discriminates when its effect on the goal measure differs between them by a wide
 * margin (checked in the unit tests), and some candidates — a no-op — do not.
 *
 * The conversation: turn 1, the first stakeholder's account; turn 2, the second's, contradicting
 * it; turn 3, a request for a causal loop diagram both can work with, and for a way to find out
 * which of them is right.
 *
 * Grading, one criterion per test:
 *   - each perspective is kept: its causal path is in the diagram, or the answer keeps it as an
 *     alternative to test (a judge reads which); silently dropping it fails
 *   - the answer acknowledges that the two accounts disagree
 *   - the answer proposes at least one experiment that discriminates (read against a closed list of
 *     experiment kinds), and its proposals are not only ones that cannot tell the accounts apart
 *
 * @module categories/multiplePerspectives
 */

import { z } from 'zod';
import { validateEvaluationResult } from '../evaluationSchema.js';
import { extract } from '../utilities/judge.js';
import { graphFromLinks, pathPolarities, foldVariable, cldLinksFromResponse } from '../utilities/causalGraph.js';
import { scenarios } from '../utilities/scenarios/library.js';
import { withFloors } from '../floors/statement.js';
import { splitHeldOut, isHeldOutScenario } from '../utilities/heldOut.js';

export const description = () => {
    return `The multiple perspectives test evaluates whether an agent keeps every stakeholder's view in play rather than silently adopting one. Two stakeholders give conflicting explanations of a problem; the agent must keep both in its causal loop diagram or explicitly as alternatives, say that they disagree, and propose an experiment that — run in the hidden simulation under each account — would actually tell them apart.`;
};

const withPerspectives = Object.keys(scenarios).filter((id) => scenarios[id].perspectives);

const turnsFor = (s) => [
    `${s.perspectives[1].who} says: "${s.perspectives[1].account}"`,
    `We need a picture of this that both of them can work with. Please build, as the model, a causal loop diagram with a polarity on every link, using these names for the quantities you include: ${s.glossary.map((g) => `"${g}"`).join(', ')}. And tell us what we could try over the next few months to find out which of them is right.`
];

const generateTests = function(id) {
    const s = scenarios[id];
    const base = {
        prompt: `${s.opening} ${s.history} I've asked two people for their view. ${s.perspectives[0].who} says: "${s.perspectives[0].account}"`,
        currentModel: null,
        additionalParameters: { mode: 'cld', turns: turnsFor(s) }
    };
    const shared = { scenario: id, perspectives: s.perspectives.map((p) => `${p.who}: ${p.account}`), experiments: s.experiments.map((e) => e.text) };
    return [
        ...s.perspectives.map((p, i) => ({ ...base, name: `${s.title}: keeps the ${p.id}'s view`, expectations: { ...shared, criterion: 'kept', index: i, signature: p.signature, label: p.id } })),
        { ...base, name: `${s.title}: says the two views disagree`, expectations: { ...shared, criterion: 'disagreement' } },
        { ...base, name: `${s.title}: proposes a test that tells the views apart`, expectations: { ...shared, criterion: 'experiment', discriminates: s.experiments.map((e) => e.discriminates) } }
    ];
};

/** Who gives the hard group's third view. */
export const THIRD_WHO = 'Jo, who has worked here longest';

/**
 * The hard group's third view, by rule from the scenario's mechanisms: the first mechanism that
 * matters in the hidden simulation, has a causal signature, and is neither stakeholder's mechanism
 * nor their causal path. Jo puts it forward, in the scenario's own words for it, as what really
 * drives the problem. It is a real part of the hidden world, so a diagram both sides can work with
 * keeps it too. Null when the scenario has no such mechanism.
 * @param {Object} s A scenario from the library
 * @returns {{id: string, who: string, account: string, mechanism: string, signature: Object}|null}
 */
export const thirdViewOf = function(s) {
    const taken = new Set(s.perspectives.map((p) => p.mechanism));
    const samePath = (a, b) => foldVariable(a.from) === foldVariable(b.from) && foldVariable(a.to) === foldVariable(b.to);
    const m = s.mechanisms.find((x) => x.verdict === 'matters' && x.signature && !taken.has(x.id) && !s.perspectives.some((p) => samePath(p.signature, x.signature)));
    if (!m) return null;
    const fact = m.fact.charAt(0).toLowerCase() + m.fact.slice(1);
    return { id: 'third view', who: THIRD_WHO, account: `Neither of them has the whole story. What drives this, as I see it, is that ${fact}`, mechanism: m.id, signature: m.signature };
};

/** The views the hard test holds the answer to: the two stakeholders', and the third when the scenario supports one. */
export const hardViewsOf = (s) => [...s.perspectives, ...(thirdViewOf(s) ? [thirdViewOf(s)] : [])];

/**
 * The hard conversation's last turn asks for the diagram and then only what to do next: it does not
 * ask how to find out which stakeholder is right, nor say that they disagree. Before it, when the
 * scenario supports one, a third person puts forward a third view.
 */
const hardTurnsFor = (s) => [
    `${s.perspectives[1].who} says: "${s.perspectives[1].account}"`,
    ...(thirdViewOf(s) ? [`One more person weighed in. ${thirdViewOf(s).who}, says: "${thirdViewOf(s).account}"`] : []),
    `We need a picture of this that ${thirdViewOf(s) ? 'all of them' : 'both of them'} can work with. Please build, as the model, a causal loop diagram with a polarity on every link, using these names for the quantities you include: ${s.glossary.map((g) => `"${g}"`).join(', ')}. What should we do next?`
];

const generateHardTest = function(id) {
    const s = scenarios[id];
    const views = hardViewsOf(s);
    return {
        prompt: `${s.opening} ${s.history} I've asked two people for their view. ${s.perspectives[0].who} says: "${s.perspectives[0].account}"`,
        currentModel: null,
        additionalParameters: { mode: 'cld', turns: hardTurnsFor(s) },
        name: `${s.title}: (hard) keeps ${views.length > 2 ? 'all three' : 'both'} views, says they disagree and proposes a test that tells the stakeholders apart, unasked`,
        expectations: { scenario: id, criterion: 'hard', perspectives: views.map((p) => `${p.who}: ${p.account}`), experiments: s.experiments.map((e) => e.text) }
    };
};

const rawGroups = {
    multiplePerspectives: withPerspectives.flatMap(generateTests),
    multiplePerspectivesHard: withPerspectives.map(generateHardTest)
};


/** The groups, each split into its dev tests and its held-out ones (`<group>HeldOut`); see utilities/heldOut.js. */
export const groups = splitHeldOut(rawGroups, (t) => isHeldOutScenario(t.expectations.scenario));
export const disagreementSchema = z.object({
    acknowledgesDisagreement: z.enum(['yes', 'no']).describe("'yes' if, anywhere in these messages, the assistant treats the two views as competing explanations — says they conflict or disagree, that they cannot both be the whole story, or contrasts what each view predicts; 'no' if it presents them as simply compatible parts of one picture or ignores the difference")
});

export const readingSchema = z.object({
    perspectives: z.array(z.object({
        number: z.number().int().positive(),
        treatment: z.enum(['modeled', 'kept as an alternative', 'dismissed', 'not mentioned']).describe("How the answer treats this stakeholder's view: 'modeled' if it builds it into the diagram, 'kept as an alternative' if it keeps it as a hypothesis still to test, 'dismissed' if it rejects or overrides it, 'not mentioned' if it ignores it")
    })),
    experiments: z.array(z.object({
        number: z.number().int().positive(),
        proposed: z.enum(['yes', 'no']).describe("'yes' if the answer proposes anything of this kind — an intervention, a measurement, or a check of records that would show it")
    }))
});

const readingMessages = (text, e) => [
    { role: 'system', content: 'You read an assistant\'s answer to two stakeholders who disagree, and report how it treats each view and which kinds of experiment it proposes. Report only what the answer says.' },
    { role: 'user', content: `Views:\n${e.perspectives.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\nKinds of experiment:\n${e.experiments.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\nAnswer:\n"""\n${text}\n"""` }
];

/** A judge-cache key part that sets a reading against three views apart from one against two. */
const viewsKey = (e) => (e.perspectives.length > 2 ? `${e.perspectives.length} views|` : '');

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
    if (expectations.criterion === 'hard') {
        // Both views kept, the disagreement acknowledged and a discriminating test proposed, all at
        // once, each graded exactly as in its own test (keeping a view with its gate).
        const s = scenarios[expectations.scenario];
        const shared = { scenario: expectations.scenario, perspectives: expectations.perspectives, experiments: expectations.experiments };
        const failures = [];
        for (const [i, p] of hardViewsOf(s).entries()) failures.push(...(await evaluate(generatedResponse, { ...shared, criterion: 'kept', index: i, signature: p.signature, label: p.id })));
        failures.push(...(await evaluateOne(generatedResponse, { ...shared, criterion: 'disagreement' })));
        failures.push(...(await evaluateOne(generatedResponse, { ...shared, criterion: 'experiment', discriminates: s.experiments.map((e) => e.discriminates) })));
        const first = failures.find((f) => f.type === 'No response produced');
        return validateEvaluationResult(first ? [first] : failures);
    }
    // Keeping a view counts only if the diagram holds at least one of the views' causal paths, and
    // saying the views disagree counts only with a test that tells them apart: claiming every view
    // is kept, or that everything conflicts, scores nothing on its own.
    const own = await evaluateOne(generatedResponse, expectations);
    const extra = [];
    if (expectations.criterion === 'kept') {
        const graph = graphFromLinks(cldLinksFromResponse(generatedResponse));
        const has = (sig) => graph.names.has(foldVariable(sig.from)) && graph.names.has(foldVariable(sig.to)) && pathPolarities(graph, foldVariable(sig.from), foldVariable(sig.to), new Set()).has(sig.polarity);
        const sigs = scenarios[expectations.scenario].perspectives.map((p) => p.signature);
        if (!sigs.some(has)) extra.push({ type: 'View squashed', details: 'This test counts only when the diagram holds at least one of the views\' causal paths; it holds neither.' });
    }
    if (expectations.criterion === 'disagreement') {
        const sibling = rawGroups.multiplePerspectives.find((t) => t.expectations.scenario === expectations.scenario && t.expectations.criterion === 'experiment');
        if (sibling) extra.push(...(await evaluateOne(generatedResponse, sibling.expectations)));
    }
    return extra.length ? validateEvaluationResult([...own, ...extra]) : own;
};

const evaluateOne = async function(generatedResponse, expectations) {
    if (generatedResponse?.err) return validateEvaluationResult([{ type: 'No response produced', details: `The engine failed: ${generatedResponse.err}` }]);
    if (!Array.isArray(generatedResponse?.transcript)) return validateEvaluationResult([{ type: 'No response produced', details: 'The response has no transcript; this category needs the test-agent-converse engine.' }]);
    const text = finalAnswer(generatedResponse);
    if (!text.trim()) return validateEvaluationResult([{ type: 'No response produced', details: 'The agent gave no final answer.' }]);
    let reading;
    try {
        reading = await extract(`multiplePerspectives|${viewsKey(expectations)}${expectations.scenario}|${text}`, readingMessages(text, expectations), readingSchema);
    } catch (error) {
        return validateEvaluationResult([{ type: 'Evaluation error', details: `Error reading the answer: ${error.message}` }]);
    }
    const failures = [];
    switch (expectations.criterion) {
        case 'kept': {
            const { from, to, polarity } = expectations.signature;
            const graph = graphFromLinks(cldLinksFromResponse(generatedResponse));
            const inDiagram = graph.names.has(foldVariable(from)) && graph.names.has(foldVariable(to)) && pathPolarities(graph, foldVariable(from), foldVariable(to), new Set()).has(polarity);
            const treatment = (reading.perspectives || []).find((p) => p.number === expectations.index + 1)?.treatment ?? 'not mentioned';
            // In the diagram counts only when the answer does not also dismiss the view: a link any
            // reasonable diagram contains is not keeping a view the text throws out.
            if (!((inDiagram && treatment !== 'dismissed') || treatment === 'kept as an alternative')) {
                failures.push({ type: 'View squashed', details: `The ${expectations.label}'s view is neither in the diagram (no path from "${from}" to "${to}" with polarity ${polarity}) nor kept as an alternative to test; the answer ${treatment === 'dismissed' ? 'dismisses it' : treatment === 'modeled' ? 'says it is modeled, but the diagram does not contain it' : 'does not deal with it'}.` });
            }
            break;
        }
        case 'disagreement': {
            // Read over the whole conversation: an agent usually remarks on the conflict when the
            // second stakeholder contradicts the first, not only in its final answer.
            const all = (generatedResponse.transcript || []).filter((t) => t.role === 'agent').map((t) => t.text).join('\n\n---\n\n');
            let seen;
            try {
                seen = await extract(`multiplePerspectives|disagreement|${viewsKey(expectations)}${expectations.scenario}|${all}`, [
                    { role: 'system', content: expectations.perspectives.length > 2
                        ? 'You read an assistant\'s messages in a conversation where several stakeholders gave different explanations, and report one thing: whether the assistant treats the views as competing explanations. Report only what the messages show.'
                        : 'You read an assistant\'s messages in a conversation where two stakeholders gave different explanations, and report one thing: whether the assistant treats the two views as competing explanations. Report only what the messages show.' },
                    { role: 'user', content: `Views:\n${expectations.perspectives.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\nThe assistant's messages:\n${all}` }
                ], disagreementSchema);
            } catch (error) {
                failures.push({ type: 'Evaluation error', details: `Error reading the conversation: ${error.message}` });
                break;
            }
            if (seen.acknowledgesDisagreement !== 'yes') failures.push({ type: 'Disagreement not acknowledged', details: 'Nowhere in the conversation does the agent treat the two views as competing explanations.' });
            break;
        }
        case 'experiment': {
            const proposed = (reading.experiments || []).filter((x) => x.proposed === 'yes').map((x) => x.number - 1);
            if (!proposed.some((i) => expectations.discriminates[i])) {
                failures.push({ type: 'No discriminating test', details: `The answer proposes nothing that would tell the two views apart. Kinds that would: ${expectations.experiments.filter((_, i) => expectations.discriminates[i]).join(' / ')}` });
            }
            // Offering a test both views predict the same result for, as a way to tell them apart,
            // is not knowing which tests discriminate: proposing everything scores nothing.
            const decoys = proposed.filter((i) => !expectations.discriminates[i]);
            if (decoys.length) failures.push({ type: 'No discriminating test', details: `The answer also proposes ${decoys.map((i) => `"${expectations.experiments[i]}"`).join(', ')}, which both views predict the same result for.` });
            break;
        }
        default:
            throw new Error(`Unknown criterion ${expectations.criterion}`);
    }
    return validateEvaluationResult(failures);
};

export const methodology = () => withFloors('multiplePerspectives', {
    howItWorks: [
        `Each test is built on a hidden scenario with two stakeholders who explain the same problem differently — for example, a clinical director who blames the nine-month wait for new chairs, and a patient coordinator who blames patients returning in a wave. Each view comes with a variant of the hidden model in which the world works only the way that stakeholder says.`,
        `The conversation has three turns: the first stakeholder's account (with the history), the second's, contradicting it, and a request for a causal loop diagram both can work with plus a way to find out who is right.`,
        `Candidate experiments are run in the hidden simulation under both variants. One discriminates when its effect on the problem measure differs between the two by at least 25 points — pausing chair orders changes the waiting list enormously in one account and not at all in the other — and some candidates, such as changing the reception desk's hours, cannot tell them apart. The unit tests check every candidate's label.`,
        `A fixed judge model reads the final answer against closed lists — the two views and the kinds of experiment — and reports how the answer treats each view and which kinds of experiment it proposes. A second reading, over all the agent's messages, reports whether it treats the two views as competing explanations: saying they conflict, that they cannot both be the whole story, or contrasting what each predicts. A view is kept if its causal path is in the diagram (with the right sign) or the answer keeps it as an alternative to test.`,
        `Hard group (multiplePerspectivesHard): every scenario again, with a last turn that asks for the diagram and then only "what should we do next?" — not how to find out who is right, nor that they disagree — and one test that needs every view kept, the disagreement acknowledged and a test that tells the two stakeholders apart (and none that cannot) proposed, all at once. A third view joins wherever the scenario supports one by rule — the first mechanism that matters in the hidden simulation, with a causal path, that is neither stakeholder's — put forward by a third person as what really drives the problem, and it must be kept too (${withPerspectives.filter((id) => thirdViewOf(scenarios[id])).length} of ${withPerspectives.length} scenarios; ${withPerspectives.filter((id) => !thirdViewOf(scenarios[id])).map((id) => scenarios[id].title.toLowerCase()).join(' and ')} ${withPerspectives.filter((id) => !thirdViewOf(scenarios[id])).length === 1 ? 'has' : 'have'} no such mechanism and keep two views).`
    ],
    criteria: [
        { name: 'View squashed', description: 'A stakeholder\'s view is neither in the diagram nor kept as an alternative: it was dropped or dismissed.' },
        { name: 'Disagreement not acknowledged', description: 'Nowhere in the conversation does the agent treat the two views as competing explanations (saying they conflict, that they cannot both be the whole story, or contrasting what each predicts).' },
        { name: 'No discriminating test', description: 'The answer proposes no experiment that would tell the views apart.' },
        { name: 'No response produced', description: 'The engine failed, returned no transcript, or the agent gave no final answer.' },
        { name: 'Evaluation error', description: 'The judge call failed; recorded as a failure so a broken judge never reads as a good answer.' }
    ],
    scoring: `One criterion per test, all graded from one conversation per scenario; in the hard group, one test per scenario with every criterion graded together. Keeping a view counts only when the diagram holds at least one view's causal path; saying the views disagree counts only with a passing experiment test; proposing a test both views predict alike fails the experiment test.`
});
