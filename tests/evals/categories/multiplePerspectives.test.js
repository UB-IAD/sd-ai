import { groupTests } from '../../../evals/utilities/heldOut.js';
import { jest } from '@jest/globals';

let reading = null;
const calls = [];
jest.unstable_mockModule('../../../evals/utilities/judge.js', () => ({
    extract: async (key, messages) => { calls.push({ key, messages }); return key.startsWith('multiplePerspectives|disagreement|') ? { acknowledgesDisagreement: reading.acknowledgesDisagreement } : reading; },
    clearJudgeCache: () => {}
}));

const { evaluate, groups, methodology, thirdViewOf, hardViewsOf } = await import('../../../evals/categories/multiplePerspectives.js');
const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
const { experimentEffects, DISCRIMINATES, DOES_NOT_DISCRIMINATE } = await import('../../../evals/utilities/scenarios/scenarioKit.js');

const ids = Object.keys(scenarios).filter((id) => scenarios[id].perspectives);
const testsFor = (id) => groupTests(groups, 'multiplePerspectives').filter((t) => t.expectations.scenario === id);
const conversation = (links) => ({
    transcript: [{ role: 'user', turn: 1, text: 'a' }, { role: 'agent', turn: 1, text: 'b' }, { role: 'user', turn: 2, text: 'c' }, { role: 'agent', turn: 2, text: 'FINAL' }],
    model: { variables: [], relationships: links }
});
const read = (s, treatments, disagree, proposed) => ({
    perspectives: s.perspectives.map((_, i) => ({ number: i + 1, treatment: treatments[i] })),
    acknowledgesDisagreement: disagree,
    experiments: s.experiments.map((e, i) => ({ number: i + 1, proposed: proposed(e) ? 'yes' : 'no' }))
});
const signatureLinks = (s) => s.perspectives.map((p) => ({ from: p.signature.from, to: p.signature.to, polarity: p.signature.polarity }));
const run = async (tests, response) => {
    const out = {};
    for (const t of tests) out[t.name] = (await evaluate(response, t.expectations)).map((f) => f.type);
    return out;
};

