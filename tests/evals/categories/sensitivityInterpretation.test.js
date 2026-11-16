import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';

// The judge is the only LLM call; these tests stand in for it so they run offline and exactly.
let judgeReading = null;
const judgeCalls = [];
jest.unstable_mockModule('../../../evals/utilities/judge.js', () => ({
    extract: async (key, messages) => { judgeCalls.push({ key, messages }); return judgeReading; },
    clearJudgeCache: () => {}
}));

const { evaluate, gradeReading, groups, methodology, renderRuns, TAKEN, HARD_PROMPT_WORDS } = await import('../../../evals/categories/sensitivityInterpretation.js');
const { CASE_SPECS, buildCase, hardScenarioSpec, pairQuestions, MIN_HARD_PAIRS } = await import('../../../evals/categories/sensitivityInterpretationData/buildCases.js');

const cases = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'evals/categories/sensitivityInterpretationData/cases.json'), 'utf8'));
const allTests = Object.values(groups).flat();
const testsFor = (name) => allTests.filter((t) => t.expectations.caseName === name);
const isHard = (name) => cases[name].group.endsWith('Hard');

/** A reading that states exactly the key's answers. */
const perfectReading = function(name) {
    const c = cases[name];
    const answer = (parameter, kind) => c.questions.find((q) => q.parameter === parameter && q.kind === kind)?.answer;
    return {
        parameters: c.parameters.map((p) => ({
            parameter: p.name,
            changesShape: answer(p.name, 'changesShape') ?? 'unclear',
            direction: answer(p.name, 'direction') ?? 'unclear'
        })),
        mostInfluential: c.questions.find((q) => q.kind === 'mostInfluential')?.answer ?? 'unclear',
        leastInfluential: c.questions.find((q) => q.kind === 'leastInfluential')?.answer ?? 'unclear'
    };
};

/** The opposite of every answer. */
const wrongReading = function(name) {
    const perfect = perfectReading(name);
    const flip = { yes: 'no', no: 'yes', increases: 'decreases', decreases: 'increases', 'no clear effect': 'increases', unclear: 'unclear' };
    const others = (answer) => cases[name].parameters.map((p) => p.name).find((n) => n !== answer);
    return {
        parameters: perfect.parameters.map((p) => ({ ...p, changesShape: flip[p.changesShape], direction: flip[p.direction] })),
        mostInfluential: others(perfect.mostInfluential),
        leastInfluential: others(perfect.leastInfluential)
    };
};

