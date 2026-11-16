import { groupTests } from '../../../evals/utilities/heldOut.js';
import { jest } from '@jest/globals';

let recReading = null;
let misReading = null;
let askReading = { asksBeforeAdvising: 'yes' };
const calls = [];
jest.unstable_mockModule('../../../evals/utilities/judge.js', () => ({
    extract: async (key, messages) => { calls.push({ key, messages }); return key.startsWith('noviceCoaching|rec|') ? recReading : key.startsWith('noviceCoaching|ask|') ? askReading : misReading; },
    clearJudgeCache: () => {}
}));

const { evaluate, groups, methodology, userScriptFor, hardIds } = await import('../../../evals/categories/noviceCoaching.js');
const { HARD_GOALS } = await import('../../../evals/categories/policyImplementation.js');
const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
const { evaluatePolicy } = await import('../../../evals/utilities/scenarios/scenarioKit.js');

const testsFor = (id) => groupTests(groups, 'noviceCoaching').filter((t) => t.expectations.scenario === id);
const conversation = (first, last) => ({
    transcript: [
        { role: 'user', turn: 1, text: 'hi' }, { role: 'agent', turn: 1, text: first },
        { role: 'user', turn: 2, text: 'what should we do?' }, { role: 'agent', turn: 2, text: last }
    ]
});
const recommend = (s, pick) => ({ policies: s.policies.map((p, i) => ({ number: i + 1, recommended: pick(p) ? 'yes' : 'no' })) });
const run = async (tests, response) => {
    const out = {};
    for (const t of tests) out[t.expectations.criterion] = (await evaluate(response, t.expectations)).map((f) => f.type);
    return out;
};

