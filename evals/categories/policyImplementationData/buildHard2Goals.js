/**
 * Writes hard2Goals.json: the second hard group's goal for every held-out scenario the rule in
 * hardGoals.js (hard2Goal) qualifies, from the first hard goals in hardGoals.json. Run with
 * `SDAI_TEST_MODE=true node evals/categories/policyImplementationData/buildHard2Goals.js` after
 * buildHardGoals.js; the unit tests check the file matches the rule.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scenarios } from '../../utilities/scenarios/library.js';
import { isHeldOutScenario } from '../../utilities/heldOut.js';
import { hard2Goal } from './hardGoals.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const first = JSON.parse(fs.readFileSync(path.join(dir, 'hardGoals.json'), 'utf8'));
const out = {};
for (const [id, s] of Object.entries(scenarios).filter(([x]) => isHeldOutScenario(x))) {
    const g = await hard2Goal(s, first[id]);
    if (g) out[id] = g;
    console.error(id, JSON.stringify(g));
}
fs.writeFileSync(path.join(dir, 'hard2Goals.json'), JSON.stringify(out, null, 1) + '\n');
