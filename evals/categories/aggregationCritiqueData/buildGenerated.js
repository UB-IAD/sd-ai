/**
 * Writes generated.json: aggregation cases for every scenario that has no hand-written ones, by the
 * general rule in generate.js. Run with
 * `SDAI_TEST_MODE=true node evals/categories/aggregationCritiqueData/buildGenerated.js` after adding a
 * scenario; the unit tests check the file matches the rule.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scenarios } from '../../utilities/scenarios/library.js';
import { handCases } from './cases.js';
import { generateCases } from './generate.js';

const covered = new Set(Object.values(handCases).map((c) => c.scenario));
const out = {};
for (const [id, s] of Object.entries(scenarios)) {
    if (covered.has(id)) continue;
    for (const c of await generateCases(s)) out[c.name] = c;
}
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'generated.json'), JSON.stringify(out, null, 1) + '\n');
