import { groupTests } from '../../../evals/utilities/heldOut.js';
import { jest } from '@jest/globals';

let reading = null;
jest.unstable_mockModule('../../../evals/utilities/judge.js', () => ({
    extract: async () => reading,
    clearJudgeCache: () => {}
}));

const { evaluate, groups, methodology, userScriptFor, releasedFacts, hardIds, hardBudget, matteringFacts, HARD_MIN_FACTS, MAX_FACTS_PER_TURN } = await import('../../../evals/categories/elicitation.js');
const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');

const testsFor = (id) => groupTests(groups, 'elicitation').filter((t) => t.expectations.scenario === id);
const run = async (tests, response) => {
    const out = {};
    for (const t of tests) out[t.name] = (await evaluate(response, t.expectations)).map((f) => f.type);
    return out;
};

/** A conversation in which the agent learned `factIds`, then built `links` and wrote a summary. */
const conversation = (factIds, links) => ({
    transcript: [
        { role: 'user', turn: 1, text: 'opening' },
        { role: 'agent', turn: 1, text: 'questions?', factsReleasedAfter: factIds },
        { role: 'user', turn: 2, text: 'answers' },
        { role: 'agent', turn: 2, text: 'FINAL SUMMARY' }
    ],
    model: { variables: [], relationships: links }
});
const signatureLinks = (s) => s.mechanisms.filter((m) => m.verdict === 'matters' && m.signature).map((m) => ({ from: m.signature.from, to: m.signature.to, polarity: m.signature.polarity }));
const allFactIds = (s) => userScriptFor(s).facts.map((f) => f.id);
const placements = (s, insideOutside) => {
    const points = [...s.mechanisms.filter((m) => m.verdict !== 'ambiguous').map((m) => m.fact), ...s.outsideFacts.map((o) => o.text)];
    return { points: points.map((p, i) => ({ number: i + 1, placement: insideOutside(p) })) };
};

