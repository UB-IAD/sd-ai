import { jest } from '@jest/globals';
import { simTest } from '../simTest.js';
import { runAnalysisTool, nelderMead, fitError, ANALYSIS_TOOL_DEFINITIONS } from '../../../evals/utilities/analysisTools.js';
import { cases } from '../../../evals/categories/equilibriumData/models.js';

const reservoir = cases['Reservoir'].model;

describe('analysis tools', () => {
    jest.setTimeout(600000);

    test('every tool has a name, description and object schema', () => {
        for (const t of ANALYSIS_TOOL_DEFINITIONS) {
            expect(t.name).toMatch(/^[a-z_]+$/);
            expect(t.description.length).toBeGreaterThan(20);
            expect(t.inputSchema.type).toBe('object');
        }
    });

    test('nelderMead can start from a given point, and still finds the minimum', async () => {
        const r = await nelderMead(async ([x, y]) => (x - 3) ** 2 + (y + 1) ** 2, [{ min: -10, max: 10 }, { min: -10, max: 10 }], 300, [9, 9]);
        expect(r.best[0]).toBeCloseTo(3, 2);
        expect(r.best[1]).toBeCloseTo(-1, 2);
    });

    test('nelderMead finds the minimum of a bowl inside its bounds', async () => {
        const r = await nelderMead(async ([x, y]) => (x - 3) ** 2 + (y + 1) ** 2, [{ min: -10, max: 10 }, { min: -10, max: 10 }], 300, null);
        expect(r.best[0]).toBeCloseTo(3, 2);
        expect(r.best[1]).toBeCloseTo(-1, 2);
    });

    test('fitError interpolates between run points', () => {
        expect(fitError([0, 1, 2], [0, 10, 20], [{ time: 0.5, value: 5 }, { time: 2, value: 21 }])).toBeCloseTo(1, 9);
    });

    simTest('run_scenario applies overrides without changing the model', async () => {
        const before = JSON.stringify(reservoir);
        const r = await runAnalysisTool('run_scenario', { overrides: { 'inflow rate': 0 }, outputs: ['Water in Reservoir'] }, reservoir, null);
        expect(r.outputs['Water in Reservoir'].at(-1)).toBeLessThan(5);
        expect(JSON.stringify(reservoir)).toBe(before);
    });

    simTest('run_calibration recovers a parameter from data the model itself produced', async () => {
        const truth = await runAnalysisTool('run_scenario', { overrides: { 'residence time': 6 }, outputs: ['Water in Reservoir'] }, reservoir, null);
        const data = { series: { water: truth.time.map((t, i) => ({ time: t, value: truth.outputs['Water in Reservoir'][i] })) } };
        const r = await runAnalysisTool('run_calibration', { parameters: [{ name: 'residence time', min: 1, max: 12 }], variable: 'Water in Reservoir', series: 'water' }, reservoir, data);
        expect(r.best['residence time']).toBeCloseTo(6, 0);
        expect(r.rSquared).toBeGreaterThan(0.99);
    });

    simTest('run_optimization finds the lever value that best meets the objective', async () => {
        const r = await runAnalysisTool('run_optimization', { lever: { name: 'residence time', min: 1, max: 10 }, variable: 'Water in Reservoir', measure: 'final', goal: 'minimize' }, reservoir, null);
        expect(r.best['residence time']).toBe(1);
    });

    test('unknown names and missing data are errors, not crashes', async () => {
        expect((await runAnalysisTool('run_scenario', { overrides: { nope: 1 }, outputs: ['Water in Reservoir'] }, reservoir, null)).error).toMatch(/nope/);
        expect((await runAnalysisTool('load_calibration_data', {}, reservoir, null)).error).toMatch(/No historical data/);
    });
});