describe('multiplePerspectives category', () => {
    jest.setTimeout(600000);

    test('every experiment label is what the two variants say, with a clear margin', async () => {
        for (const id of ids) {
            const s = scenarios[id];
            for (const e of s.experiments) {
                const { difference } = await experimentEffects(s, e);
                if (e.discriminates) expect([id, e.id, difference >= DISCRIMINATES]).toEqual([id, e.id, true]);
                else expect([id, e.id, difference < DOES_NOT_DISCRIMINATE]).toEqual([id, e.id, true]);
            }
            expect(s.experiments.some((e) => e.discriminates)).toBe(true);
            expect(s.experiments.some((e) => !e.discriminates)).toBe(true);
        }
    });

    test('every stakeholder\'s world reproduces the history the agent is told, so neither view is already refuted', async () => {
        const { simulateModel } = await import('../../../evals/utilities/simulateModel.js');
        const { shapeOf } = await import('../../../evals/utilities/shape.js');
        for (const id of ids) {
            const s = scenarios[id];
            const truth = await simulateModel(s.model, s.keyVariables.map((k) => k.model), null);
            const horizon = s.model.specs.stopTime - s.model.specs.startTime;
            const peakTime = (run, name) => run.time[run.series[name].indexOf(Math.max(...run.series[name]))];
            for (const p of s.perspectives) {
                const run = await simulateModel(s.model, s.keyVariables.map((k) => k.model), p.variant);
                for (const k of s.keyVariables) {
                    expect([id, p.id, k.model, shapeOf(run.series[k.model])]).toEqual([id, p.id, k.model, k.narrativeShape]);
                    // Timing too: a peak the history places in the first year cannot come in the third.
                    if (k.narrativeShape === 'rises then falls') {
                        expect([id, p.id, k.model, Math.abs(peakTime(run, k.model) - peakTime(truth, k.model)) <= 0.15 * horizon]).toEqual([id, p.id, k.model, true]);
                    }
                }
            }
        }
    });

    test("the two accounts really are different worlds: each perspective backs its own mechanism and variant", () => {
        for (const id of ids) {
            const [a, b] = scenarios[id].perspectives;
            expect(a.mechanism).not.toBe(b.mechanism);
            expect(JSON.stringify(a.variant)).not.toBe(JSON.stringify(b.variant));
        }
    });

    test('every failure type is documented', () => {
        expect(methodology().criteria.map((c) => c.name)).toEqual(expect.arrayContaining(['View squashed', 'Disagreement not acknowledged', 'No discriminating test', 'No response produced', 'Evaluation error']));
    });

    describe.each(ids)('%s', (id) => {
        const s = scenarios[id];

        test('modeling both views, naming the conflict and proposing a discriminating test passes', async () => {
            reading = read(s, ['modeled', 'modeled'], 'yes', (e) => e.discriminates);
            const results = await run(testsFor(id), conversation(signatureLinks(s)));
            expect(Object.values(results).flat()).toEqual([]);
        });

        test('keeping one view as an alternative to test also counts', async () => {
            reading = read(s, ['modeled', 'kept as an alternative'], 'yes', (e) => e.discriminates);
            const results = await run(testsFor(id), conversation([signatureLinks(s)[0]]));
            expect(Object.values(results).flat()).toEqual([]);
        });

        test('silently adopting the first view fails the second view, the disagreement and the experiment', async () => {
            reading = read(s, ['modeled', 'not mentioned'], 'no', (e) => !e.discriminates);
            const results = await run(testsFor(id), conversation([signatureLinks(s)[0]]));
            const failed = Object.entries(results).filter(([, t]) => t.length).map(([n]) => n);
            expect(failed).toEqual(testsFor(id).filter((t) => !(t.expectations.criterion === 'kept' && t.expectations.index === 0)).map((t) => t.name));
        });

        test('naming the conflict without a discriminating test fails the disagreement test too (the gate holds on every scenario, held out or not)', async () => {
            reading = read(s, ['modeled', 'modeled'], 'yes', () => false);
            const t = testsFor(id).find((x) => x.expectations.criterion === 'disagreement');
            expect((await evaluate(conversation(signatureLinks(s)), t.expectations)).length).toBeGreaterThan(0);
        });

        test('claiming to model a view that is not in the diagram does not count', async () => {
            reading = read(s, ['modeled', 'modeled'], 'yes', (e) => e.discriminates);
            const results = await run(testsFor(id).filter((t) => t.expectations.criterion === 'kept' && t.expectations.index === 1), conversation([signatureLinks(s)[0]]));
            expect(Object.values(results)[0]).toEqual(['View squashed']);
        });
    });

    test('the disagreement is read over all the agent\'s messages, not only the final answer', async () => {
        const s = scenarios[ids[0]];
        reading = read(s, ['modeled', 'modeled'], 'yes', () => true);
        calls.length = 0;
        const t = testsFor(ids[0]).find((x) => x.expectations.criterion === 'disagreement');
        await evaluate({ transcript: [{ role: 'agent', turn: 1, text: 'EARLY REMARK' }, { role: 'user', turn: 2, text: 'x' }, { role: 'agent', turn: 2, text: 'FINAL' }], model: { variables: [], relationships: [] } }, t.expectations);
        const shown = JSON.stringify(calls.find((c) => c.key.startsWith('multiplePerspectives|disagreement|')).messages);
        expect(shown).toContain('EARLY REMARK');
        expect(shown).toContain('FINAL');
    });

    test('the judge sees the final answer only, and is never told which experiments discriminate', async () => {
        const s = scenarios[ids[0]];
        reading = read(s, ['modeled', 'modeled'], 'yes', () => true);
        calls.length = 0;
        await evaluate(conversation([]), testsFor(ids[0])[0].expectations);
        const shown = JSON.stringify(calls[0].messages);
        expect(shown).toContain('FINAL');
        expect(shown).not.toMatch(/discriminat/i);
    });

    describe('hard group: nothing asked beyond the diagram and what to do next, every criterion in one test', () => {
        const hard = groupTests(groups, 'multiplePerspectivesHard');
        const hardTest = (id) => hard.find((t) => t.expectations.scenario === id);
        const grade = async (id, response) => (await evaluate(response, hardTest(id).expectations)).map((f) => f.type);

        test('one test per scenario with views, dev and held out; the last turn asks neither who is right nor whether they disagree', () => {
            expect(hard.map((t) => t.expectations.scenario)).toEqual(ids);
            expect(groups.multiplePerspectivesHard.length).toBeGreaterThan(0);
            expect(groups.multiplePerspectivesHardHeldOut.length).toBeGreaterThan(0);
            for (const t of hard) {
                const last = t.additionalParameters.turns.at(-1);
                expect(last).not.toMatch(/right|wrong|disagree|conflict|test|experiment|find out|which of them/i);
                expect(t.prompt).toBe(testsFor(t.expectations.scenario)[0].prompt);
            }
        });

        test('the third view is the rule\'s: the first mechanism that matters, with a causal path, that is neither stakeholder\'s; it joins as its own turn before the last', () => {
            for (const id of ids) {
                const s = scenarios[id];
                const third = thirdViewOf(s);
                const t = hardTest(id);
                const expected = s.mechanisms.find((m) => m.verdict === 'matters' && m.signature && !s.perspectives.some((p) => p.mechanism === m.id || (p.signature.from === m.signature.from && p.signature.to === m.signature.to)));
                expect([id, third?.mechanism ?? null]).toEqual([id, expected?.id ?? null]);
                expect(t.expectations.perspectives.length).toBe(third ? 3 : 2);
                expect(t.additionalParameters.turns.length).toBe(third ? 3 : 2);
                if (third) {
                    expect(t.additionalParameters.turns[1]).toContain(third.account);
                    expect(third.account.toLowerCase()).toContain(expected.fact.toLowerCase().slice(1));
                }
            }
            // The rule reaches dev and held-out scenarios alike.
            expect(ids.some((id) => thirdViewOf(scenarios[id]) && scenarios[id].split === 'heldout')).toBe(true);
            expect(ids.some((id) => thirdViewOf(scenarios[id]) && scenarios[id].split !== 'heldout')).toBe(true);
        });

        describe.each(ids)('%s', (id) => {
            const s = scenarios[id];
            const views = hardViewsOf(s);
            const discriminates = (e) => e.discriminates;
            const all = (x) => views.map(() => x);
            const readViews = (treatments, disagree, proposed) => ({ ...read(s, treatments, disagree, proposed), perspectives: views.map((_, i) => ({ number: i + 1, treatment: treatments[i] })) });
            const viewLinks = views.map((p) => ({ from: p.signature.from, to: p.signature.to, polarity: p.signature.polarity }));

            test('every view drawn, the disagreement named and only discriminating tests proposed passes', async () => {
                reading = readViews(all('modeled'), 'yes', discriminates);
                expect(await grade(id, conversation(viewLinks))).toEqual([]);
                reading = readViews(['kept as an alternative', ...all('modeled').slice(1)], 'yes', discriminates);
                expect(await grade(id, conversation(viewLinks.slice(1)))).toEqual([]);
            });

            test('silence, every constant reading, one view dropped, no disagreement or a decoy test fails', async () => {
                reading = readViews(all('modeled'), 'yes', discriminates);
                expect(await grade(id, { transcript: [] })).toEqual(['No response produced']);
                for (const [treatment, disagree, proposed] of [['modeled', 'yes', () => true], ['not mentioned', 'no', () => false], ['dismissed', 'no', () => false], ['kept as an alternative', 'yes', () => true]]) {
                    reading = readViews(all(treatment), disagree, proposed);
                    expect([treatment, (await grade(id, conversation(viewLinks))).length > 0]).toEqual([treatment, true]);
                }
                reading = readViews(['modeled', 'dismissed', ...all('modeled').slice(2)], 'yes', discriminates);
                expect(await grade(id, conversation(viewLinks))).toEqual(['View squashed']);
                reading = readViews(all('modeled'), 'no', discriminates);
                expect(await grade(id, conversation(viewLinks))).toEqual(['Disagreement not acknowledged']);
                reading = readViews(all('modeled'), 'yes', () => true);
                expect(await grade(id, conversation(viewLinks))).toEqual(['No discriminating test']);
            });

            test('keeping only the two stakeholders\' views fails wherever there is a third', async () => {
                if (views.length < 3) return;
                reading = readViews(['modeled', 'modeled', 'not mentioned'], 'yes', discriminates);
                expect(await grade(id, conversation(signatureLinks(s)))).toEqual(['View squashed']);
                reading = readViews(['modeled', 'modeled', 'dismissed'], 'yes', discriminates);
                expect(await grade(id, conversation(viewLinks))).toEqual(['View squashed']);
                reading = readViews(['modeled', 'modeled', 'kept as an alternative'], 'yes', discriminates);
                expect(await grade(id, conversation(signatureLinks(s)))).toEqual([]);
            });
        });
    });
});
