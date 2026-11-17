import { groupTests } from '../../../evals/utilities/heldOut.js';
import { simTest } from '../simTest.js';
import { jest } from '@jest/globals';

let said = {};
jest.unstable_mockModule('../../../evals/utilities/judge.js', () => ({
    extract: async (key, messages) => {
        const listed = messages[1].content.split('Review:')[0];
        const items = [...listed.matchAll(/^(\d+)\. \[[^\]]*\] (.*)$/gm)].map((m) => ({ number: Number(m[1]), text: m[2] }));
        return Object.fromEntries(items.map((x) => [`q${x.number}`, said[x.text] ?? 'not discussed']));
    },
    clearJudgeCache: () => {}
}));

const { evaluate, groups, methodology, modelFor, HARD_TAKEN } = await import('../../../evals/categories/transferability.js');
const { cases, hardCases } = await import('../../../evals/categories/transferabilityData/cases.js');
const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
const { goalOn } = await import('../../../evals/categories/policyImplementation.js');
const { findVariable } = await import('../../../evals/utilities/modelDiff.js');
const { glossaryModel } = await import('../../../evals/utilities/scenarios/renameModel.js');

const testsFor = (name) => groupTests(groups, 'transferability').filter((t) => t.expectations.caseName === name);
const run = async (name, explanation) => {
    const out = {};
    for (const t of testsFor(name)) out[t.expectations.assumptions.join("+")] = (await evaluate({ supportingInfo: { explanation } }, t.expectations)).map((f) => f.type);
    return out;
};

