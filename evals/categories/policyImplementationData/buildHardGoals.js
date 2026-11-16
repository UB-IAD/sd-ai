/**
 * Writes hardGoals.json: the policy implementation category's hard goal for every scenario the rule
 * in hardGoals.js qualifies. Run with
 * `SDAI_TEST_MODE=true node evals/categories/policyImplementationData/buildHardGoals.js` after adding
 * a scenario; the unit tests check the file matches the rule.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scenarios } from '../../utilities/scenarios/library.js';
import { hardGoal } from './hardGoals.js';

const out = {};
for (const [id, s] of Object.entries(scenarios)) {
    const g = await hardGoal(s);
    if (g) out[id] = g;
}
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'hardGoals.json'), JSON.stringify(out, null, 1) + '\n');
