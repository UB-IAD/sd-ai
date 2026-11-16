/**
 * Writes hardCases.json: the aggregation critique hard group's cases, by the general rule in hard.js.
 * Run with `SDAI_TEST_MODE=true node evals/categories/aggregationCritiqueData/buildHard.js` after
 * adding a scenario; the unit tests check the file matches the rule.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scenarios } from '../../utilities/scenarios/library.js';
import { handCases } from './cases.js';
import { hardCaseFor } from './hard.js';

// As for the generated cases, a scenario with hand-written cases is asked about those instead.
const covered = new Set(Object.values(handCases).map((c) => c.scenario));
const out = {};
for (const [id, s] of Object.entries(scenarios)) {
    if (covered.has(id)) continue;
    const c = await hardCaseFor(s);
    if (c) out[id] = c;
}
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'hardCases.json'), JSON.stringify(out, null, 1) + '\n');
