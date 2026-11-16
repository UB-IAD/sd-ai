import { groupTests } from '../../../evals/utilities/heldOut.js';
import { jest } from '@jest/globals';

// The stubbed judge: `answer(caseName)` gives the verdict read for each question of a test.
let answer = () => 'unclear';
// For the second hard group: `direction(caseName)` gives the direction read for each question.
let direction = () => 'not said';
jest.unstable_mockModule('../../../evals/utilities/judge.js', () => ({
    extract: async (key) => Object.fromEntries(key.split('|')[1].split('+').flatMap((n, i) => [[`q${i + 1}`, answer(n)], [`d${i + 1}`, direction(n)]])),
    clearJudgeCache: () => {}
}));

const { evaluate, groups, methodology, keyFor, VERDICTS, HARD_RULE_CASES, hardCases } = await import('../../../evals/categories/aggregationCritique.js');
const { cases } = await import('../../../evals/categories/aggregationCritiqueData/cases.js');
const { simulateModel } = await import('../../../evals/utilities/simulateModel.js');

const SAYS = { split: 'split into the groups', aggregate: 'the aggregate is good enough' };
const tests = groupTests(groups, 'aggregationCritique');

describe('aggregationCritique category', () => {
    jest.setTimeout(600000);

    test.each(Object.keys(cases))('%s: the written verdict is the simulated one, with a clear margin', async (name) => {
        expect((await keyFor(cases[name])).verdict).toBe(VERDICTS[name]);
    });

    test('a split model whose groups are identical in everything reproduces the aggregate', async () => {
        const { splitModel } = await import('../../../evals/categories/aggregationCritiqueData/split.js');
        const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
        const m = scenarios.dialysisClinic.model;
        const same = { 'base referrals': 18, 'Chairs': 10, 'Waiting List': 20 };
        const split = splitModel(m, ['A', 'B'], { A: same, B: same }, ['minimum wait', 'patients per chair', 'give up fraction', 'time to return', 'target wait', 'order adjustment time', 'build delay'], ['Waiting List']);
        const a = await simulateModel(m, ['Waiting List'], null);
        const s = await simulateModel(split, ['Waiting List total'], null);
        const worst = Math.max(...a.series['Waiting List'].map((v, i) => Math.abs(v - s.series['Waiting List total'][i])));
        expect(worst).toBeLessThan(1e-6);
    });

    test('both verdicts appear, and each setting has a case of each or shares a question across two splits', async () => {
        // A design rule for the hand-written cases; generated cases take whatever verdicts the rule gives.
        const { handCases } = await import('../../../evals/categories/aggregationCritiqueData/cases.js');
        const verdicts = Object.keys(handCases).map((n) => VERDICTS[n]);
        expect(verdicts.filter((v) => v === 'split').length).toBe(verdicts.filter((v) => v === 'aggregate').length);
        for (const scenario of new Set(Object.values(handCases).map((c) => c.scenario))) {
            const names = Object.keys(handCases).filter((n) => handCases[n].scenario === scenario);
            expect(new Set(names.map((n) => VERDICTS[n])).size).toBe(2);
        }
    });

    test('generated cases are the general rule applied to every scenario without hand-written ones', async () => {
        const { generateCases } = await import('../../../evals/categories/aggregationCritiqueData/generate.js');
        const { handCases, generatedCases } = await import('../../../evals/categories/aggregationCritiqueData/cases.js');
        const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
        const covered = new Set(Object.values(handCases).map((c) => c.scenario));
        const expected = {};
        for (const [id, s] of Object.entries(scenarios)) if (!covered.has(id)) for (const c of await generateCases(s)) expected[c.name] = c.verdict;
        expect(Object.fromEntries(Object.entries(generatedCases).map(([n, c]) => [n, c.verdict]))).toEqual(expected);
    });

    test('the general rule gives sound cases on the dev scenarios: the even split reproduces the aggregate, and keyFor agrees with each verdict', async () => {
        const { generateCases, splitFor, MEASURES } = await import('../../../evals/categories/aggregationCritiqueData/generate.js');
        const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
        let n = 0;
        for (const id of ['dialysisClinic', 'bikeShare', 'distributor']) {
            const s = scenarios[id];
            for (const g of await generateCases(s)) {
                n++;
                const c = { aggregate: s.model, split: splitFor(s, g.input, g.amounts, g.shares), stock: s.goal.variable, measure: MEASURES[g.kind](s) };
                expect([g.name, (await keyFor(c)).verdict]).toEqual([g.name, g.verdict]);
            }
        }
        // Four since the rule drops a question whose plain relative change disagrees with its verdict.
        expect(n).toBeGreaterThanOrEqual(4);
    });

    test('every failure type is documented', () => {
        expect(methodology().criteria.map((c) => c.name)).toEqual(expect.arrayContaining(['Wrong aggregation level', 'No answer given', 'Evaluation error']));
    });

    test('every case is in exactly one test, and a test groups the questions about one split', () => {
        const names = tests.flatMap((t) => t.expectations.caseNames);
        expect(names.sort()).toEqual(Object.keys(cases).sort());
        for (const t of tests) expect(new Set(t.expectations.caseNames.map((n) => `${cases[n].scenario}|${cases[n].heterogeneity}`)).size).toBe(1);
    });

    test('answering the same way to everything fails every test whose questions have different answers', async () => {
        for (const constant of ['split', 'aggregate']) {
            answer = () => SAYS[constant];
            for (const t of tests.filter((x) => new Set(x.expectations.caseNames.map((n) => VERDICTS[n])).size > 1)) {
                expect([t.name, (await evaluate({ supportingInfo: { explanation: 'x' } }, t.expectations)).length > 0]).toEqual([t.name, true]);
            }
        }
    });

    describe.each(tests.map((t) => [t.name, t]))('%s', (name, t) => {
        test('the right verdicts pass; a wrong one, or none, fails', async () => {
            answer = (n) => SAYS[VERDICTS[n]];
            expect(await evaluate({ supportingInfo: { explanation: 'x' } }, t.expectations)).toEqual([]);
            const [first] = t.expectations.caseNames;
            answer = (n) => (n === first ? SAYS[VERDICTS[n] === 'split' ? 'aggregate' : 'split'] : SAYS[VERDICTS[n]]);
            expect((await evaluate({ supportingInfo: { explanation: 'x' } }, t.expectations)).map((f) => f.type)).toEqual(['Wrong aggregation level']);
            answer = () => 'unclear';
            expect((await evaluate({ supportingInfo: { explanation: 'x' } }, t.expectations)).map((f) => f.type)).toEqual(t.expectations.caseNames.map(() => 'Wrong aggregation level'));
            expect((await evaluate({ supportingInfo: { explanation: '' } }, t.expectations)).map((f) => f.type)).toEqual(['No answer given']);
        });
    });

    describe('hard group: every question of a scenario together, both answers present, the choice not named', () => {
        const hard = groupTests(groups, 'aggregationCritiqueHard');
        const response = { supportingInfo: { explanation: 'x' } };

        test('hardCases.json is the general rule applied to every scenario without hand-written cases, re-derived by simulation', async () => {
            const { hardCaseFor } = await import('../../../evals/categories/aggregationCritiqueData/hard.js');
            const { handCases } = await import('../../../evals/categories/aggregationCritiqueData/cases.js');
            const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
            const covered = new Set(Object.values(handCases).map((c) => c.scenario));
            const expected = {};
            for (const [id, s] of Object.entries(scenarios)) {
                if (covered.has(id)) continue;
                const c = await hardCaseFor(s);
                if (c) expected[id] = c;
            }
            expect(expected).toEqual(HARD_RULE_CASES);
        });

        test('one test per scenario with hand-written or rule cases, dev and held out; every test has both verdicts; the prompt names no choice', () => {
            expect(hard.map((t) => t.expectations.scenario)).toEqual(hardCases().map((c) => c.scenario));
            expect(groups.aggregationCritiqueHard.length).toBeGreaterThan(0);
            expect(groups.aggregationCritiqueHardHeldOut.length).toBeGreaterThan(0);
            for (const t of hard) {
                expect([t.name, new Set(t.expectations.verdicts).size]).toEqual([t.name, 2]);
                expect(t.prompt.slice(t.prompt.indexOf('These are the things I need'))).not.toMatch(/split|aggregate|good enough|disaggregat/i);
                for (const q of t.expectations.questions) expect(t.prompt).toContain(q.text);
            }
        });

        test('the hand-written scenarios\' hard verdicts are their cases\' simulated ones', async () => {
            for (const t of hard.filter((x) => x.expectations.questions.every((q) => cases[q.id]))) {
                for (const [i, q] of t.expectations.questions.entries()) expect([q.id, (await keyFor(cases[q.id])).verdict]).toEqual([q.id, t.expectations.verdicts[i]]);
            }
        });

        describe.each(groupTests(groups, 'aggregationCritiqueHard').map((t) => [t.name, t]))('%s', (name, t) => {
            const verdictOf = (id) => t.expectations.verdicts[t.expectations.questions.findIndex((q) => q.id === id)];

            test('the right verdicts pass; silence, every constant answer and one wrong verdict fail', async () => {
                answer = (id) => SAYS[verdictOf(id)];
                expect(await evaluate(response, t.expectations)).toEqual([]);
                expect((await evaluate({ supportingInfo: { explanation: '' } }, t.expectations)).map((f) => f.type)).toEqual(['No answer given']);
                for (const constant of [SAYS.split, SAYS.aggregate, 'unclear']) {
                    answer = () => constant;
                    expect([constant, (await evaluate(response, t.expectations)).length > 0]).toEqual([constant, true]);
                }
                const first = t.expectations.questions[0].id;
                answer = (id) => (id === first ? SAYS[verdictOf(id) === 'split' ? 'aggregate' : 'split'] : SAYS[verdictOf(id)]);
                expect((await evaluate(response, t.expectations)).map((f) => f.type)).toEqual(['Wrong aggregation level']);
            });
        });
    });
});

