/**
 * Writes hardRanges.json: for every scenario of the analysis setup hard group (a key with both
 * influential and negligible parameters), the range of its measure with each influential parameter
 * off by up to half, one at a time (hardRange.js). Run with
 * `SDAI_TEST_MODE=true node evals/categories/analysisSetupData/buildHardRanges.js` after changing a
 * scenario or keys.json; the unit tests check the file matches the rule.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scenarios } from '../../utilities/scenarios/library.js';
import { measureFor } from './deriveKey.js';
import { rangeOver } from './hardRange.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const keys = JSON.parse(fs.readFileSync(path.join(here, 'keys.json'), 'utf8'));
const out = {};
for (const [id, k] of Object.entries(keys)) {
    if (!k.influential.length || !k.negligible.length) continue;
    out[id] = await rangeOver(scenarios[id], k.output, measureFor(scenarios[id]).of, k.influential);
}
fs.writeFileSync(path.join(here, 'hardRanges.json'), JSON.stringify(out, null, 1) + '\n');