describe('elicitation category', () => {
    test('the scripted user knows the history, every mechanism and the outside facts, and has sane limits', () => {
        for (const s of Object.values(scenarios)) {
            const script = userScriptFor(s);
            expect(script.facts.map((f) => f.id)).toEqual(['history', ...s.mechanisms.map((m) => `mechanism:${m.id}`), ...s.outsideFacts.map((_, i) => `outside:${i}`)]);
            expect(script.maxQuestionTurns).toBeGreaterThan(0);
            expect(script.maxFactsPerTurn).toBeGreaterThan(0);
            for (const f of script.facts) expect(f.topic.length).toBeGreaterThan(3);
        }
    });

    test('the opening gives away no mechanism', () => {
        for (const s of Object.values(scenarios)) {
            const prompt = testsFor(s.id)[0].prompt;
            for (const m of s.mechanisms) expect(prompt).not.toContain(m.fact);
            expect(prompt).not.toContain(s.history);
        }
    });

    test('every failure type is documented', () => {
        expect(methodology().criteria.map((c) => c.name)).toEqual(expect.arrayContaining(['Not elicited', 'Mechanism missing from diagram', 'Boundary wrong', 'No response produced', 'Evaluation error']));
    });

    describe.each(Object.keys(scenarios))('%s', (id) => {
        const s = scenarios[id];
        const outsideTexts = new Set(s.outsideFacts.map((o) => o.text));

        const irrelevantTexts = new Set(s.mechanisms.filter((m) => m.verdict === 'irrelevant').map((m) => m.fact));
        test('an agent that asks about everything, models what matters and leaves the rest out passes', async () => {
            reading = placements(s, (p) => (outsideTexts.has(p) || irrelevantTexts.has(p) ? 'outside' : 'inside'));
            const results = await run(testsFor(id), conversation(allFactIds(s), signatureLinks(s)));
            expect(Object.entries(results).filter(([, t]) => t.length)).toEqual([]);
        });

        test('an agent that never asks fails every test: keeping things outside the boundary counts only once something that matters was drawn out', async () => {
            reading = placements(s, () => 'not mentioned');
            const results = await run(testsFor(id), conversation([], []));
            for (const t of testsFor(id)) expect([t.name, results[t.name].length > 0]).toEqual([t.name, true]);
        });

        test('putting an outside fact it heard inside the boundary is caught', async () => {
            reading = placements(s, () => 'inside');
            const results = await run(testsFor(id).filter((t) => t.expectations.criterion === 'boundary' && !t.expectations.include), conversation(allFactIds(s), signatureLinks(s)));
            for (const types of Object.values(results)) expect(types).toEqual(['Boundary wrong']);
        });
    });

    test('a diagram with the right links but no questions asked fails the diagram tests', async () => {
        const s = scenarios.dialysisClinic;
        const results = await run(testsFor('dialysisClinic').filter((t) => t.expectations.criterion === 'signature'), conversation([], signatureLinks(s)));
        for (const types of Object.values(results)) expect(types).toEqual(['Mechanism missing from diagram']);
    });

    test('the boundary is read from the reply to the closing request, not from a later reply to the harness nudge', async () => {
        const calls = [];
        const s = scenarios.dialysisClinic;
        reading = placements(s, () => 'inside');
        const response = conversation(allFactIds(s), signatureLinks(s));
        response.transcript.push({ role: 'user', turn: 3, text: 'nudge', synthetic: 'modelNotWritten' }, { role: 'agent', turn: 3, text: 'REPLY TO NUDGE' });
        const t = testsFor('dialysisClinic').find((x) => x.expectations.criterion === 'boundary' && x.expectations.include);
        expect(await evaluate(response, t.expectations)).toEqual([]);
    });

    test('released facts are read from every agent turn in the transcript', () => {
        const r = releasedFacts({ transcript: [{ role: 'agent', factsReleasedAfter: ['a'] }, { role: 'user' }, { role: 'agent', factsReleasedAfter: ['b', 'c'] }] });
        expect([...r].sort()).toEqual(['a', 'b', 'c']);
    });

    test('a response without a transcript says which engine the category needs', async () => {
        const failures = await evaluate({ model: {} }, testsFor('bikeShare')[0].expectations);
        expect(failures[0].details).toMatch(/test-agent-converse/);
    });

    describe('hard group: a question budget below the facts that matter, every criterion in one test', () => {
        const hard = groupTests(groups, 'elicitationHard');
        const hardTest = (id) => hard.find((t) => t.expectations.scenario === id);

        test('the rule takes every scenario with four or more facts that matter, dev and held out, one test each', () => {
            expect(hardIds).toEqual(Object.keys(scenarios).filter((id) => matteringFacts(scenarios[id]).length >= HARD_MIN_FACTS));
            expect(hard.map((t) => t.expectations.scenario)).toEqual(hardIds);
            expect(groups.elicitationHard.length).toBeGreaterThan(0);
            expect(groups.elicitationHardHeldOut.length).toBeGreaterThan(0);
        });

        test('the budget is fewer rounds than facts that matter, but enough to draw them all out; the prompt gives away nothing', () => {
            for (const id of hardIds) {
                const s = scenarios[id];
                const t = hardTest(id);
                const n = matteringFacts(s).length;
                expect(t.additionalParameters.userScript.maxQuestionTurns).toBe(hardBudget(s));
                expect([id, hardBudget(s) < n, hardBudget(s) * MAX_FACTS_PER_TURN >= n]).toEqual([id, true, true]);
                expect({ ...t.additionalParameters.userScript, maxQuestionTurns: 0 }).toEqual({ ...userScriptFor(s), maxQuestionTurns: 0 });
                for (const m of s.mechanisms) expect(t.prompt).not.toContain(m.fact);
                expect(t.prompt).not.toContain(s.history);
                expect(t.prompt).not.toMatch(/ask me whatever/i);
            }
        });

        describe.each(hardIds)('%s', (id) => {
            const s = scenarios[id];
            const outsideTexts = new Set(s.outsideFacts.map((o) => o.text));
            const irrelevantTexts = new Set(s.mechanisms.filter((m) => m.verdict === 'irrelevant').map((m) => m.fact));
            const grade = async (response) => (await evaluate(response, hardTest(id).expectations)).map((f) => f.type);
            const right = () => placements(s, (p) => (outsideTexts.has(p) || irrelevantTexts.has(p) ? 'outside' : 'inside'));

            test('drawing out just what matters, modelling it and bounding it right passes', async () => {
                reading = right();
                expect(await grade(conversation(matteringFacts(s), signatureLinks(s)))).toEqual([]);
                expect(await grade(conversation(allFactIds(s), signatureLinks(s)))).toEqual([]);
            });

            test('asking nothing, missing one fact, a constant boundary, or a missing link fails', async () => {
                reading = placements(s, () => 'not mentioned');
                expect((await grade(conversation([], []))).length).toBeGreaterThan(0);
                expect(await grade({ err: 'boom' })).toEqual(['No response produced']);
                reading = right();
                const [, missed] = matteringFacts(s);
                expect(await grade(conversation(matteringFacts(s).filter((f) => f !== missed), signatureLinks(s)))).toContain('Not elicited');
                for (const constant of ['inside', 'outside', 'not mentioned']) {
                    reading = placements(s, () => constant);
                    expect([constant, (await grade(conversation(allFactIds(s), signatureLinks(s)))).includes('Boundary wrong')]).toEqual([constant, true]);
                }
                reading = right();
                expect(await grade(conversation(matteringFacts(s), signatureLinks(s).slice(1)))).toEqual(['Mechanism missing from diagram']);
            });
        });
    });
});
