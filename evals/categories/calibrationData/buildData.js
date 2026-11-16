/**
 * Writes data.json: each calibration case's historical data, from its hidden truth. Run with
 * `node evals/categories/calibrationData/buildData.js` after changing a case; the unit tests check
 * the file matches what the truths produce.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { cases, dataFor } from './cases.js';

const out = {};
for (const [name, c] of Object.entries(cases)) out[name] = await dataFor(c);
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'data.json'), JSON.stringify(out, null, 1) + '\n');
