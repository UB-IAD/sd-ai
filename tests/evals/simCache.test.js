import { jest } from '@jest/globals';
import { simulateModel } from '../../evals/utilities/simulateModel.js';
import { keyFor, readCached } from '../../evals/utilities/simulator/simCache.js';
import SDJsonToXMILE from '../../utilities/SDJsonToXMILE.js';
import utils from '../../utilities/utils.js';
import { scenarios } from '../../evals/utilities/scenarios/library.js';

describe('simulation cache', () => {
    jest.setTimeout(300000);
    const model = scenarios.dialysisClinic.model;
    const outputs = ['Waiting List', 'Chairs'];

    test('a cached result equals a fresh one, and the switch bypasses the cache', async () => {
        const before = process.env.SDAI_SIM_CACHE;
        try {
            process.env.SDAI_SIM_CACHE = 'off';
            const fresh = await simulateModel(model, outputs, { 'build delay': '7' });
            process.env.SDAI_SIM_CACHE = 'on';
            const first = await simulateModel(model, outputs, { 'build delay': '7' });
            const second = await simulateModel(model, outputs, { 'build delay': '7' });
            expect(fresh.ok).toBe(true);
            expect(first).toEqual(fresh);
            expect(second).toEqual(fresh);
        } finally {
            if (before === undefined) delete process.env.SDAI_SIM_CACHE;
            else process.env.SDAI_SIM_CACHE = before;
        }
    });

    test('the key depends on the model and on the variables asked for', () => {
        expect(keyFor('<xmile a/>', ['x'])).not.toBe(keyFor('<xmile b/>', ['x']));
        expect(keyFor('<xmile a/>', ['x'])).not.toBe(keyFor('<xmile a/>', ['x', 'y']));
        expect(keyFor('<xmile a/>', ['x'])).toBe(keyFor('<xmile a/>', ['x']));
    });

    test('a failed run is not stored', async () => {
        // Checked by the run's own key, not by counting files: other processes may write the cache meanwhile.
        const broken = structuredClone(model);
        broken.variables.find((v) => v.name === 'referrals').equation = 'base_referrals / 0 +';
        const r = await simulateModel(broken, outputs, null);
        expect(r.ok).toBe(false);
        const xmile = SDJsonToXMILE({ ...broken, relationships: broken.relationships || [] }, { modelName: 'eval-model', vendor: 'sd-ai-evals', product: 'sd-ai-evals', version: '1.0' });
        expect(readCached(keyFor(xmile, outputs.map((n) => utils.xmileName(n))))).toBeNull();
    });
});
