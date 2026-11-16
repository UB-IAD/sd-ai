import { groupTests } from '../../../evals/utilities/heldOut.js';
import { jest } from '@jest/globals';

let verdict = 'unclear';
// For the hard group's lists of surprises: the verdict on each, by number from 1.
let surpriseVerdicts = [];
jest.unstable_mockModule('../../../evals/utilities/judge.js', () => ({
    extract: async (key, messages, schema) => (schema?.shape?.surprises ? { surprises: surpriseVerdicts.map((v, i) => ({ number: i + 1, verdict: v })) } : { verdict }),
    clearJudgeCache: () => {}
}));

const { evaluate, groups, methodology } = await import('../../../evals/categories/mentalModelVsBug.js');
const { cases, generatedCases } = await import('../../../evals/categories/mentalModelVsBugData/cases.js');
const { behaviorMismatch } = await import('../../../evals/utilities/behaviorCompare.js');
const { simulateModel } = await import('../../../evals/utilities/simulateModel.js');
const { findVariable } = await import('../../../evals/utilities/modelDiff.js');

const testsFor = (name) => groupTests(groups, 'mentalModelVsBug').filter((t) => t.expectations.caseName === name);
const run = async (name, response) => {
    const out = {};
    for (const t of testsFor(name)) out[t.expectations.criterion] = (await evaluate(response, t.expectations)).map((f) => f.type);
    return out;
};
const reading = (series, time) => ({
    series,
    last: (n) => series[n][series[n].length - 1],
    at: (n, t) => series[n][time.findIndex((x) => x >= t - 1e-9)]
});
const VERDICT = { bug: 'the model has a mistake', expectation: 'the expectation is mistaken' };

