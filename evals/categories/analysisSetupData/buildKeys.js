/**
 * Writes keys.json: every scenario's analysis setup key, by the general rule in deriveKey.js. Run
 * with `SDAI_TEST_MODE=true node evals/categories/analysisSetupData/buildKeys.js` after adding or
 * changing a scenario; the unit tests check the file matches the rule.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scenarios } from '../../utilities/scenarios/library.js';
import { deriveKey } from './deriveKey.js';

const out = {};
for (const [id, s] of Object.entries(scenarios)) {
    const key = await deriveKey(s);
    if (key.influential.length) out[id] = key;
}
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'keys.json'), JSON.stringify(out, null, 1) + '\n');
