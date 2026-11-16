/**
 * Writes generated.json: calibration cases for every scenario that has no hand-written ones, by the
 * general rule in generate.js. Run with
 * `SDAI_TEST_MODE=true node evals/categories/calibrationData/buildGenerated.js` after adding a
 * scenario, then buildData.js for the data; the unit tests check every generated case has the
 * properties the rule demands.
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
