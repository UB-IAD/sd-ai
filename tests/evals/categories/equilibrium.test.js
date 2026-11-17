import { jest } from '@jest/globals';
import { simTest } from '../simTest.js';
import { evaluate, groups, methodology, cases, generatedCases, hardGeneratedCases, RELATIVE_TOLERANCE } from '../../../evals/categories/equilibrium.js';
import { findVariable } from '../../../evals/utilities/modelDiff.js';

// Fake engines of known quality. Each takes the test and returns what that engine would answer.
const withEquations = function(model, equations) {
    const copy = structuredClone(model);
    for (const [name, equation] of Object.entries(equations)) {
        findVariable(copy.variables, name).equation = equation;
    }
    return { model: copy };
};

const testsByCase = Object.fromEntries(
    Object.values(groups).flat().map((test) => [test.name.replace(/ equilibrium$/, ''), test])
);

const typesOf = (failures) => failures.map((f) => f.type);

describe('equilibrium category', () => {
    jest.setTimeout(120000);

    test('every case is in a group and every failure type is documented', () => {
        expect(Object.keys(testsByCase).sort()).toEqual(Object.keys(cases).sort());
        const documented = methodology().criteria.map((c) => c.name);
        expect(documented).toEqual(expect.arrayContaining(['Stock not in equilibrium', 'Model structure changed', 'Constraint violated', 'Simulation error', 'No model produced']));
    });

    test('the prompt never leaks the solution (beyond the level a case states a stock must sit at)', () => {
        for (const [name, evalTest] of Object.entries(testsByCase)) {
            for (const [variable, value] of Object.entries(cases[name].solution)) {
                if (variable in (cases[name].fixedInitial || {})) continue;
                // As a number of its own: the 0 in a stated level of 20 is not the solution's 0.
                const asNumber = new RegExp(`(?<![\\d.])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\d.])`);
                expect([name, variable, asNumber.test(evalTest.prompt)]).toEqual([name, variable, false]);
            }
        }
    });

    simTest('generated cases are the general rule applied to every scenario in the library', async () => {
        const { generateCase, RELATIVE_TOLERANCE: ruleTolerance } = await import('../../../evals/categories/equilibriumData/generate.js');
        const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
        expect(ruleTolerance).toBe(RELATIVE_TOLERANCE);
        const expected = {};
        for (const s of Object.values(scenarios)) {
            const c = await generateCase(s);
            if (c) expected[c.name] = c;
        }
        expect(Object.fromEntries(Object.entries(generatedCases).map(([n, { model, ...g }]) => [n, g]))).toEqual(expected);
    }, 1800000);

    describe.each(Object.keys(cases))('%s', (name) => {
        const c = cases[name];
        const evalTest = testsByCase[name];

        simTest('the model as given is not in equilibrium (an engine that changes nothing fails)', async () => {
            const failures = await evaluate({ model: structuredClone(c.model) }, evalTest.expectations);
            expect(typesOf(failures)).toContain('Stock not in equilibrium');
        });

        simTest('the known solution passes (the case is solvable within its rules)', async () => {
            const failures = await evaluate(withEquations(c.model, c.solution), evalTest.expectations);
            expect(failures).toEqual([]);
        });

        simTest('zeroing every flow fails as a structural change, even though the stocks are flat', async () => {
            const flows = c.model.variables.filter((v) => v.type === 'flow').map((v) => v.name);
            const zeroed = withEquations(c.model, Object.fromEntries(flows.map((f) => [f, '0'])));
            const failures = await evaluate(zeroed, evalTest.expectations);
            expect(typesOf(failures)).toContain('Model structure changed');
            expect(typesOf(failures)).not.toContain('Stock not in equilibrium');
        });
    });

    simTest('a helper constant feeding only an initial value is allowed', async () => {
        const c = cases['Predators and Prey'];
        const response = withEquations(c.model, { 'Prey': 'initial_prey', 'Predators': '300' });
        response.model.variables.push({ name: 'initial prey', type: 'variable', equation: '400', units: 'animals' });
        expect(await evaluate(response, testsByCase['Predators and Prey'].expectations)).toEqual([]);
    });

    simTest('the trivial empty equilibrium is rejected where the case forbids it', async () => {
        const c = cases['Predators and Prey'];
        const failures = await evaluate(withEquations(c.model, { 'Prey': '0', 'Predators': '0' }), testsByCase['Predators and Prey'].expectations);
        expect(typesOf(failures)).toContain('Constraint violated');
    });

    simTest('balancing by changing a constant the case did not permit fails', async () => {
        const c = cases['Town Population'];
        // birth fraction 0.035 balances deaths of 0.025 plus 10 newcomers... but it is not adjustable here.
        const failures = await evaluate(withEquations(c.model, { 'birth fraction': '0.015' }), testsByCase['Town Population'].expectations);
        expect(typesOf(failures)).toContain('Model structure changed');
    });

    simTest('turning an adjustable constant into a feedback expression fails, even though the stock is flat', async () => {
        const c = cases['Town Population'];
        const response = withEquations(c.model, { 'newcomers per year': 'Population / average_lifetime - Population * birth_fraction' });
        const failures = await evaluate(response, testsByCase['Town Population'].expectations);
        expect(typesOf(failures)).toEqual(['Model structure changed']);
    });

    simTest('an adjustable constant written as arithmetic on numbers is still a constant', async () => {
        const c = cases['Population Aging Chain'];
        const response = withEquations(c.model, { ...c.solution, fertility: '1/45' });
        expect(await evaluate(response, testsByCase['Population Aging Chain'].expectations)).toEqual([]);
        const scientific = withEquations(c.model, { ...c.solution, fertility: '1e3/45e3' });
        expect(await evaluate(scientific, testsByCase['Population Aging Chain'].expectations)).toEqual([]);
    });

    test('a missing model is reported, not thrown', async () => {
        const failures = await evaluate({ err: 'boom' }, testsByCase['Reservoir'].expectations);
        expect(typesOf(failures)).toEqual(['No model produced']);
    });

    describe('hard group: one stock at a stated level only a changed constant gives', () => {
        simTest('hardGenerated.json is the general rule applied to every scenario, re-derived by simulation, dev and held out', async () => {
            const { hardCaseFor } = await import('../../../evals/categories/equilibriumData/hard.js');
            const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
            const expected = {};
            for (const s of Object.values(scenarios)) {
                const c = await hardCaseFor(s);
                if (c) expected[c.name] = c;
            }
            expect(Object.fromEntries(Object.entries(hardGeneratedCases).map(([n, { model, ...g }]) => [n, g]))).toEqual(expected);
            expect(groups.scenarioEquilibriumHard.length).toBeGreaterThan(0);
            expect(groups.scenarioEquilibriumHardHeldOut.length).toBeGreaterThan(0);
        }, 1800000);

        describe.each(Object.keys(hardGeneratedCases))('%s', (name) => {
            const c = cases[name];
            const t = testsByCase[name];
            const base = Object.values(generatedCases).find((g) => g.scenario === c.scenario);
            const [held] = Object.keys(c.fixedInitial);

            test('the prompt names the stated level but withholds which constant to change: any one of the model\'s constants may', () => {
                expect(t.prompt).toContain(`"${held}" must sit at ${c.fixedInitial[held]}`);
                expect(t.prompt).not.toContain(`"${c.lever}"`);
                expect(t.prompt).toMatch(/one constant/);
                expect(c.adjustable).toEqual(c.equilibriumStocks);
                expect(c.oneConstantOf).toContain(c.lever);
                expect(c.oneConstantOf.length).toBeGreaterThan(1);
            });

            simTest('the known solution with the lever passes; moving a second constant as well fails', async () => {
                expect(await evaluate(withEquations(c.model, c.solution), t.expectations)).toEqual([]);
                const other = c.model.variables.find((v) => c.oneConstantOf.includes(v.name) && v.name !== c.lever);
                const two = withEquations(c.model, { ...c.solution, [other.name]: String(Number(other.equation) + 1) });
                expect(typesOf(await evaluate(two, t.expectations))).toContain('Model structure changed');
            });

            simTest('the model\'s own equilibrium (constant unchanged), that equilibrium with the stock forced to the level, and emptying the model all fail', async () => {
                expect(typesOf(await evaluate(withEquations(c.model, base.solution), t.expectations))).toEqual(['Constraint violated']);
                const forced = typesOf(await evaluate(withEquations(c.model, { ...base.solution, [held]: String(c.fixedInitial[held]) }), t.expectations));
                expect(forced).toContain('Stock not in equilibrium');
                expect((await evaluate(withEquations(c.model, Object.fromEntries(c.equilibriumStocks.map((n) => [n, '0']))), t.expectations)).length).toBeGreaterThan(0);
            });

            simTest('a constant answer — every adjustable value set to the stated level — fails, and so does no model', async () => {
                const constant = Object.fromEntries(c.adjustable.map((n) => [n, String(c.fixedInitial[held])]));
                expect((await evaluate(withEquations(c.model, constant), t.expectations)).length).toBeGreaterThan(0);
                expect(typesOf(await evaluate({ model: { variables: [] } }, t.expectations))).toEqual(['No model produced']);
            });
        });
    });
});