describe('mentalModelVsBug category', () => {
    jest.setTimeout(600000);

    test('half the cases are bugs and half mistaken expectations', () => {
        const kinds = Object.values(cases).map((c) => c.kind);
        expect(kinds.filter((k) => k === 'bug').length).toBe(kinds.filter((k) => k === 'expectation').length);
    });

    test('every bug changes what the model does, and the expectation holds in the correct model but not the planted one', async () => {
        const holds = async (model, check) => {
            const r = await simulateModel(model, check.outputs, check.overrides || null);
            const base = await simulateModel(model, check.outputs, null);
            return r.ok && base.ok && check.holds(reading(r.series, r.time), reading(base.series, base.time));
        };
        for (const [name, c] of Object.entries(cases).filter(([, c]) => c.kind === 'bug')) {
            expect([name, Boolean(await behaviorMismatch(c.given, c.correct, 0.02))]).toEqual([name, true]);
            expect([name, await holds(c.correct, c.check), await holds(c.given, c.check)]).toEqual([name, true, false]);
        }
    });

    test('every mistaken expectation describes what the correct model really does', async () => {
        for (const [name, c] of Object.entries(cases).filter(([, c]) => c.kind === 'expectation')) {
            const r = await simulateModel(c.correct, c.check.outputs, c.check.overrides || null);
            const base = await simulateModel(c.correct, c.check.outputs, null);
            expect([name, r.ok && c.check.holds(reading(r.series, r.time), reading(base.series, base.time))]).toEqual([name, true]);
        }
    });

    test('the prompt does not say which it is', () => {
        for (const t of groupTests(groups, 'mentalModelVsBug')) expect(t.prompt).toMatch(/Is this a mistake in the model, or is my expectation wrong\?/);
    });

    test('generated cases are the general rule applied to every scenario in the library, in pairs', async () => {
        const { generateCases } = await import('../../../evals/categories/mentalModelVsBugData/generate.js');
        const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
        const fs = await import('fs');
        const stored = JSON.parse(fs.readFileSync('evals/categories/mentalModelVsBugData/generated.json', 'utf8'));
        const expected = {};
        for (const s of Object.values(scenarios)) for (const c of await generateCases(s)) expected[c.name] = c;
        expect(stored).toEqual(expected);
        for (const id of new Set(Object.values(generatedCases).map((c) => c.scenario))) {
            const kinds = Object.values(generatedCases).filter((c) => c.scenario === id).map((c) => c.kind);
            expect([id, kinds.filter((k) => k === 'bug').length]).toEqual([id, kinds.filter((k) => k === 'expectation').length]);
        }
    });

    test('no report template predicts the kind: generated reports of either kind share one form', () => {
        // The form of a report, with names, numbers and directions taken out.
        const form = (r) => r.replace(/"[^"]*"/g, 'Q').replace(/[0-9.]+/g, 'N').replace(/\b(higher|lower)\b/g, 'D').replace(/\b(double|halve)\b/g, 'E');
        const kinds = {};
        for (const c of Object.values(generatedCases)) (kinds[form(c.report)] ||= new Set()).add(c.kind);
        for (const [f, k] of Object.entries(kinds)) expect([f, [...k].sort()]).toEqual([f, ['bug', 'expectation']]);
    });

    test('every failure type is documented', () => {
        expect(methodology().criteria.map((c) => c.name)).toEqual(expect.arrayContaining(['Wrong diagnosis', 'Bug not fixed', 'Correct model changed', 'No model produced', 'Evaluation error']));
    });

    describe.each(Object.keys(cases))('%s', (name) => {
        const c = cases[name];
        const second = c.kind === 'bug' ? 'fixed' : 'leftAlone';

        test('the right diagnosis with the correct model passes', async () => {
            verdict = VERDICT[c.kind];
            expect(await run(name, { model: structuredClone(c.correct), supportingInfo: { explanation: 'x' } })).toEqual({ classified: [], [second]: [] });
        });

        test('the wrong diagnosis fails', async () => {
            verdict = VERDICT[c.kind === 'bug' ? 'expectation' : 'bug'];
            expect((await run(name, { model: structuredClone(c.correct), supportingInfo: { explanation: 'x' } })).classified).toEqual(['Wrong diagnosis']);
            verdict = 'unclear';
            expect((await run(name, { model: structuredClone(c.correct), supportingInfo: { explanation: 'x' } })).classified).toEqual(['Wrong diagnosis']);
        });

        if (c.kind === 'bug') {
            test('returning the model unchanged leaves the bug', async () => {
                expect((await run(name, { model: structuredClone(c.given), supportingInfo: { explanation: 'x' } })).fixed).toEqual(['Bug not fixed']);
            });
        }
    });

    test('the same report is a bug in one case and a mistaken expectation in another', () => {
        expect(cases['Closed Town'].report).toBe(cases['Town Population'].report);
        expect([cases['Closed Town'].kind, cases['Town Population'].kind]).toEqual(['bug', 'expectation']);
    });

    test('removing the planted variable altogether counts as a fix when the model then behaves correctly', async () => {
        verdict = VERDICT.bug;
        const town = structuredClone(cases['Closed Town'].given);
        town.variables = town.variables.filter((v) => v.name !== 'newcomers per year' && v.name !== 'immigration');
        findVariable(town.variables, 'Population').inflows = ['births'];
        expect(await run('Closed Town', { model: town, supportingInfo: { explanation: 'x' } })).toEqual({ classified: [], fixed: [] });
    });

    test('the closed town can be fixed through its immigration flow too', async () => {
        verdict = VERDICT.bug;
        const variants = {
            'immigration zeroed': (m) => { findVariable(m.variables, 'immigration').equation = '0'; },
            'immigration unhooked': (m) => { findVariable(m.variables, 'Population').inflows = ['births']; },
            'immigration deleted': (m) => { findVariable(m.variables, 'Population').inflows = ['births']; m.variables = m.variables.filter((v) => v.name !== 'immigration'); }
        };
        for (const [label, change] of Object.entries(variants)) {
            const m = structuredClone(cases['Closed Town'].given);
            change(m);
            expect([label, (await run('Closed Town', { model: m, supportingInfo: { explanation: 'x' } })).fixed]).toEqual([label, []]);
        }
    });

    test('saying "bug" to everything, or returning every model unchanged, scores nothing', async () => {
        for (const [name, c] of Object.entries(cases)) {
            verdict = VERDICT.bug;
            const yes = await run(name, { model: structuredClone(c.given), supportingInfo: { explanation: 'x' } });
            verdict = 'unclear';
            const none = await run(name, { model: structuredClone(c.given), supportingInfo: { explanation: 'x' } });
            expect([name, Object.values(yes).every((f) => f.length > 0), Object.values(none).every((f) => f.length > 0)]).toEqual([name, true, true]);
        }
    });

    test('changing a correct model to match the expectation fails', async () => {
        const coffee = structuredClone(cases['Cooling Coffee'].correct);
        findVariable(coffee.variables, 'cooling').equation = 'MIN(7, (Coffee_Temperature - Room_Temperature) / 0.25)';
        expect((await run('Cooling Coffee', { model: coffee, supportingInfo: { explanation: 'x' } })).leftAlone).toContain('Correct model changed');
        const town = structuredClone(cases['Town Population'].correct);
        findVariable(town.variables, 'newcomers per year').equation = '0';
        expect((await run('Town Population', { model: town, supportingInfo: { explanation: 'x' } })).leftAlone).toContain('Correct model changed');
    });
});