describe('transferability category', () => {
    jest.setTimeout(600000);

    simTest.each(Object.keys(cases))('%s: the policy meets the goal as given, and misses it once the unrealistic assumptions are reverted', async (name) => {
        const c = cases[name];
        const s = scenarios[c.scenario];
        expect((await goalOn(modelFor(c, false), s)).meets).toBe(true);
        expect((await goalOn(modelFor(c, true), s)).meets).toBe(false);
    });

    test('every assumption names a real variable; sound ones keep the scenario\'s value; reverts are the scenario\'s values', () => {
        for (const c of Object.values(cases)) {
            const base = glossaryModel(scenarios[c.scenario]);
            expect(c.assumptions.filter((a) => a.realistic).length).toBe(2);
            expect(c.assumptions.filter((a) => !a.realistic).length).toBe(2);
            for (const a of c.assumptions) {
                const v = findVariable(base.variables, a.variable);
                expect([a.variable, Boolean(v)]).toEqual([a.variable, true]);
                if (a.realistic) expect(a.value).toBeUndefined();
                else expect([a.variable, a.revert]).toEqual([a.variable, v.equation]);
            }
        }
    });

    test('the wording does not give the answer away: each case has an unrealistic note that cites a source and a sound note written as an assumption', () => {
        for (const [name, c] of Object.entries(cases)) {
            const assumed = (a) => /^Assumed\b/.test(a.note);
            expect([name, c.assumptions.some((a) => !a.realistic && !assumed(a)), c.assumptions.some((a) => a.realistic && assumed(a))]).toEqual([name, true, true]);
        }
    });

    test('a caveat on a sound assumption is not a flag', async () => {
        const c = Object.values(cases)[0];
        const name = Object.keys(cases)[0];
        said = Object.fromEntries(c.assumptions.map((a) => [a.note, a.realistic ? 'accepted with minor caveats' : 'flagged as unrealistic']));
        expect(Object.values(await run(name, 'x')).flat()).toEqual([]);
    });

    simTest('every generated case is the general rule applied to its scenario, and every scenario without a hand-written case has one or cannot give one', async () => {
        const { generateCase } = await import('../../../evals/categories/transferabilityData/generate.js');
        const { handCases } = await import('../../../evals/categories/transferabilityData/cases.js');
        const covered = new Set(Object.values(handCases).map((c) => c.scenario));
        for (const [id, s] of Object.entries(scenarios)) {
            if (covered.has(id)) continue;
            const c = await generateCase(s);
            expect([id, cases[s.title] ?? null]).toEqual([id, c]);
        }
    });

    simTest('the general rule gives a valid case on every dev scenario too: met as given, missed when reverted, wording balanced', async () => {
        const { generateCase } = await import('../../../evals/categories/transferabilityData/generate.js');
        for (const id of ['dialysisClinic', 'bikeShare', 'distributor']) {
            const c = await generateCase(scenarios[id]);
            expect([id, Boolean(c)]).toEqual([id, true]);
            expect([id, (await goalOn(modelFor(c, false), scenarios[id])).meets, (await goalOn(modelFor(c, true), scenarios[id])).meets]).toEqual([id, true, false]);
            const assumed = (a) => /^Assumed\b/.test(a.note);
            expect([id, c.assumptions.some((a) => !a.realistic && !assumed(a)), c.assumptions.some((a) => a.realistic && assumed(a)), new Set(c.assumptions.map((a) => a.variable)).size]).toEqual([id, true, true, 4]);
        }
    });

    simTest('the rule gives no case when the policy alone already meets the goal, or a limit cannot be passed', async () => {
        const { generateCase } = await import('../../../evals/categories/transferabilityData/generate.js');
        // Shallow copies: a scenario's physical limits hold functions, which cannot be cloned.
        expect(await generateCase({ ...scenarios.dialysisClinic, misconception: 'order more aggressively' })).toBeNull();
        expect(await generateCase({ ...scenarios.distributor, realistic: { ...scenarios.distributor.realistic, bounds: { 'supply line weight': { min: 0 }, 'expectation time': { min: 0 } } } })).toBeNull();
    });

    test('the prompt names neither which assumptions are unrealistic nor their notes', () => {
        for (const [name, c] of Object.entries(cases)) for (const a of c.assumptions) expect(testsFor(name)[0].prompt).not.toContain(a.note);
    });

    test('every failure type is documented', () => {
        expect(methodology().criteria.map((c) => c.name)).toEqual(expect.arrayContaining(['Unrealistic assumption missed', 'Sound assumption doubted', 'No answer given', 'Evaluation error']));
    });

    describe.each(Object.keys(cases))('%s', (name) => {
        const c = cases[name];
        const noteOf = (realistic) => c.assumptions.filter((a) => a.realistic === realistic).map((a) => a.note);

        test('flagging exactly the unrealistic assumptions passes everything', async () => {
            said = Object.fromEntries([...noteOf(false).map((n) => [n, 'flagged as unrealistic']), ...noteOf(true).map((n) => [n, 'accepted as sound'])]);
            expect(Object.values(await run(name, 'x')).flat()).toEqual([]);
        });

        test('doubting everything fails the sound assumptions', async () => {
            said = Object.fromEntries(c.assumptions.map((a) => [a.note, 'flagged as unrealistic']));
            expect(Object.values(await run(name, 'x')).flat()).toEqual(['Sound assumption doubted', 'Sound assumption doubted']);
        });

        test('accepting everything fails the unrealistic assumptions, and so does silence', async () => {
            said = Object.fromEntries(c.assumptions.map((a) => [a.note, 'accepted as sound']));
            expect(Object.values(await run(name, 'x')).flat()).toEqual(['Unrealistic assumption missed', 'Unrealistic assumption missed']);
            said = {};
            expect(Object.values(await run(name, 'x')).flat()).toEqual(['Unrealistic assumption missed', 'Unrealistic assumption missed']);
        });
    });

    describe('hard group: three unrealistic among three sound, no hint', () => {
        const hard = groupTests(groups, 'transferabilityHard');
        const hardRun = async (name, explanation) => (await evaluate({ supportingInfo: { explanation } }, hard.find((t) => t.expectations.caseName === name).expectations)).map((f) => f.type);

        simTest('hardGenerated.json is the general rule applied to every scenario, re-derived by simulation', async () => {
            const { generateHardCase } = await import('../../../evals/categories/transferabilityData/generate.js');
            const expected = {};
            for (const s of Object.values(scenarios)) {
                const c = await generateHardCase(s);
                if (c) expected[`${s.title}: three and three`] = c;
            }
            expect(hardCases).toEqual(expected);
        });

        test('the group has dev and held-out cases, one generation each, and the prompt neither hints nor gives the notes away', () => {
            expect(groups.transferabilityHard.length).toBeGreaterThan(0);
            expect(groups.transferabilityHardHeldOut.length).toBeGreaterThan(0);
            expect(hard.map((t) => t.expectations.caseName)).toEqual(HARD_TAKEN);
            for (const t of hard) {
                expect(t.prompt).not.toMatch(/unrealistic|assumption|sound|realistic in practice|work in practice/i);
                for (const a of hardCases[t.expectations.caseName].assumptions) expect(t.prompt).not.toContain(a.note);
            }
        });

        test('the group takes every first-batch hard case, and a later-batch one only with a limited lever noted within its limit', async () => {
            const { laterBatch } = await import('../../../evals/utilities/heldOut.js');
            expect(Object.keys(hardCases).filter((n) => !laterBatch(hardCases[n])).every((n) => HARD_TAKEN.includes(n))).toBe(true);
            expect(HARD_TAKEN.length).toBeGreaterThan(0);
        });

        simTest.each(HARD_TAKEN)('%s: three unrealistic, three sound and every other limited lever within its limit, distinct variables, wording balanced; meets the goal as given, misses it reverted', async (name) => {
            const c = hardCases[name];
            const s = scenarios[c.scenario];
            const base = glossaryModel(s);
            const bounded = (a) => Object.keys(s.realistic.bounds).some((b) => b.toLowerCase() === a.variable.toLowerCase());
            expect(c.assumptions.filter((a) => !a.realistic).length).toBe(3);
            expect(c.assumptions.filter((a) => a.realistic && !bounded(a)).length).toBe(3);
            expect(new Set(c.assumptions.map((a) => a.variable)).size).toBe(c.assumptions.length);
            // Every limited lever is noted: the three pushed past their limits, the rest within them.
            expect(c.assumptions.filter(bounded).length).toBe(Object.keys(s.realistic.bounds).length);
            const withinLevers = c.assumptions.filter((a) => a.realistic && bounded(a));
            expect(withinLevers.length).toBeGreaterThanOrEqual(1);
            const model = modelFor(c, false);
            for (const a of withinLevers) {
                const b = s.realistic.bounds[Object.keys(s.realistic.bounds).find((k) => k.toLowerCase() === a.variable.toLowerCase())];
                const x = Number(findVariable(model.variables, a.variable).equation);
                expect([a.variable, a.note.includes(String(x)), (b.max === undefined || x <= b.max) && (b.min === undefined || x >= b.min)]).toEqual([a.variable, true, true]);
            }
            // The within-limit levers share the pushed ones' wording.
            const wording = (a) => a.note.replace(/"[^"]*"/, '""').replace(/-?[\d.e-]+(?=\.?$| is achievable)/, 'N');
            expect(new Set(withinLevers.map(wording)).size).toBeGreaterThan(0);
            for (const a of withinLevers) expect([a.variable, c.assumptions.filter((u) => !u.realistic).map(wording)]).toEqual([a.variable, expect.arrayContaining([wording(a)])]);
            const assumed = (a) => /^Assumed\b/.test(a.note);
            for (const realistic of [true, false]) {
                const side = c.assumptions.filter((a) => a.realistic === realistic);
                expect([name, realistic, side.some(assumed), side.some((a) => !assumed(a))]).toEqual([name, realistic, true, true]);
            }
            for (const a of c.assumptions) {
                const v = findVariable(base.variables, a.variable);
                if (a.realistic) expect(a.value).toBeUndefined();
                else {
                    expect([a.variable, a.revert]).toEqual([a.variable, v.equation]);
                    // Past the realistic limit the scenario states, in the prompt's own context.
                    const b = s.realistic.bounds[a.variable];
                    expect([a.variable, (b.max !== undefined && Number(a.value) > b.max) || (b.min !== undefined && Number(a.value) < b.min)]).toEqual([a.variable, true]);
                }
            }
            expect((await goalOn(modelFor(c, false), s)).meets).toBe(true);
            expect((await goalOn(modelFor(c, true), s)).meets).toBe(false);
        });

        test.each(HARD_TAKEN)('%s: exactly the unrealistic ones flagged passes; any constant reading, one miss or one false alarm fails', async (name) => {
            const c = hardCases[name];
            const reading = (f) => Object.fromEntries(c.assumptions.map((a) => [a.note, f(a)]));
            said = reading((a) => (a.realistic ? 'accepted with minor caveats' : 'flagged as unrealistic'));
            expect(await hardRun(name, 'x')).toEqual([]);
            said = reading((a) => (a.realistic ? 'not discussed' : 'flagged as unrealistic'));
            expect(await hardRun(name, 'x')).toEqual([]);
            for (const constant of ['flagged as unrealistic', 'accepted as sound', 'accepted with minor caveats', 'not discussed']) {
                said = reading(() => constant);
                expect((await hardRun(name, 'x')).length).toBeGreaterThanOrEqual(3);
            }
            const [u] = c.assumptions.filter((a) => !a.realistic);
            const [r] = c.assumptions.filter((a) => a.realistic);
            said = reading((a) => (!a.realistic && a !== u ? 'flagged as unrealistic' : 'accepted as sound'));
            expect(await hardRun(name, 'x')).toEqual(['Unrealistic assumption missed']);
            said = reading((a) => (!a.realistic || a === r ? 'flagged as unrealistic' : 'accepted as sound'));
            expect(await hardRun(name, 'x')).toEqual(['Sound assumption doubted']);
            // Doubting every lever the account puts a limit on, within it or not, fails.
            const bounded = (a) => Object.keys(scenarios[c.scenario].realistic.bounds).some((b) => b.toLowerCase() === a.variable.toLowerCase());
            said = reading((a) => (bounded(a) ? 'flagged as unrealistic' : 'accepted as sound'));
            expect(await hardRun(name, 'x')).toEqual(c.assumptions.filter((a) => a.realistic && bounded(a)).map(() => 'Sound assumption doubted'));
            said = {};
            expect(await hardRun(name, '')).toEqual(['No answer given']);
        });
    });
});