describe('sensitivityInterpretation category', () => {
    jest.setTimeout(600000);

    test('the committed keys are exactly what the sweeps produce', async () => {
        const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
        const { scenarioSpec } = await import('../../../evals/categories/sensitivityInterpretationData/buildCases.js');
        for (const s of Object.values(scenarios)) {
            const name = `${s.title} (sweep)`;
            let built = null;
            try { built = await buildCase(name, await scenarioSpec(s)); } catch { built = null; }
            expect([name, built && built.questions.length ? built : undefined]).toEqual([name, cases[name]]);
        }
        for (const [name, spec] of Object.entries(CASE_SPECS)) {
            expect(await buildCase(name, spec)).toEqual(cases[name]);
        }
    });

    test('the hard cases are exactly what the wide sweeps produce, kept by the pairs rule', async () => {
        const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
        for (const s of Object.values(scenarios)) {
            const name = `${s.title} (wide sweep)`;
            let built = null;
            try { built = await buildCase(name, await hardScenarioSpec(s)); } catch { built = null; }
            expect([name, built && pairQuestions(built.questions).length >= MIN_HARD_PAIRS ? built : undefined]).toEqual([name, cases[name]]);
        }
    });

    test('hard tests: each pairs two questions with different answers, no method is named, and the hard group has dev and held-out cases', () => {
        const hard = TAKEN.filter(isHard);
        // Only a later-batch case can be turned away, and only for its prompt's words.
        for (const name of Object.keys(cases).filter((n) => !TAKEN.includes(n))) expect([name, isHard(name), cases[name].scenario]).toEqual([name, true, expect.stringMatching(/^(electricianTraining|cleaningStandards|valleyWater)$/)]);
        expect(hard.length).toBeGreaterThanOrEqual(4);
        expect(Object.keys(groups)).toEqual(expect.arrayContaining(['scenarioSensitivityHard', 'scenarioSensitivityHardHeldOut']));
        for (const name of hard) {
            const tests = testsFor(name);
            expect(tests.length).toBeGreaterThanOrEqual(MIN_HARD_PAIRS);
            for (const t of tests) {
                const [a, b] = t.expectations.questions;
                const ranking = a.kind === 'mostInfluential' || a.kind === 'leastInfluential';
                // A shape or direction pair has two answers that differ; a ranking question has no
                // constant answer and may stand alone.
                if (!ranking) expect([t.name, t.expectations.questions.length, a.kind === b.kind && a.answer !== b.answer]).toEqual([t.name, 2, true]);
            }
            expect(tests[0].prompt).not.toMatch(HARD_PROMPT_WORDS);
            expect(tests[0].prompt).toContain(renderRuns(cases[name]));
        }
    });

    test.each(TAKEN.filter(isHard))('hard %s: every constant answer fails every test; one wrong half fails its pair', (name) => {
        const c = cases[name];
        const params = c.parameters.map((p) => p.name);
        for (const shape of ['yes', 'no']) {
            for (const direction of ['increases', 'decreases', 'no clear effect']) {
                for (const ranked of params) {
                    const constant = { parameters: params.map((p) => ({ parameter: p, changesShape: shape, direction })), mostInfluential: ranked, leastInfluential: ranked };
                    const passing = testsFor(name).filter((t) => !['mostInfluential', 'leastInfluential'].includes(t.expectations.questions[0].kind) && gradeReading(constant, t.expectations).length === 0);
                    expect([shape, direction, ranked, passing.map((t) => t.name)]).toEqual([shape, direction, ranked, []]);
                }
            }
        }
        const flip = { yes: 'no', no: 'yes', increases: 'decreases', decreases: 'increases', 'no clear effect': 'increases' };
        for (const t of testsFor(name)) {
            const q = t.expectations.questions[0];
            const reading = perfectReading(name);
            if (q.kind === 'mostInfluential' || q.kind === 'leastInfluential') reading[q.kind] = params.find((p) => p !== q.answer);
            else reading.parameters.find((p) => p.parameter === q.parameter)[q.kind] = flip[q.answer];
            expect([t.name, gradeReading(reading, t.expectations).length]).toEqual([t.name, 1]);
        }
    });

    test('every case asks something, every test has one question, and siblings share a generation', () => {
        for (const name of Object.keys(cases).filter((n) => !isHard(n))) {
            const tests = testsFor(name);
            expect(tests.length).toBe(cases[name].questions.length);
            expect(tests.length).toBeGreaterThanOrEqual(3);
            expect(new Set(tests.map((t) => JSON.stringify([t.prompt, t.currentModel, t.additionalParameters]))).size).toBe(1);
        }
    });

    test('the prompt shows every run but never the key', () => {
        for (const name of TAKEN) {
            const prompt = testsFor(name)[0].prompt;
            expect(prompt).toContain(renderRuns(cases[name]));
            expect(prompt).not.toMatch(/most influential|answer key/i);
            expect(new Set(testsFor(name).map((t) => t.prompt)).size).toBe(1);
        }
    });

    test('every failure type is documented', () => {
        const documented = methodology().criteria.map((c) => c.name);
        expect(documented).toEqual(expect.arrayContaining(['Shape change misread', 'Direction of effect misread', 'Influence ranking misread', 'No response produced', 'Evaluation error']));
    });

    describe.each(Object.keys(cases))('%s', (name) => {
        test('a reading that states the key passes every question', () => {
            const failing = testsFor(name).filter((t) => gradeReading(perfectReading(name), t.expectations).length);
            expect(failing.map((t) => t.name)).toEqual([]);
        });

        test('a reading that gets everything backwards fails every question', () => {
            const passing = testsFor(name).filter((t) => gradeReading(wrongReading(name), t.expectations).length === 0);
            expect(passing.map((t) => t.name)).toEqual([]);
        });

        test('an interpretation that commits to nothing fails every question', () => {
            const vague = { parameters: [], mostInfluential: 'unclear', leastInfluential: 'unclear' };
            expect(testsFor(name).every((t) => gradeReading(vague, t.expectations).length === (t.expectations.questions?.length ?? 1))).toBe(true);
        });
    });

    test('evaluate reads through the judge once per response and grades the reading', async () => {
        const name = 'Inventory and Workforce';
        judgeReading = perfectReading(name);
        judgeCalls.length = 0;
        for (const t of testsFor(name)) {
            expect(await evaluate({ output: { textContent: 'my interpretation' } }, t.expectations)).toEqual([]);
        }
        expect(new Set(judgeCalls.map((c) => c.key)).size).toBe(1);
        // The judge is never shown the answers.
        const shown = JSON.stringify(judgeCalls[0].messages);
        expect(shown).not.toMatch(/"answer"/);
    });

    test('an empty response is reported without calling the judge', async () => {
        judgeCalls.length = 0;
        const failures = await evaluate({ err: 'boom' }, testsFor('Arms Race')[0].expectations);
        expect(failures.map((f) => f.type)).toEqual(['No response produced']);
        expect(judgeCalls).toEqual([]);
    });
});
