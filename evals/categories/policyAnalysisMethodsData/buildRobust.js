/**
 * Writes robustGenerated.json: the second hard group's cases (policyAnalysisMethodsHard2), one for
 * every held-out scenario the rule in generate.js (generateRobustCase) gives one, and the scenarios
 * it gives none under `skipped`. Run with
 * `SDAI_TEST_MODE=true node evals/categories/policyAnalysisMethodsData/buildRobust.js` after adding a
 * held-out scenario; the unit tests check the file matches the rule.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scenarios } from '../../utilities/scenarios/library.js';
import { generateRobustCase } from './generate.js';

const out = { cases: {}, skipped: [] };
for (const [id, s] of Object.entries(scenarios)) {
    if (s.split !== 'heldout') continue;
    const c = await generateRobustCase(s);
    if (c) out.cases[c.name] = c;
    else out.skipped.push(id);
}
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'robustGenerated.json'), JSON.stringify(out, null, 1) + '\n');
