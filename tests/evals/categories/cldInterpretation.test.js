import { groupTests } from '../../../evals/utilities/heldOut.js';
import { jest } from '@jest/globals';

let reading = null;
const calls = [];
jest.unstable_mockModule('../../../evals/utilities/judge.js', () => ({
    extract: async (key, messages) => { calls.push({ key, messages }); return reading; },
    clearJudgeCache: () => {}
}));

const { evaluate, groups, methodology, questionsFor, hardQuestionsFor } = await import('../../../evals/categories/cldInterpretation.js');

const all = [...groupTests(groups, 'gibberishCLDs'), ...groupTests(groups, 'realDomainCLDs')];
const fixtures = [...new Set(all.map((t) => t.expectations.fixture))];
const testsFor = (key) => all.filter((t) => t.expectations.fixture === key);
const answering = (tests, pick) => Object.fromEntries(tests.map((t) => [`q${t.expectations.number}`, pick(t)]));

describe('cldInterpretation category', () => {
    test('every diagram gets loop, effect and loop-count questions, and every key is one of its options', () => {
        for (const key of fixtures) {
            const tests = testsFor(key);
            const questions = tests[0].expectations.questions;
            expect(questions.some((q) => q.text.startsWith('Is the feedback loop'))).toBe(true);
            expect(questions.some((q) => q.text.startsWith('If '))).toBe(true);
            expect(questions.some((q) => q.text.startsWith('How many'))).toBe(true);
            for (const t of tests) expect(questions[t.expectations.number - 1].options).toContain(t.expectations.answer);
        }
    });

    test('the gibberish group holds every gibberish diagram, held out or not, and the real-domain group none', async () => {
        const { GIBBERISH_CLDS } = await import('../../../evals/categories/modelToCLDData/buildClds.js');
        const { groups } = await import('../../../evals/categories/cldInterpretation.js');
        const named = (g) => new Set(groupTests(groups, g).map((t) => t.name.split(':')[0].trim()));
        expect([...named('gibberishCLDs')].sort()).toEqual([...GIBBERISH_CLDS].sort());
        for (const k of named('realDomainCLDs')) expect(GIBBERISH_CLDS).not.toContain(k);
    });

    test('a hand-built diagram gets the right keys', () => {
        const model = { variables: [], relationships: [
            { from: 'a', to: 'b', polarity: '+' }, { from: 'b', to: 'c', polarity: '-' }, { from: 'c', to: 'a', polarity: '+' },
            { from: 'c', to: 'd', polarity: '+' }, { from: 'd', to: 'e', polarity: '+' }
        ] };
        const questions = questionsFor(model);
        expect(questions.find((q) => q.text.startsWith('Is the feedback loop')).answer).toBe('balancing');
        // Hand-computed: every pair at least two links apart, with the sign of its only path.
        // Pairs inside the loop a -> b -> c have a path back and are not asked about.
        const expected = { 'a|d': 'decreases', 'a|e': 'decreases', 'b|d': 'decreases', 'b|e': 'decreases', 'c|e': 'increases' };
        const effects = questions.filter((q) => q.text.startsWith('If '));
        expect(effects.length).toBeGreaterThan(0);
        for (const q of effects) {
            const [, from, to] = q.text.match(/^If "(\w)" increases.*does "(\w)"/);
            expect([q.text, q.answer]).toEqual([q.text, expected[`${from}|${to}`]]);
        }
        expect(questions.find((q) => q.text.startsWith('How many')).answer).toBe('1');
    });

    test('effect questions are only asked where every path agrees on the sign', () => {
        // a -> c directly (+) and a -> b -> c (-,+): the paths disagree, so a/c is never asked.
        const model = { variables: [], relationships: [
            { from: 'a', to: 'c', polarity: '+' }, { from: 'a', to: 'b', polarity: '-' }, { from: 'b', to: 'c', polarity: '+' }, { from: 'c', to: 'd', polarity: '+' }
        ] };
        expect(questionsFor(model).some((q) => q.text.includes('"a" increases') && q.text.includes('"d"'))).toBe(false);
    });

    test('no effect question asks about a pair with a path back from the effect to the cause', async () => {
        const fs = await import('fs');
        const { sourceGraph, pathPolarities, foldVariable } = await import('../../../evals/utilities/causalGraph.js');
        for (const key of fixtures) {
            const model = JSON.parse(fs.readFileSync(`evals/categories/modelToCLDData/${key}.json`, 'utf8')).model;
            const graph = sourceGraph(model, null);
            for (const q of questionsFor(model).filter((x) => x.text.startsWith('If '))) {
                const [, from, to] = q.text.match(/^If "(.+)" increases, .* does "(.+)" increase/);
                expect([q.text, pathPolarities(graph, foldVariable(to), foldVariable(from), new Set()).size]).toEqual([q.text, 0]);
            }
        }
    });

    test('siblings share one generation and the prompt carries every question but no answer', () => {
        for (const key of fixtures) {
            const tests = testsFor(key);
            expect(new Set(tests.map((t) => JSON.stringify([t.prompt, t.currentModel, t.additionalParameters]))).size).toBe(1);
            for (const t of tests) expect(tests[0].prompt).toContain(tests[0].expectations.questions[t.expectations.number - 1].text);
        }
    });

    test('every failure type is documented', () => {
        expect(methodology().criteria.map((c) => c.name)).toEqual(expect.arrayContaining(['Diagram misread', 'No response produced', 'Evaluation error']));
    });

    describe.each(fixtures)('%s', (key) => {
        test('right answers pass and wrong answers fail every question', async () => {
            const tests = testsFor(key);
            reading = answering(tests, (t) => t.expectations.answer);
            for (const t of tests) expect(await evaluate({ output: { textContent: 'answers' } }, t.expectations)).toEqual([]);
            reading = answering(tests, (t) => t.expectations.questions[t.expectations.number - 1].options.find((o) => o !== t.expectations.answer));
            for (const t of tests) expect((await evaluate({ output: { textContent: 'answers' } }, t.expectations)).map((f) => f.type)).toEqual(['Diagram misread']);
        });
    });

    test('the judge is never shown the keys, and reads once per set of answers', async () => {
        const tests = testsFor(fixtures[0]);
        reading = answering(tests, (t) => t.expectations.answer);
        calls.length = 0;
        for (const t of tests) await evaluate({ output: { textContent: 'MY ANSWERS' } }, t.expectations);
        const shown = JSON.stringify(calls.map((c) => c.messages));
        expect(shown).toContain('MY ANSWERS');
        expect(new Set(calls.map((c) => c.key)).size).toBe(1);
        expect(shown).not.toMatch(/"answer":/);
    });

    test('the reading schema only allows each question\'s own options', async () => {
        const { readingSchemaFor } = await import('../../../evals/categories/cldInterpretation.js');
        const qs = [{ text: 'q', options: ['reinforcing', 'balancing'] }];
        expect(readingSchemaFor(qs).safeParse({ q1: 'balancing' }).success).toBe(true);
        expect(readingSchemaFor(qs).safeParse({ q1: 'balances' }).success).toBe(false);
    });

    describe('hard group: bigger diagrams, balanced answers, every question in one test', () => {
        const hard = groupTests(groups, 'gibberishCLDsHard');
        const optionReading = (t, pick) => Object.fromEntries(t.expectations.questions.map((q, i) => [`q${i + 1}`, pick(q, i)]));

        test('one test per hard diagram, dev and held out; the prompt names no method and carries every question', async () => {
            const { HARD_CLDS } = await import('../../../evals/categories/modelToCLDData/buildClds.js');
            expect(hard.map((t) => t.expectations.fixture)).toEqual(HARD_CLDS);
            expect(groups.gibberishCLDsHard.length).toBeGreaterThan(0);
            expect(groups.gibberishCLDsHardHeldOut.length).toBeGreaterThan(0);
            for (const t of hard) {
                for (const q of t.expectations.questions) expect(t.prompt).toContain(q.text);
                expect(t.prompt).not.toMatch(/links in the diagram only|not from what you know/);
            }
        });

        test('every hard diagram\'s answers are balanced: reinforcing as often as balancing, increases as often as decreases, at least two of each', () => {
            for (const t of hard) {
                const count = (a) => t.expectations.answers.filter((x) => x === a).length;
                expect([t.name, count('reinforcing'), count('increases')]).toEqual([t.name, count('balancing'), count('decreases')]);
                expect([t.name, count('reinforcing') >= 2, count('increases') >= 2]).toEqual([t.name, true, true]);
            }
        });

        test('the keys are the graph\'s: loop answers match the designed petals, effects match the single-question keys', async () => {
            const fs = await import('fs');
            const { foldVariable } = await import('../../../evals/utilities/causalGraph.js');
            for (const t of hard) {
                const fixture = JSON.parse(fs.readFileSync(`evals/categories/modelToCLDData/${t.expectations.fixture}.json`, 'utf8'));
                expect(hardQuestionsFor(fixture.model).map((q) => q.answer)).toEqual(t.expectations.answers);
                const single = Object.fromEntries(questionsFor(fixture.model).map((q) => [q.text, q.answer]));
                t.expectations.questions.forEach((q, i) => {
                    if (q.text.startsWith('Is the feedback loop')) {
                        const nodes = [...q.text.matchAll(/"([^"]+)"/g)].map((m) => foldVariable(m[1]));
                        const petal = fixture.loops.find((l) => l.nodes.length === nodes.length - 1 && l.nodes.every((n) => nodes.includes(foldVariable(n))));
                        expect([q.text, petal.polarity === '+' ? 'reinforcing' : 'balancing']).toEqual([q.text, t.expectations.answers[i]]);
                    } else if (q.text in single) expect([q.text, single[q.text]]).toEqual([q.text, t.expectations.answers[i]]);
                });
            }
        });

        test('every hub gets two dependent counts, re-derived from the designed petals: loops through it, and how many of those are reinforcing', async () => {
            const fs = await import('fs');
            const { foldVariable } = await import('../../../evals/utilities/causalGraph.js');
            for (const t of hard) {
                const fixture = JSON.parse(fs.readFileSync(`evals/categories/modelToCLDData/${t.expectations.fixture}.json`, 'utf8'));
                const petalsThrough = (n) => fixture.loops.filter((l) => l.nodes.some((x) => foldVariable(x) === foldVariable(n)));
                const hubs = [...new Set(fixture.model.variables.map((v) => v.name))].filter((n) => petalsThrough(n).length >= 2);
                const asked = new Map();
                t.expectations.questions.forEach((q, i) => {
                    const m = q.text.match(/^How many distinct feedback loops pass through "([^"]+)"\?$/) || q.text.match(/^Of the feedback loops that pass through "([^"]+)", how many are reinforcing\?$/);
                    if (!m) return;
                    const reinforcing = q.text.startsWith('Of the');
                    const petals = petalsThrough(m[1]).filter((l) => !reinforcing || l.polarity === '+');
                    expect([q.text, t.expectations.answers[i]]).toEqual([q.text, petals.length >= 6 ? '6 or more' : String(petals.length)]);
                    asked.set(`${foldVariable(m[1])}|${reinforcing}`, true);
                });
                expect([t.name, hubs.length >= 2]).toEqual([t.name, true]);
                for (const h of hubs) for (const r of [false, true]) expect([t.name, h, r, asked.has(`${foldVariable(h)}|${r}`)]).toEqual([t.name, h, r, true]);
            }
        });

        test.each(groupTests(groups, 'gibberishCLDsHard').map((t) => [t.expectations.fixture, t]))('%s: the right answers pass; silence, every constant answer and one wrong answer fail', async (key, t) => {
            const response = { output: { textContent: 'answers' } };
            reading = optionReading(t, (q, i) => t.expectations.answers[i]);
            expect(await evaluate(response, t.expectations)).toEqual([]);
            expect((await evaluate({ output: { textContent: '' } }, t.expectations)).map((f) => f.type)).toEqual(['No response produced']);
            for (const k of [0, 1, 2, 3, 4, 5, 6]) {
                reading = optionReading(t, (q) => q.options[Math.min(k, q.options.length - 1)]);
                expect([k, (await evaluate(response, t.expectations)).length > 0]).toEqual([k, true]);
            }
            reading = optionReading(t, () => 'unclear');
            expect((await evaluate(response, t.expectations)).length).toBe(t.expectations.answers.length);
            reading = optionReading(t, (q, i) => (i === 0 ? q.options.find((o) => o !== t.expectations.answers[0]) : t.expectations.answers[i]));
            expect((await evaluate(response, t.expectations)).map((f) => f.type)).toEqual(['Diagram misread']);
        });
    });
});