const { HARD2_CASES, hard2CaseFor, DIRECTIONS, hard2Prompt } = await import('../../../evals/categories/aggregationCritique.js');

describe('aggregationCritique second hard group: which way the model errs, where it cannot be relied on', () => {
    jest.setTimeout(1800000);
    const hard2 = groupTests(groups, 'aggregationCritiqueHard2');
    const response = { supportingInfo: { explanation: 'x' } };

    test('hard2Cases.json is the rule applied to every held-out scenario, re-derived by simulation', async () => {
        const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
        const expected = {};
        for (const id of Object.keys(scenarios).filter((x) => scenarios[x].split === 'heldout')) {
            const c = await hard2CaseFor(id);
            if (c) expected[id] = c;
        }
        expect(expected).toEqual(HARD2_CASES);
    });

    test('one test per held-out case, at least three; both verdicts in each, as many split as aggregate; every split question has a direction; a new prompt naming no choice', async () => {
        const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
        expect(groups.aggregationCritiqueHard2).toBeUndefined();
        expect(hard2.map((t) => t.expectations.scenario)).toEqual(Object.keys(HARD2_CASES));
        expect(hard2.length).toBeGreaterThanOrEqual(3);
        const first = new Set(groupTests(groups, 'aggregationCritiqueHard').map((t) => t.prompt));
        for (const t of hard2) {
            const { verdicts, directions } = t.expectations;
            expect(scenarios[t.expectations.scenario].split).toBe('heldout');
            expect([t.name, verdicts.filter((v) => v === 'split').length]).toEqual([t.name, verdicts.filter((v) => v === 'aggregate').length]);
            verdicts.forEach((v, i) => expect([t.name, i, v === 'split' ? ['high', 'low'].includes(directions[i]) : directions[i] === null]).toEqual([t.name, i, true]));
            expect(t.prompt).toBe(hard2Prompt(HARD2_CASES[t.expectations.scenario]));
            expect(first.has(t.prompt)).toBe(false);
            for (const q of t.expectations.questions) expect(t.prompt).toContain(q.text);
            expect(t.prompt.slice(t.prompt.indexOf('These are the things I need'))).not.toMatch(/split|aggregate|good enough|disaggregat/i);
        }
    });

    test('both directions occur: an agent that always says "too low", or always "too high", with every verdict right, fails at least half of the group', async () => {
        const all = hard2.flatMap((t) => t.expectations.directions.filter(Boolean));
        expect(new Set(all)).toEqual(new Set(['high', 'low']));
        for (const constant of [DIRECTIONS.high, DIRECTIONS.low]) {
            let failed = 0;
            for (const t of hard2) {
                const index = (id) => t.expectations.questions.findIndex((q) => q.id === id);
                answer = (id) => SAYS[t.expectations.verdicts[index(id)]];
                direction = () => constant;
                if ((await evaluate(response, t.expectations)).length) failed++;
            }
            expect([constant, failed >= hard2.length / 2]).toEqual([constant, true]);
        }
        direction = () => DIRECTIONS.none;
    });

    test('a split question\'s direction comes from a gap of at least a quarter, and an aggregate one\'s gap is at most 5%', () => {
        for (const c of Object.values(HARD2_CASES)) {
            for (const q of c.questions.filter((x) => x.change !== undefined)) expect([q.id, q.verdict === 'split' ? q.change >= 0.25 : q.change <= 0.05]).toEqual([q.id, true]);
        }
    });

    describe.each(groupTests(groups, 'aggregationCritiqueHard2').map((t) => [t.name, t]))('%s', (name, t) => {
        const index = (id) => t.expectations.questions.findIndex((q) => q.id === id);
        const verdictOf = (id) => t.expectations.verdicts[index(id)];
        const directionOf = (id) => (t.expectations.directions[index(id)] ? DIRECTIONS[t.expectations.directions[index(id)]] : DIRECTIONS.none);
        const splits = () => t.expectations.verdicts.filter((v) => v === 'split').length;

        test('the right verdicts and directions pass; silence, every constant verdict, and answers at the first hard group\'s level fail', async () => {
            answer = (id) => SAYS[verdictOf(id)];
            direction = directionOf;
            expect(await evaluate(response, t.expectations)).toEqual([]);
            expect((await evaluate({ supportingInfo: { explanation: '' } }, t.expectations)).map((f) => f.type)).toEqual(['No answer given']);
            for (const constant of [SAYS.split, SAYS.aggregate, 'unclear']) {
                answer = () => constant;
                expect([constant, (await evaluate(response, t.expectations)).length > 0]).toEqual([constant, true]);
            }
            // Every verdict right, as the first hard group asks, but no direction or every direction reversed.
            answer = (id) => SAYS[verdictOf(id)];
            direction = () => DIRECTIONS.none;
            expect((await evaluate(response, t.expectations)).map((f) => f.type)).toEqual(Array(splits()).fill('Wrong direction'));
            direction = (id) => ({ [DIRECTIONS.high]: DIRECTIONS.low, [DIRECTIONS.low]: DIRECTIONS.high }[directionOf(id)] ?? DIRECTIONS.none);
            expect((await evaluate(response, t.expectations)).map((f) => f.type)).toEqual(Array(splits()).fill('Wrong direction'));
            // One wrong verdict fails.
            const firstAggregate = t.expectations.questions[t.expectations.verdicts.indexOf('aggregate')].id;
            direction = directionOf;
            answer = (id) => (id === firstAggregate ? SAYS.split : SAYS[verdictOf(id)]);
            expect((await evaluate(response, t.expectations)).map((f) => f.type)).toEqual(['Wrong aggregation level']);
            direction = () => DIRECTIONS.none;
        });
    });
});