const { HARD, hardReports } = await import('../../../evals/categories/mentalModelVsBug.js');
const { hardCases } = await import('../../../evals/categories/mentalModelVsBugData/cases.js');
const { caseHeldOut } = await import('../../../evals/utilities/heldOut.js');

describe('mentalModelVsBug hard group', () => {
    jest.setTimeout(900000);
    const hardTests = (name) => groupTests(groups, 'mentalModelVsBugHard').filter((t) => t.expectations.caseName === name && t.expectations.criterion !== 'clean');
    const cleanTest = (name) => groupTests(groups, 'mentalModelVsBugHard').find((t) => t.expectations.caseName === name && t.expectations.criterion === 'clean');
    const runAll = async (tests, response) => {
        const out = {};
        for (const t of tests) out[t.name] = (await evaluate(response, t.expectations)).map((f) => f.type);
        return out;
    };
    const respond = (model) => ({ model, supportingInfo: { explanation: 'answer' } });

    test('hard cases are the rule applied to every scenario in the library', async () => {
        const { generateHardCase } = await import('../../../evals/categories/mentalModelVsBugData/hard.js');
        const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
        const expected = {};
        for (const s of Object.values(scenarios)) {
            const c = await generateHardCase(s);
            if (c) expected[c.name] = c;
        }
        expect(Object.fromEntries(Object.entries(hardCases).map(([n, { correct, given, ...g }]) => [n, g]))).toEqual(expected);
    }, 3600000);

    test('the group takes the first dev and first two held-out hard cases, with clean controls on the first of each', () => {
        const dev = Object.keys(hardCases).filter((n) => !caseHeldOut(hardCases[n]));
        const held = Object.keys(hardCases).filter((n) => caseHeldOut(hardCases[n]));
        expect(HARD.faulty).toEqual([...dev.slice(0, 1), ...held.slice(0, 2)]);
        expect(HARD.clean).toEqual([...dev.slice(0, 1), ...held.slice(0, 1)]);
        expect(HARD.faulty.length).toBeGreaterThanOrEqual(2);
        expect(new Set(groupTests(groups, 'mentalModelVsBugHard').map((t) => JSON.stringify([t.prompt, t.currentModel]))).size).toBe(HARD.faulty.length + HARD.clean.length);
    });

    test('every hard case mixes bugs and mistaken expectations; every report holds in the given model, every bug changes behavior, and every expectation stays wrong in the correct model', async () => {
        const { doublingRatio, isOnly } = await import('../../../evals/categories/mentalModelVsBugData/generate.js');
        const { plant } = await import('../../../evals/categories/guidedCorrectionData/generate.js');
        for (const [name, c] of Object.entries(hardCases)) {
            expect(c.items.length).toBeGreaterThanOrEqual(3);
            expect(c.items.some((x) => x.kind === 'bug') && c.items.some((x) => x.kind === 'expectation')).toBe(true);
            for (const e of c.errors) expect([name, e.variable, Boolean(await behaviorMismatch(plant(c.correct, [e]), c.correct, 0.01))]).toEqual([name, e.variable, true]);
            for (const x of c.items) {
                const given = await doublingRatio(c.given, x.stock, x.constant);
                const correct = await doublingRatio(c.correct, x.stock, x.constant);
                expect([name, x.constant, isOnly(given)]).toEqual([name, x.constant, true]);
                expect(x.report).toContain(`${Math.round(100 * Math.abs(given - 1))}%`);
                if (x.kind === 'bug') expect([name, x.constant, correct >= x.band.min && correct <= x.band.max]).toEqual([name, x.constant, true]);
                else expect([name, x.constant, isOnly(correct), Math.abs(correct - x.correctRatio) < 1e-3]).toEqual([name, x.constant, true, true]);
            }
        }
    });

    describe.each(HARD.faulty)('%s', (name) => {
        const c = () => hardCases[name];
        const right = () => c().items.map((x) => (x.kind === 'bug' ? VERDICT.bug : VERDICT.expectation));

        test('telling every surprise for what it is and returning the correct model passes every hard test', async () => {
            surpriseVerdicts = right();
            expect(Object.values(await runAll(hardTests(name), respond(structuredClone(c().correct)))).flat()).toEqual([]);
        });

        test('returning the model unchanged fails every hard test, whether every surprise is called a bug or nothing is decided', async () => {
            for (const verdicts of [c().items.map(() => VERDICT.bug), []]) {
                surpriseVerdicts = verdicts;
                const results = await runAll(hardTests(name), respond(structuredClone(c().given)));
                for (const [n, types] of Object.entries(results)) expect([n, types.length > 0]).toEqual([n, true]);
            }
        });

        test('calling every surprise a bug and "fixing" the expectations too fails the expectation surprises', async () => {
            surpriseVerdicts = c().items.map(() => VERDICT.bug);
            const results = await runAll(hardTests(name), respond(structuredClone(c().correct)));
            for (const t of hardTests(name).filter((x) => x.expectations.criterion === 'item')) {
                expect([t.name, results[t.name].length > 0]).toEqual([t.name, c().items[t.expectations.item].kind === 'expectation']);
            }
        });

        test('bending the model to a mistaken expectation fails that surprise', async () => {
            surpriseVerdicts = right();
            const i = c().items.findIndex((x) => x.kind === 'expectation');
            const x = c().items[i];
            // Make the stock follow the constant one for one, as the modeler expected: a large inflow
            // proportional to the constant swamps everything else the stock does.
            const model = structuredClone(c().correct);
            const value = Number(findVariable(model.variables, x.constant).equation);
            const base = await simulateModel(model, [x.stock], null);
            const end = Math.abs(base.series[x.stock].at(-1));
            const span = model.specs.stopTime - model.specs.startTime;
            model.variables.push({ name: 'expected effect', type: 'flow', equation: `${x.constant.replace(/ /g, '_')} * ${(20 * end) / (value * span)}` });
            findVariable(model.variables, x.stock).inflows = [...(findVariable(model.variables, x.stock).inflows || []), 'expected effect'];
            const t = hardTests(name).find((y) => y.expectations.item === i);
            expect((await evaluate(respond(model), t.expectations)).map((f) => f.type)).toContain('Correct model changed');
        });
    });

    describe.each(HARD.clean)('%s (clean control)', (name) => {
        const c = () => hardCases[name];
        const n = () => hardReports(c(), true).length;

        test('the request lists only mistaken expectations, as measured on the correct model', () => {
            expect(cleanTest(name).prompt).toContain(c().items.find((x) => x.kind === 'expectation').cleanReport);
            for (const x of c().items.filter((y) => y.kind === 'bug')) expect(cleanTest(name).prompt).not.toContain(x.report);
        });

        test('calling every surprise a mistaken expectation and leaving the model alone passes', async () => {
            surpriseVerdicts = Array(n()).fill(VERDICT.expectation);
            expect(await evaluate(respond(structuredClone(c().correct)), cleanTest(name).expectations)).toEqual([]);
        });

        test('calling one a bug, or not deciding, fails even with the model unchanged', async () => {
            for (const verdicts of [[VERDICT.bug, ...Array(n() - 1).fill(VERDICT.expectation)], []]) {
                surpriseVerdicts = verdicts;
                expect((await evaluate(respond(structuredClone(c().correct)), cleanTest(name).expectations)).map((f) => f.type)).toContain('Wrong diagnosis');
            }
        });

        test('"fixing" the correct model fails', async () => {
            const { plant } = await import('../../../evals/categories/guidedCorrectionData/generate.js');
            surpriseVerdicts = Array(n()).fill(VERDICT.expectation);
            for (const e of c().errors) {
                expect((await evaluate(respond(plant(c().correct, [e])), cleanTest(name).expectations)).map((f) => f.type)).toEqual(['Correct model changed']);
            }
        });
    });
});

