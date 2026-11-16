import crypto from 'crypto';
import fs from 'fs';
import { CATEGORIES } from '../../evals/floors/nullAgents.js';

// Every test that existed at the Phase 1 freeze (d6a2cad; 9a7c08a changed no test) must still be
// in the same group with the same prompt, model, parameters and expectations. Later additions —
// a batch of held-out scenarios, a lever applied to new cases — may only add tests. The snapshot
// is a hash per test, with the checkout's own path written as <ROOT> (attachments carry it).
const SNAPSHOT = JSON.parse(fs.readFileSync('tests/evals/fixtures/groupsAtFreeze.json', 'utf8'));
const ROOT = process.cwd() + '/';
const hashOf = (t) => crypto.createHash('sha256').update(JSON.stringify([t.prompt, t.currentModel, t.additionalParameters, t.expectations]).split(ROOT).join('<ROOT>/')).digest('hex').slice(0, 16);

describe('frozen tests', () => {
    test('the snapshot holds every group of every category at the freeze', () => {
        expect(Object.values(SNAPSHOT).reduce((n, g) => n + Object.keys(g).length, 0)).toBe(1673);
        expect(new Set(Object.keys(SNAPSHOT).map((k) => k.split('/')[0]))).toEqual(new Set(CATEGORIES));
    });

    test.each(CATEGORIES)('%s: every test at the freeze is still there, in the same group, unchanged', async (name) => {
        const { groups } = await import(`../../evals/categories/${name}.js`);
        for (const [key, tests] of Object.entries(SNAPSHOT).filter(([k]) => k.split('/')[0] === name)) {
            const group = key.split('/')[1];
            const now = new Map((groups[group] || []).map((t) => [t.name, hashOf(t)]));
            for (const [testName, hash] of Object.entries(tests)) expect([group, testName, now.get(testName)]).toEqual([group, testName, hash]);
        }
    });
});
