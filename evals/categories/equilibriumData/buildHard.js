/**
 * Writes hardGenerated.json: the equilibrium hard group's cases, by the general rule in hard.js. Run
 * with `SDAI_TEST_MODE=true node evals/categories/equilibriumData/buildHard.js` after adding a
 * scenario; the unit tests check the file matches the rule.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scenarios } from '../../utilities/scenarios/library.js';
import { hardCaseFor } from './hard.js';

const out = {};
for (const s of Object.values(scenarios)) {
    const c = await hardCaseFor(s);
    if (c) out[c.name] = c;
}
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'hardGenerated.json'), JSON.stringify(out, null, 1) + '\n');
