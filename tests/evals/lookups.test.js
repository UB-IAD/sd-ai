import fs from 'fs';
import { simTest } from './simTest.js';
import path from 'path';
import { scenarios } from '../../evals/utilities/scenarios/library.js';
import { CATEGORIES } from '../../evals/floors/nullAgents.js';

// The harness simulates through PySD, which spaces a lookup's points evenly over its x range and
// ignores the x values given (a known limit, not fixed here: a fix would change results under
// frozen graders). So no lookup in the new categories' fixtures, generated cases or the scenario
// library may have unevenly spaced x points; one that did would be simulated wrongly, and its key
// with it. The existing categories' fixtures (quantitativeErrorFixing's COVID models) are outside
// this suite and are not changed.

/** Every graphical function's points found anywhere in a value. */
const lookupsIn = function(value, where, out, seen) {
    if (!value || typeof value !== 'object' || seen.has(value)) return out;
    seen.add(value);
    if (value.graphicalFunction) {
        const gf = value.graphicalFunction;
        const points = Array.isArray(gf) ? gf : gf.points;
        if (Array.isArray(points) && points.length >= 2) out.push({ where: `${where}: ${value.name ?? '?'}`, xs: points.map((p) => Number(p.x)) });
    }
    for (const [k, v] of Object.entries(value)) lookupsIn(v, `${where}.${k}`.slice(0, 200), out, seen);
    return out;
};

const evenlySpaced = (xs) => xs.every((x, i) => i < 2 || Math.abs((x - xs[i - 1]) - (xs[1] - xs[0])) <= 1e-9 * Math.max(1, Math.abs(xs.at(-1) - xs[0])));

describe('lookups are evenly spaced', () => {
    test('the scenario library', () => {
        const found = lookupsIn(scenarios, 'scenarios', [], new Set());
        // valleyWater's two well-yield lookups at least, so the walk is not looking at nothing.
        expect(found.filter((l) => l.where.includes('valleyWater')).length).toBeGreaterThanOrEqual(2);
        for (const l of found) expect([l.where, l.xs, evenlySpaced(l.xs)]).toEqual([l.where, l.xs, true]);
    });

    simTest('every new category: its data files, and the models its tests hand over', async () => {
        const found = [];
        for (const name of CATEGORIES) {
            const dir = path.join('evals/categories', `${name}Data`);
            if (fs.existsSync(dir)) {
                for (const f of fs.readdirSync(dir, { recursive: true }).filter((x) => String(x).endsWith('.json'))) {
                    lookupsIn(JSON.parse(fs.readFileSync(path.join(dir, String(f)), 'utf8')), `${name}Data/${f}`, found, new Set());
                }
            }
            const { groups } = await import(`../../evals/categories/${name}.js`);
            for (const t of Object.values(groups).flat()) lookupsIn(t.currentModel, `${name} / ${t.name}`, found, new Set());
        }
        for (const l of found) expect([l.where, l.xs, evenlySpaced(l.xs)]).toEqual([l.where, l.xs, true]);
    });

    test('the check catches an uneven lookup', () => {
        expect(evenlySpaced([0, 1, 10])).toBe(false);
        expect(evenlySpaced([0, 160, 320])).toBe(true);
        expect(evenlySpaced([0, 0.25, 0.5, 0.75, 1])).toBe(true);
    });
});
