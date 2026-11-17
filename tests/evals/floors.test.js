import fs from 'fs';
import { simTest } from './simTest.js';
import path from 'path';
import { jest } from '@jest/globals';
import { z } from 'zod';
import { setReader } from '../../evals/utilities/judge.js';
import { CATEGORIES, NULL_AGENTS, schemaReading, nullResponse } from '../../evals/floors/nullAgents.js';
import { floorOf } from '../../evals/floors/computeFloors.js';
import { CATEGORY_ROLES } from '../../evals/utilities/categoryRoles.js';

const FLOORS = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'evals/floors/floors.json'), 'utf8'));

describe('null-agent floors', () => {
    jest.setTimeout(3600000);

    test('the readings fill any schema the right way round', () => {
        const schema = z.object({ verdict: z.enum(['yes', 'maybe', 'no']), items: z.array(z.object({ number: z.number(), ok: z.enum(['yes', 'no']) })), peak: z.number().nullable() });
        expect(schemaReading(schema, 'yes').verdict).toBe('yes');
        expect(schemaReading(schema, 'no').verdict).toBe('no');
        expect(schemaReading(schema, 'no').items).toEqual([]);
        expect(schemaReading(schema, 'yes').items[0]).toEqual({ number: 1, ok: 'yes' });
        expect(schemaReading(schema, 'no').peak).toBeNull();
    });

    test('a silent response has nothing in it; the others hand back the model they were given', () => {
        const t = { currentModel: { variables: [{ name: 'x', type: 'stock', equation: '1' }], relationships: [] } };
        expect(nullResponse('silent', t).model.variables).toEqual([]);
        expect(nullResponse('yes', t).model).toEqual(t.currentModel);
    });

    test('every new agent category, and only those, has a role; ten are regression guards', () => {
        expect(Object.keys(CATEGORY_ROLES).sort()).toEqual([...CATEGORIES].sort());
        expect(Object.entries(CATEGORY_ROLES).filter(([, r]) => r.kind === 'regression guard').map(([n]) => n).sort()).toEqual(['causalSources', 'cldInterpretation', 'equilibrium', 'extremeConditions', 'formulationCritique', 'guidedCorrection', 'mece', 'modelToCLD', 'sensitivityInterpretation', 'unitConsistency']);
    });

    test('every new agent category has its floors computed, and every methodology states them', async () => {
        for (const name of CATEGORIES) {
            expect([name, Boolean(FLOORS[name])]).toEqual([name, true]);
            const { methodology } = await import(`../../evals/categories/${name}.js`);
            expect([name, methodology().howItWorks.at(-1).startsWith('Floors:')]).toEqual([name, true]);
            // Every category states its role, just before the floors.
            expect([name, methodology().role?.kind, methodology().howItWorks.at(-2).startsWith('Role: ')]).toEqual([name, CATEGORY_ROLES[name].kind, true]);
        }
    });

    simTest.each(CATEGORIES)('%s: floors.json is what the null agents score', async (name) => {
        const category = await import(`../../evals/categories/${name}.js`);
        try {
            for (const agent of NULL_AGENTS) {
                setReader(agent === 'silent' ? (schema) => schemaReading(schema, 'no') : (schema) => schemaReading(schema, agent));
                expect([name, agent, await floorOf(category, agent)]).toEqual([name, agent, FLOORS[name][agent]]);
            }
        } finally {
            setReader(null);
        }
    });
});