const { hard2Cases } = await import('../../../evals/categories/mentalModelVsBugData/cases.js');

describe('mentalModelVsBug second hard group (every surprise graded together)', () => {
    jest.setTimeout(900000);
    const hard2Test = (name) => groupTests(groups, 'mentalModelVsBugHard2').find((t) => t.expectations.caseName === name);
    const respond = (model) => ({ model, supportingInfo: { explanation: 'answer' } });
    const grade = async (name, model) => (await evaluate(respond(model), hard2Test(name).expectations)).map((f) => f.type);
    const names = Object.keys(hard2Cases);

    test('hard2.json is the rule applied to every held-out scenario, from the generated pairs and the first hard group', async () => {
        const fs = await import('fs');
        const { generateHard2Case } = await import('../../../evals/categories/mentalModelVsBugData/hard2.js');
        const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
        const generated = Object.values(JSON.parse(fs.readFileSync('evals/categories/mentalModelVsBugData/generated.json', 'utf8')));
        const firstHard = Object.values(JSON.parse(fs.readFileSync('evals/categories/mentalModelVsBugData/hard.json', 'utf8')));
        const expected = {};
        for (const s of Object.values(scenarios).filter((x) => x.split === 'heldout')) {
            const c = await generateHard2Case(s, generated.filter((g) => g.scenario === s.id), firstHard);
            if (c) expected[c.name] = c;
        }
        expect(Object.fromEntries(Object.entries(hard2Cases).map(([n, { correct, given, ...g }]) => [n, g]))).toEqual(expected);
    }, 3600000);

    test('the group holds only held-out cases, at least three, one test each, every prompt new', () => {
        expect(groups.mentalModelVsBugHard2).toBeUndefined();
        expect(names.length).toBeGreaterThanOrEqual(3);
        expect(groupTests(groups, 'mentalModelVsBugHard2').map((t) => t.expectations.caseName)).toEqual(names);
        for (const n of names) expect([n, caseHeldOut(hard2Cases[n])]).toEqual([n, true]);
        const earlier = new Set(Object.values(groups).flat().filter((t) => !t.expectations.hard2).map((t) => t.prompt));
        for (const n of names) expect([n, earlier.has(hard2Test(n).prompt)]).toEqual([n, false]);
    });

    test('every case has as many bugs as mistaken expectations; every report holds in the given model, every bug changes behavior, every expectation stays wrong in the correct model', async () => {
        const { doublingRatio, isOnly } = await import('../../../evals/categories/mentalModelVsBugData/generate.js');
        const { plant } = await import('../../../evals/categories/guidedCorrectionData/generate.js');
        for (const [name, c] of Object.entries(hard2Cases)) {
            const bugs = c.items.filter((x) => x.kind === 'bug').length;
            expect([name, bugs >= 1, bugs * 2 === c.items.length, c.errors.length === bugs]).toEqual([name, true, true, true]);
            for (const e of c.errors) expect([name, e.variable, Boolean(await behaviorMismatch(plant(c.correct, [e]), c.correct, 0.01))]).toEqual([name, e.variable, true]);
            for (const x of c.items) {
                const given = await doublingRatio(c.given, x.stock, x.constant);
                const correct = await doublingRatio(c.correct, x.stock, x.constant);
                expect([name, x.constant, isOnly(given)]).toEqual([name, x.constant, true]);
                expect(hard2Test(name).prompt).toContain(x.report);
                expect(x.report).toContain(`${Math.round(100 * Math.abs(given - 1))}%`);
                if (x.kind === 'bug') expect([name, x.constant, correct >= x.band.min && correct <= x.band.max]).toEqual([name, x.constant, true]);
                else expect([name, x.constant, isOnly(correct), Math.abs(correct - x.correctRatio) < 1e-3]).toEqual([name, x.constant, true, true]);
            }
        }
    });

    describe.each(names)('%s', (name) => {
        const c = () => hard2Cases[name];
        const right = () => c().items.map((x) => (x.kind === 'bug' ? VERDICT.bug : VERDICT.expectation));

        test('telling every surprise for what it is and returning the correct model passes', async () => {
            surpriseVerdicts = right();
            expect(await grade(name, structuredClone(c().correct))).toEqual([]);
        });

        test('doing nothing fails: the model unchanged, whatever is said, and no model at all', async () => {
            for (const verdicts of [right(), c().items.map(() => VERDICT.bug), c().items.map(() => VERDICT.expectation), []]) {
                surpriseVerdicts = verdicts;
                expect((await grade(name, structuredClone(c().given))).length > 0).toBe(true);
            }
            surpriseVerdicts = right();
            expect(await grade(name, { variables: [], relationships: [] })).toEqual(['No model produced']);
        });

        test('a constant verdict fails even with the correct model returned: all bugs, all mistaken expectations, or none decided', async () => {
            for (const verdicts of [c().items.map(() => VERDICT.bug), c().items.map(() => VERDICT.expectation), []]) {
                surpriseVerdicts = verdicts;
                expect(await grade(name, structuredClone(c().correct))).toContain('Wrong diagnosis');
            }
        });

        test('an answer at the level of the first hard group fails: every surprise but one right, or every verdict right with a bug left in', async () => {
            for (let i = 0; i < c().items.length; i++) {
                surpriseVerdicts = right().map((v, j) => (j === i ? (v === VERDICT.bug ? VERDICT.expectation : VERDICT.bug) : v));
                expect(await grade(name, structuredClone(c().correct))).toEqual(['Wrong diagnosis']);
            }
            surpriseVerdicts = right();
            expect(await grade(name, structuredClone(c().given))).toContain('Bug not fixed');
        });

        test('bending the model to a mistaken expectation fails', async () => {
            surpriseVerdicts = right();
            const x = c().items.find((y) => y.kind === 'expectation');
            const model = structuredClone(c().correct);
            const value = Number(findVariable(model.variables, x.constant).equation);
            const base = await simulateModel(model, [x.stock], null);
            const end = Math.abs(base.series[x.stock].at(-1));
            const span = model.specs.stopTime - model.specs.startTime;
            model.variables.push({ name: 'expected effect', type: 'flow', equation: `${x.constant.replace(/ /g, '_')} * ${(20 * end) / (value * span)}` });
            findVariable(model.variables, x.stock).inflows = [...(findVariable(model.variables, x.stock).inflows || []), 'expected effect'];
            expect(await grade(name, model)).toContain('Correct model changed');
        });
    });
});
