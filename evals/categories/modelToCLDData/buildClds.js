/**
 * Builds the causal loop diagrams the modelToCLD category uploads as XMILE files.
 *
 * Two kinds:
 *   - gibberish CLDs, generated from a seed so no world knowledge can stand in for reading the
 *     file. Each is a "flower": a hub variable with loops (petals) through it, each loop made of a
 *     few core variables joined by chains of pass-through variables, plus inputs and outputs that
 *     sit on no loop. A second hub hangs off the first by a one-way chain with its own petals. The
 *     shape guarantees the diagram's loops are exactly the designed petals — no combination of
 *     petals forms a further loop — so the answer key is the design itself.
 *   - real-domain CLDs, written out by hand, built the same way: core variables joined by chains.
 *
 * A good summary keeps every loop, keeps each loop's core variables, and collapses the chains.
 *
 * Run `node evals/categories/modelToCLDData/buildClds.js` to regenerate the committed .json and
 * .stmx files. The output is deterministic.
 */

import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import utils from '../../../utilities/utils.js';
import { cldToXmile } from '../../utilities/cldXmile.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** mulberry32: a small seeded PRNG, so the diagrams are the same on every machine. */
const prng = function(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

const ADJECTIVES = ['rate of', 'pressure on', 'level of', 'supply of', 'demand for', 'quality of', 'stock of', 'flow of'];

/**
 * Generate one gibberish flower CLD.
 * @param {number} seed PRNG seed
 * @param {Array<number>} petalsPerHub Loops through each hub, e.g. [2, 1]
 * @returns {{relationships: Array<Object>, loops: Array<{core: Array<string>, nodes: Array<string>, polarity: string}>}}
 */
export const generateFlower = function(seed, petalsPerHub) {
    const random = prng(seed);
    const pool = [...utils.evalsGibberishNouns];
    const used = new Set();
    const name = () => {
        // A flower too big for the noun pool cannot be drawn: fail rather than search forever.
        for (let tries = 0; ; tries++) {
            if (tries > 100000) throw new Error(`Seed ${seed}: the noun pool ran out of names for petals ${JSON.stringify(petalsPerHub)}.`);
            const noun = pool[Math.floor(random() * pool.length)];
            const adjective = ADJECTIVES[Math.floor(random() * ADJECTIVES.length)];
            const candidate = random() < 0.5 ? noun : `${adjective} ${noun}`;
            if (!used.has(candidate) && ![...used].some((u) => u.endsWith(noun) || candidate.endsWith(u.split(' ').pop()))) {
                used.add(candidate);
                return candidate;
            }
        }
    };
    const sign = () => (random() < 0.6 ? '+' : '-');
    const relationships = [];
    const loops = [];
    const link = (from, to) => {
        const polarity = sign();
        relationships.push({ from, to, polarity });
        return polarity;
    };

    const hubs = petalsPerHub.map(() => name());
    petalsPerHub.forEach((petals, h) => {
        for (let p = 0; p < petals; p++) {
            const coreCount = 1 + Math.floor(random() * 2); // cores besides the hub
            const core = [hubs[h], ...Array.from({ length: coreCount }, () => name())];
            const nodes = [];
            const signs = [];
            core.forEach((from, i) => {
                const to = core[(i + 1) % core.length];
                const chain = Array.from({ length: 1 + Math.floor(random() * 2) }, () => name());
                let previous = from;
                nodes.push(from);
                for (const middle of [...chain, to]) {
                    signs.push(link(previous, middle));
                    if (middle !== to) nodes.push(middle);
                    previous = middle;
                }
            });
            const polarity = signs.filter((s) => s === '-').length % 2 === 0 ? '+' : '-';
            loops.push({ core, nodes, polarity });
        }
    });
    // One-way chains between hubs: hub0 -> ... -> hub1 never returns, so it closes no loop.
    for (let h = 1; h < hubs.length; h++) {
        let previous = hubs[h - 1];
        for (const middle of [name(), hubs[h]]) { link(previous, middle); previous = middle; }
    }
    // Inputs feeding the diagram and outputs it drives, on no loop.
    const loopNodes = loops.flatMap((l) => l.nodes);
    for (let i = 0; i < 2; i++) link(name(), loopNodes[Math.floor(random() * loopNodes.length)]);
    for (let i = 0; i < 2; i++) link(loopNodes[Math.floor(random() * loopNodes.length)], name());
    return { relationships, loops };
};

/**
 * Hand-written real-domain CLDs. Each loop is given as its full cycle with core variables marked
 * by a leading '*'; consecutive entries are linked with the polarity written between them.
 */
const REAL_DOMAIN = {
    softwareRework: {
        title: 'Software project rework',
        // Core variables are marked on every loop they sit on, and every loop has at least two, so
        // each loop survives being collapsed onto its core variables.
        loops: [
            ['*Schedule Pressure', '+', 'Overtime Hours', '+', 'Staff Fatigue', '+', 'Error Rate', '+', '*Undiscovered Rework', '+', 'Rework Discovered', '+', '*Work Remaining', '+', '*Schedule Pressure'],
            ['*Schedule Pressure', '+', 'Overtime Hours', '+', 'Work Completion Rate', '-', '*Work Remaining', '+', '*Schedule Pressure'],
            ['*Schedule Pressure', '+', 'Hiring Requests', '+', '*New Staff', '-', 'Average Experience', '-', 'Error Rate', '+', '*Undiscovered Rework', '+', 'Rework Discovered', '+', '*Work Remaining', '+', '*Schedule Pressure']
        ],
        extra: [['Scope Changes', '+', 'Work Remaining'], ['Work Completion Rate', '+', 'Features Delivered'], ['Staff Fatigue', '+', 'Staff Turnover']]
    },
    trafficCongestion: {
        title: 'Urban traffic congestion',
        // Between any two core variables there is one path, or several with the same polarity,
        // so a one-link summary of each pair can be right.
        loops: [
            ['*Congestion', '+', 'Travel Time', '+', 'Political Pressure for Roads', '+', 'Road Construction', '+', '*Road Capacity', '-', '*Congestion'],
            ['*Congestion', '+', 'Travel Time', '-', 'Attractiveness of Driving', '+', '*Traffic Volume', '+', '*Congestion'],
            ['*Road Capacity', '+', 'Attractiveness of Suburbs', '+', 'Suburban Housing', '+', '*Traffic Volume', '+', '*Congestion', '+', 'Travel Time', '+', 'Political Pressure for Roads', '+', 'Road Construction', '+', '*Road Capacity']
        ],
        extra: [['Fuel Price', '-', 'Attractiveness of Driving'], ['Congestion', '+', 'Vehicle Emissions'], ['Transit Investment', '-', 'Attractiveness of Driving']]
    }
};

const strip = (name) => name.replace(/^\*/, '');

const buildRealDomain = function(spec) {
    const relationships = [];
    const seen = new Set();
    const link = (from, polarity, to) => {
        const key = `${from}->${to}`;
        if (seen.has(key)) return;
        seen.add(key);
        relationships.push({ from, to, polarity });
    };
    const loops = spec.loops.map((cycle) => {
        const nodes = [];
        const core = [];
        const signs = [];
        for (let i = 0; i + 2 < cycle.length; i += 2) {
            link(strip(cycle[i]), cycle[i + 1], strip(cycle[i + 2]));
            signs.push(cycle[i + 1]);
            nodes.push(strip(cycle[i]));
            if (cycle[i].startsWith('*')) core.push(strip(cycle[i]));
        }
        const polarity = signs.filter((s) => s === '-').length % 2 === 0 ? '+' : '-';
        return { core, nodes, polarity };
    });
    for (const [from, polarity, to] of spec.extra) link(from, polarity, to);
    return { relationships, loops };
};

export const GIBBERISH = {
    gibberishSmall: { seed: 101, petals: [2] },
    gibberishMedium: { seed: 202, petals: [2, 1] },
    gibberishLarge: { seed: 303, petals: [2, 2] },
    // Held out: written after the modelToCLD and cldInterpretation graders were frozen, never used
    // to tune them.
    heldoutGibberishA: { seed: 4111, petals: [3] },
    heldoutGibberishB: { seed: 4222, petals: [1, 2] },
    heldoutGibberishC: { seed: 4333, petals: [2, 1, 1] },
    heldoutGibberishD: { seed: 4444, petals: [3, 1] },
    heldoutGibberishE: { seed: 4555, petals: [1, 1, 2] },
    heldoutGibberishF: { seed: 5000, petals: [2] },
    heldoutGibberishG: { seed: 5111, petals: [3] },
    heldoutGibberishH: { seed: 5222, petals: [1, 2] },
    heldoutGibberishI: { seed: 5333, petals: [2, 1] },
    heldoutGibberishJ: { seed: 5444, petals: [2, 2] },
    heldoutGibberishK: { seed: 5555, petals: [3, 1] },
    heldoutGibberishL: { seed: 5666, petals: [1, 3] },
    heldoutGibberishM: { seed: 5777, petals: [2, 1, 1] },
    heldoutGibberishN: { seed: 5888, petals: [1, 2, 1] },
    heldoutGibberishO: { seed: 5999, petals: [1, 1, 1] },
    heldoutGibberishP: { seed: 6110, petals: [3, 2] },
    heldoutGibberishQ: { seed: 6221, petals: [2, 2, 1] }
};

/** The gibberish diagrams written after the graders were frozen. */
export const HELD_OUT_CLDS = Object.keys(GIBBERISH).filter((k) => k.startsWith('heldout'));

/** Every gibberish diagram, held out or not. */
export const GIBBERISH_CLDS = Object.keys(GIBBERISH);

/**
 * The bigger flowers of the modelToCLD and cldInterpretation hard groups: six petals each (the most
 * the noun pool can name), on two or three hubs, with loops of both polarities. Kept apart from
 * GIBBERISH so the existing groups are unchanged. Held out by the same convention: a key starting
 * with "heldout" (written after the graders were frozen, never used to tune them).
 */
export const HARD_GIBBERISH = {
    hardGibberishA: { seed: 7001, petals: [3, 3] },
    hardGibberishB: { seed: 7003, petals: [2, 2, 2] },
    heldoutHardGibberishA: { seed: 7101, petals: [4, 2] },
    heldoutHardGibberishB: { seed: 7202, petals: [3, 2, 1] },
    heldoutHardGibberishC: { seed: 7303, petals: [2, 2, 2] }
};

/** The hard flowers. */
export const HARD_CLDS = Object.keys(HARD_GIBBERISH);

/** The hard flowers held out. */
export const HELD_OUT_HARD_CLDS = HARD_CLDS.filter((k) => k.startsWith('heldout'));

export const buildAll = function() {
    const out = {};
    for (const [key, spec] of Object.entries({ ...GIBBERISH, ...HARD_GIBBERISH })) out[key] = { title: key, ...generateFlower(spec.seed, spec.petals) };
    for (const [key, spec] of Object.entries(REAL_DOMAIN)) out[key] = { title: spec.title, ...buildRealDomain(spec) };
    return out;
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    for (const [key, cld] of Object.entries(buildAll())) {
        const names = [...new Set(cld.relationships.flatMap((r) => [r.from, r.to]))];
        const model = { variables: names.map((n) => ({ name: n, type: 'variable' })), relationships: cld.relationships };
        writeFileSync(join(__dirname, `${key}.json`), JSON.stringify({ title: cld.title, model, loops: cld.loops }, null, 2) + '\n');
        writeFileSync(join(__dirname, `${key}.stmx`), cldToXmile(model, cld.title));
        console.log(`${key}: ${names.length} variables, ${cld.relationships.length} links, ${cld.loops.length} loops`);
    }
}
