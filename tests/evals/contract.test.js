import { jest } from '@jest/globals';
import { simTest } from './simTest.js';
import { setReader } from '../../evals/utilities/judge.js';
import { CATEGORIES, NULL_AGENTS, schemaReading, nullResponse } from '../../evals/floors/nullAgents.js';
import { HELD_OUT_SUFFIX } from '../../evals/utilities/heldOut.js';
import fs from 'fs';
import { closedFieldViolations } from './closedFieldCheck.js';

// The closed-field findings in frozen groups, recorded and not fixed (see closedFieldCheck.js). Each carries its share at the time; a Phase 3 group (*Hard2*) may never be here.
const CLOSED_FIELD_BASELINE = JSON.parse(fs.readFileSync('tests/evals/fixtures/closedFieldBaseline.json', 'utf8'));
const violationId = (category, v) => JSON.stringify([category, v.group, v.options, v.answer]);

// A contract every agent category keeps, over all its cases, hand-written and generated alike.
// The per-case checks that need a category's own knowledge (the reference answer passes, a planted
// model differs from the correct one, the generated file is the rule's output) live in that
// category's own test; this one checks what holds for every category the same way.
const MAX_HELD_OUT_FLOOR = 0.5;
const MAX_FLOOR_GAP = 0.15;
// The gap is compared only where there are enough held-out tests for a share to mean something
// (aggregationCritique has two, a documented shortfall); the half-way cap applies everywhere.
const MIN_FOR_GAP = 4;

const shareOf = async function(category, agent, tests) {
    let passed = 0;
    for (const t of tests) {
        let failures;
        try {
            failures = await category.evaluate(nullResponse(agent, t), t.expectations);
        } catch (error) {
            failures = [{ type: 'Error', details: error.message }];
        }
        if (!failures.length) passed++;
    }
    return tests.length ? passed / tests.length : 0;
};

describe('agent category contract', () => {
    jest.setTimeout(3600000);

    test.each(CATEGORIES)('%s: every test has a unique name, a prompt and expectations', async (name) => {
        const { groups } = await import(`../../evals/categories/${name}.js`);
        const tests = Object.values(groups).flat();
        expect(new Set(tests.map((t) => t.name)).size).toBe(tests.length);
        for (const t of tests) {
            expect([t.name, typeof t.prompt === 'string' && t.prompt.trim().length > 0]).toEqual([t.name, true]);
            expect([t.name, typeof t.expectations]).toEqual([t.name, 'object']);
        }
    });

    simTest.each(CATEGORIES)('%s: no null agent does better on the held-out tests than the dev ones, nor passes half of them', async (name) => {
        const category = await import(`../../evals/categories/${name}.js`);
        const held = Object.entries(category.groups).filter(([g]) => g.endsWith(HELD_OUT_SUFFIX)).flatMap(([, t]) => t);
        const dev = Object.entries(category.groups).filter(([g]) => !g.endsWith(HELD_OUT_SUFFIX)).flatMap(([, t]) => t);
        try {
            // The floors' three null agents, and constant answers from the middle of every closed
            // list (option-1, option-2): the two ends alone missed an always-"aggregate" answer.
            for (const agent of [...NULL_AGENTS, 'option-1', 'option-2']) {
                setReader(agent === 'silent' ? (schema) => schemaReading(schema, 'no') : (schema) => schemaReading(schema, agent));
                const [h, d] = [await shareOf(category, agent.startsWith('option') ? 'yes' : agent, held), await shareOf(category, agent.startsWith('option') ? 'yes' : agent, dev)];
                expect([name, agent, h <= MAX_HELD_OUT_FLOOR]).toEqual([name, agent, true]);
                if (held.length >= MIN_FOR_GAP) expect([name, agent, h <= d + MAX_FLOOR_GAP]).toEqual([name, agent, true]);
            }
        } finally {
            setReader(null);
        }
    });

    test('the closed-field baseline holds no Phase 3 group, and every entry gives its reason', () => {
        for (const b of CLOSED_FIELD_BASELINE) {
            expect([b.category, b.group, /Hard2/.test(b.group)]).toEqual([b.category, b.group, false]);
            expect([b.category, b.group, typeof b.reason === 'string' && b.reason.length > 0]).toEqual([b.category, b.group, true]);
        }
    });

    // A closed-field check: no reading that answers one closed question the same way every time, the
    // rest read right, passes more than half of the held-out tests that read it — except the findings
    // recorded in the baseline, none of which may grow, and every one of which must still occur.
    simTest.each(CATEGORIES)('%s: no constant answer to one closed field passes more than half of a held-out group, beyond the recorded baseline', async (name) => {
        const category = await import(`../../evals/categories/${name}.js`);
        const found = await closedFieldViolations(category);
        const baseline = CLOSED_FIELD_BASELINE.filter((b) => b.category === name);
        const recorded = new Map(baseline.map((b) => [violationId(name, b), b]));
        const now = new Map(found.map((v) => [violationId(name, v), v]));
        // (a) every violation is recorded, (b) none has grown past its recorded share.
        for (const [id, v] of now) {
            const b = recorded.get(id);
            expect([id, Boolean(b)]).toEqual([id, true]);
            expect([id, v.passed / v.reads <= b.passed / b.reads + 1e-9]).toEqual([id, true]);
        }
        // Every recorded finding still occurs, so the baseline is pruned when one is fixed.
        for (const id of recorded.keys()) expect([id, now.has(id)]).toEqual([id, true]);
    });
});