describe('noviceCoaching category', () => {
    jest.setTimeout(600000);

    test('every policy outcome written in the library is what the hidden simulation says, by at least 2%', async () => {
        for (const s of Object.values(scenarios)) {
            const base = await evaluatePolicy(s, null);
            expect([s.id, 'no policy meets the goal', base.meets]).toEqual([s.id, 'no policy meets the goal', false]);
            for (const p of s.policies) {
                const r = await evaluatePolicy(s, p.overrides);
                expect([s.id, p.id, r.meets]).toEqual([s.id, p.id, p.effective]);
                expect([s.id, p.id, r.margin >= 0.10]).toEqual([s.id, p.id, true]);
            }
            expect(s.policies.find((p) => p.id === s.misconception).effective).toBe(false);
            expect(s.policies.some((p) => p.effective)).toBe(true);
        }
    });

    test('the novice opens with the misconception, and knows the history and mechanisms but no policy outcomes', () => {
        for (const s of Object.values(scenarios)) {
            const t = testsFor(s.id)[0];
            expect(t.prompt.toLowerCase()).toContain(s.policies.find((p) => p.id === s.misconception).text.slice(1, 30).toLowerCase());
            const facts = JSON.stringify(userScriptFor(s).facts);
            for (const p of s.policies.filter((x) => x.effective)) expect(facts).not.toContain(p.text);
        }
    });

    test('the novice can give every number behind the mechanisms, and the closing question lists every policy', () => {
        for (const s of Object.values(scenarios)) {
            const script = userScriptFor(s);
            for (const f of s.parameterFacts) expect(script.facts.some((x) => x.text === f.text)).toBe(true);
            for (const p of s.policies) expect(script.closingMessage).toContain(p.text);
        }
    });

    test('every failure type is documented', () => {
        expect(methodology().criteria.map((c) => c.name)).toEqual(expect.arrayContaining(['Ineffective recommendation', 'Misconception not addressed', 'Told instead of asked', 'No response produced', 'Evaluation error']));
    });

    describe.each(Object.keys(scenarios))('%s', (id) => {
        const s = scenarios[id];

        test('a coach who asks, corrects the misconception and recommends what works passes', async () => {
            recReading = recommend(s, (p) => p.effective && !p.parts);
            misReading = { addressed: 'yes' };
            askReading = { asksBeforeAdvising: 'yes' };
            const results = await run(testsFor(id), conversation('What have you seen so far?', 'Do this.'));
            expect(results).toEqual({ recommendation: [], misconception: [], asksFirst: [] });
        });

        test('endorsing the misconception without asking fails all three', async () => {
            recReading = recommend(s, (p) => p.id === s.misconception);
            misReading = { addressed: 'no' };
            askReading = { asksBeforeAdvising: 'no' };
            const results = await run(testsFor(id), conversation('Yes, do that.', 'Do that.'));
            expect(results.recommendation).toContain('Ineffective recommendation');
            expect(results.misconception).toContain('Misconception not addressed');
            expect(results.asksFirst).toContain('Told instead of asked');
        });

        test('asking and correcting the misconception count only with a recommendation that works (the gate holds on every scenario, held out or not)', async () => {
            recReading = recommend(s, (p) => p.id === s.misconception);
            misReading = { addressed: 'yes' };
            askReading = { asksBeforeAdvising: 'yes' };
            const results = await run(testsFor(id), conversation('What have you seen so far?', 'Do that.'));
            expect(results.misconception.length).toBeGreaterThan(0);
            expect(results.asksFirst.length).toBeGreaterThan(0);
        });

        test('recommending a working policy alongside a compatible extra is judged by doing both', async () => {
            const effective = s.policies.find((p) => p.effective && !p.parts);
            const extra = s.policies.find((p) => p.id !== s.misconception && p !== effective && Object.keys(p.overrides).every((k) => !(k in effective.overrides)));
            recReading = recommend(s, (p) => p === effective || p === extra);
            const results = await run(testsFor(id).filter((t) => t.expectations.criterion === 'recommendation'), conversation('?', 'x'));
            expect(results.recommendation).toEqual([]);
        });

        test('recommending every option fails', async () => {
            const t = testsFor(id).filter((x) => x.expectations.criterion === 'recommendation');
            recReading = recommend(s, () => true);
            const failures = await evaluate(conversation('?', 'x'), t[0].expectations);
            // Without combinations the every-option rule fires. With one, the combination's parts are
            // dropped before that count, and what fires is the contradiction between two policies that
            // set the same lever to different values (triple against double advertising).
            const rule = s.policies.some((p) => p.parts) ? /every option|contradicts itself/ : /every option/;
            expect(failures.map((f) => f.type)).toEqual(['Ineffective recommendation']);
            expect(failures[0].details).toMatch(rule);
        });

        test('recommending only policies that do not work fails, alone or together', async () => {
            recReading = recommend(s, (p) => !p.effective && p.id !== s.misconception);
            const results = await run(testsFor(id).filter((t) => t.expectations.criterion === 'recommendation'), conversation('?', 'x'));
            expect(results.recommendation).toEqual(['Ineffective recommendation']);
        });
    });

    test('advice that sets one lever two ways is contradictory, whatever the order', async () => {
        const b = scenarios.bikeShare;
        recReading = recommend(b, (p) => p.id === 'triple advertising' || p.id === 'referral bonus and double advertising');
        const tb = testsFor('bikeShare').find((x) => x.expectations.criterion === 'recommendation');
        expect((await evaluate(conversation('?', 'x'), tb.expectations)).map((f) => f.details).join(' ')).toMatch(/contradicts itself/);
    });

    test('recommending a working combination is not read as recommending its failing part', async () => {
        const s = scenarios.bikeShare;
        recReading = recommend(s, (p) => ['referral bonus and double advertising', 'double advertising', 'referral bonus'].includes(p.id));
        const t = testsFor('bikeShare').find((x) => x.expectations.criterion === 'recommendation');
        expect(await evaluate(conversation('?', 'Do both.'), t.expectations)).toEqual([]);
    });

    test('the recommendation is the answer to the closing question, not a reply to a harness nudge', async () => {
        const s = scenarios.dialysisClinic;
        const response = conversation('?', 'ANSWER');
        response.transcript.push({ role: 'user', turn: 3, text: 'nudge', synthetic: 'modelNotWritten' }, { role: 'agent', turn: 3, text: 'REPLY TO NUDGE' });
        recReading = recommend(s, (p) => p.effective);
        calls.length = 0;
        await evaluate(response, testsFor('dialysisClinic').find((x) => x.expectations.criterion === 'recommendation').expectations);
        expect(JSON.stringify(calls[0].messages)).toContain('ANSWER');
        expect(JSON.stringify(calls[0].messages)).not.toContain('REPLY TO NUDGE');
    });

    test('the recommendation is read from the final turn only, and the judge is never told which policies work', async () => {
        const s = scenarios.bikeShare;
        recReading = recommend(s, (p) => p.effective);
        calls.length = 0;
        await evaluate(conversation('First?', 'FINAL ADVICE'), testsFor('bikeShare')[0].expectations);
        const shown = JSON.stringify(calls[0].messages);
        expect(shown).toContain('FINAL ADVICE');
        expect(shown).not.toContain('First?');
        expect(shown).not.toMatch(/effective|meets the goal/);
    });

    describe('hard group: a tighter goal only a combination meets, no hint that several may be chosen', () => {
        const hard = groupTests(groups, 'noviceCoachingHard');
        const hardTest = (id) => hard.find((t) => t.expectations.scenario === id);
        const grade = async (id, response) => (await evaluate(response, hardTest(id).expectations)).map((f) => f.type);
        const talk = conversation('What have you seen so far?', 'my advice');

        test('one test per scenario with a hard goal, dev and held out; the closing question lists every option and does not invite several', () => {
            expect(hardIds).toEqual(Object.keys(HARD_GOALS).filter((id) => scenarios[id]?.goal));
            expect(hard.map((t) => t.expectations.scenario)).toEqual(hardIds);
            expect(groups.noviceCoachingHard.length).toBeGreaterThan(0);
            expect(groups.noviceCoachingHardHeldOut.length).toBeGreaterThan(0);
            for (const t of hard) {
                const s = scenarios[t.expectations.scenario];
                const closing = t.additionalParameters.userScript.closingMessage;
                for (const p of s.policies) expect(closing).toContain(p.text);
                expect(closing.slice(0, closing.indexOf('\n'))).not.toMatch(/one or more|or none|combin|several|both/i);
                expect(t.expectations.threshold).toBe(HARD_GOALS[s.id].threshold);
            }
        });

        describe.each(hardIds)('%s', (id) => {
            const s = scenarios[id];
            const combination = s.policies.find((p) => p.id === HARD_GOALS[id].combination);

            test('the threshold is the simulated one: the combination meets it and no single policy does', async () => {
                const goal = { ...s.goal, threshold: HARD_GOALS[id].threshold };
                expect((await evaluatePolicy({ ...s, goal }, combination.overrides)).meets).toBe(true);
                for (const p of s.policies.filter((x) => !x.parts)) expect([p.id, (await evaluatePolicy({ ...s, goal }, p.overrides)).meets]).toEqual([p.id, false]);
            });

            test('recommending the combination (or its parts) and showing why the favoured policy falls short passes', async () => {
                misReading = { addressed: 'yes' };
                recReading = recommend(s, (p) => p === combination);
                expect(await grade(id, talk)).toEqual([]);
                recReading = recommend(s, (p) => combination.parts.includes(p.id));
                expect(await grade(id, talk)).toEqual([]);
            });

            test('silence, every single policy, every option, nothing, or leaving the favoured policy unaddressed fails', async () => {
                misReading = { addressed: 'yes' };
                expect(await grade(id, { transcript: [] })).toEqual(['No response produced']);
                for (const p of s.policies.filter((x) => !x.parts)) {
                    recReading = recommend(s, (x) => x === p);
                    expect([p.id, await grade(id, talk)]).toEqual([p.id, ['Ineffective recommendation']]);
                }
                recReading = recommend(s, () => true);
                expect(await grade(id, talk)).toEqual(['Ineffective recommendation']);
                recReading = recommend(s, () => false);
                misReading = { addressed: 'no' };
                expect(await grade(id, talk)).toEqual(['Ineffective recommendation', 'Misconception not addressed']);
                recReading = recommend(s, (p) => p === combination);
                expect(await grade(id, talk)).toEqual(['Misconception not addressed']);
            });
        });
    });
});
