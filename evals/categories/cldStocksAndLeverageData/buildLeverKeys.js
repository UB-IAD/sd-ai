/**
 * Writes leverKeys.json: the second hard leverage group's key for every held-out scenario, by the
 * rule in leverKey.js, with the reason for each scenario not taken. Run with
 * `SDAI_TEST_MODE=true node evals/categories/cldStocksAndLeverageData/buildLeverKeys.js` after
 * adding a scenario; the unit tests check the file matches the rule.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scenarios } from '../../utilities/scenarios/library.js';
import { leverKey } from './leverKey.js';

const out = {};
for (const [id, s] of Object.entries(scenarios)) {
    if (s.split !== 'heldout') continue;
    out[id] = await leverKey(s);
}
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'leverKeys.json'), JSON.stringify(out, null, 1) + '\n');
