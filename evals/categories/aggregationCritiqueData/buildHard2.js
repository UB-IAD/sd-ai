/**
 * Writes hard2Cases.json: the aggregation critique second hard group's cases, by the general rule in
 * hard2.js, for every held-out scenario. Run with
 * `SDAI_TEST_MODE=true node evals/categories/aggregationCritiqueData/buildHard2.js` after adding a
 * scenario; the unit tests check the file matches the rule.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hard2CaseFor } from '../aggregationCritique.js';
import { scenarios } from '../../utilities/scenarios/library.js';
import { isHeldOutScenario } from '../../utilities/heldOut.js';

const out = {};
for (const id of Object.keys(scenarios).filter(isHeldOutScenario)) {
    const c = await hard2CaseFor(id);
    if (c) out[id] = c;
    console.error(id, c ? c.questions.map((q) => `${q.verdict}${q.direction ? `/${q.direction}` : ''}`).join(', ') : 'none');
}
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'hard2Cases.json'), JSON.stringify(out, null, 1) + '\n');
