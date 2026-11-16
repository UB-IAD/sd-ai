/**
 * The contract test's closed-field check (tests/evals/contract.test.js), kept apart so its baseline
 * (tests/evals/fixtures/closedFieldBaseline.json) can be rebuilt with the same code. Test code only:
 * no evaluation code imports it.
 */
import { setReader } from '../../evals/utilities/judge.js';
import { nullResponse } from '../../evals/floors/nullAgents.js';
import { HELD_OUT_SUFFIX } from '../../evals/utilities/heldOut.js';

// Closed-field balance. A judge reading is a set of closed leaves (every enum or boolean in a judge
// schema, at its path); leaves with the same options are one closed field (a verdict asked of every
// question, say). For a held-out test, a reading that passes it is found by search: the leaves start
// at their first option and each is moved, one at a time, to whichever option leaves fewer failures
// (the response is the 'yes' null agent's: the model it was given, a token answer). Then, for every
// closed field and every one of its options, the reading that answers that option to the whole
// field, every other field read as the passing reading has it, may not pass more than half of the
// held-out group's tests that read that field (a passable test that some constant answer to it fails,
// or an unpassable test whose reading has it): a constant answer to one closed question — which way a
// model errs once the verdict is right, say — must not be enough. Tests no reading passes (the model
// must change) count as failed by every such reading; tests with no closed leaf are not judge-read
// and are skipped.
const defOf = (s) => s?._zod?.def ?? s?.def;
/** The highest number a numbered list in the judge messages reaches: how many list items to fill. */
const listedItems = (messages) => Math.max(1, ...(messages || []).flatMap((m) => [...String(m.content).matchAll(/^\s*(\d+)[.)]\s/gm)].map((x) => Number(x[1]))));
const readingOf = function(schema, assign, leaves, path, items) {
    const d = defOf(schema);
    switch (d?.type) {
        case 'object': return Object.fromEntries(Object.entries(schema.shape).map(([k, v]) => [k, readingOf(v, assign, leaves, `${path}.${k}`, items)]));
        case 'array': {
            const isObject = defOf(d.element)?.type === 'object';
            return Array.from({ length: isObject ? items : 1 }, (_, i) => {
                const item = readingOf(d.element, assign, leaves, `${path}[${i}]`, items);
                if (isObject && 'number' in item) item.number = i + 1;
                return item;
            });
        }
        case 'enum': {
            const options = Object.values(d.entries);
            leaves.set(path, options);
            return assign.has(path) ? assign.get(path) : options[0];
        }
        case 'boolean': leaves.set(path, [true, false]); return assign.has(path) ? assign.get(path) : true;
        case 'literal': return d.values?.[0];
        case 'number': return 1;
        case 'string': return 'yes';
        case 'nullable': case 'optional': case 'default': return readingOf(d.innerType, assign, leaves, path, items);
        default: return null;
    }
};
const failuresUnder = async function(category, t, assign, leaves) {
    setReader((schema, messages) => readingOf(schema, assign, leaves, '', listedItems(messages)));
    try {
        return (await category.evaluate(nullResponse('yes', t), t.expectations)).length;
    } catch {
        return Infinity;
    }
};
const passingReading = async function(category, t) {
    const leaves = new Map();
    const assign = new Map();
    let best = await failuresUnder(category, t, assign, leaves);
    if (!leaves.size) return null;
    for (let round = 0; round < 2 && best > 0; round++) {
        for (const [path, options] of [...leaves]) {
            for (const o of options) {
                if ((assign.has(path) ? assign.get(path) : options[0]) === o) continue;
                const trial = new Map(assign).set(path, o);
                const f = await failuresUnder(category, t, trial, leaves);
                if (f < best) { best = f; assign.set(path, o); }
            }
            if (best === 0) break;
        }
    }
    if (best !== 0) return { leaves, assign: null };
    const full = new Map([...leaves].map(([p, options]) => [p, assign.has(p) ? assign.get(p) : options[0]]));
    return { leaves, assign: full };
};
/** Every constant reading of one closed field: each option of each option set found. */
const constants = function(found) {
    const sets = new Map();
    for (const f of found) for (const options of f.leaves.values()) sets.set(JSON.stringify(options), options);
    return [...sets].flatMap(([key, options]) => options.map((o) => ({ key, o })));
};

/**
 * Every closed-field violation in a category's held-out groups.
 * @returns {Promise<Array<{group: string, options: Array, answer: *, passed: number, reads: number}>>}
 */
export const closedFieldViolations = async function(category) {
    const violations = [];
    try {
        for (const [group, tests] of Object.entries(category.groups).filter(([g]) => g.endsWith(HELD_OUT_SUFFIX))) {
            const found = [];
            for (const t of tests) {
                const r = await passingReading(category, t);
                if (r) found.push({ t, ...r });
            }
            const passable = found.filter((f) => f.assign);
            const all = constants(found);
            for (const key of new Set(all.map((c) => c.key))) {
                // Which passable tests pass under each constant answer to this field.
                const passes = new Map();
                for (const c of all.filter((x) => x.key === key)) {
                    const ok = new Set();
                    for (const f of passable) {
                        const assign = new Map([...f.assign].map(([p, v]) => [p, JSON.stringify(f.leaves.get(p)) === key ? c.o : v]));
                        if ((await failuresUnder(category, f.t, assign, new Map())) === 0) ok.add(f);
                    }
                    passes.set(c.o, ok);
                }
                // The tests that read this field: a passable one that some constant answer to it fails,
                // and an unpassable one whose reading has it (failed by every constant answer).
                const readers = [
                    ...passable.filter((f) => [...passes.values()].some((ok) => !ok.has(f))),
                    ...found.filter((f) => !f.assign && [...f.leaves.values()].some((o) => JSON.stringify(o) === key))
                ];
                for (const [o, ok] of passes) {
                    const passed = readers.filter((f) => ok.has(f)).length;
                    if (readers.length && passed > readers.length / 2) violations.push({ group, options: JSON.parse(key), answer: o, passed, reads: readers.length });
                }
            }
        }
    } finally {
        setReader(null);
    }
    return violations;
};

