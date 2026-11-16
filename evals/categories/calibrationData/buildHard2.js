/**
 * Writes hard2.json: the calibration second hard group's structure cases (removedMechanism.js), one
 * for every held-out scenario the rule gives one, with its data, and the reason for every held-out
 * scenario it gives none. Run with
 * `SDAI_TEST_MODE=true node evals/categories/calibrationData/buildHard2.js` after adding a held-out
 * scenario; the unit tests check the file matches the rule.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scenarios } from '../../utilities/scenarios/library.js';
import { removedMechanismCase } from './removedMechanism.js';

const out = { cases: {}, skipped: {} };
for (const [id, s] of Object.entries(scenarios)) {
    if (s.split !== 'heldout') continue;
    const c = await removedMechanismCase(s);
    if (c.skip) out.skipped[id] = c.skip;
    else out.cases[c.name] = c;
    console.error(id, c.skip ?? c.name);
}
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'hard2.json'), JSON.stringify(out, null, 1) + '\n');
