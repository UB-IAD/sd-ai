/**
 * Writes jointRanges.json: for every held-out scenario, the second hard group's joint range
 * (jointRange.js), or the reason the rule does not take it. Run with
 * `SDAI_TEST_MODE=true node evals/categories/analysisSetupData/buildJointRanges.js` after adding a
 * held-out scenario; the unit tests check the file matches the rule.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scenarios } from '../../utilities/scenarios/library.js';
import { jointRange } from './jointRange.js';

const out = {};
for (const [id, s] of Object.entries(scenarios)) {
    if (s.split !== 'heldout') continue;
    out[id] = await jointRange(s);
    console.error(id, JSON.stringify(out[id]));
}
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'jointRanges.json'), JSON.stringify(out, null, 1) + '\n');
