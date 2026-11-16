/**
 * Writes generated.json: mece cases for every scenario in the library, by the general rule in
 * generate.js; and hard.json: mece's hard cases, by the rule in hard.js (see allHardCases). Run with `SDAI_TEST_MODE=true node evals/categories/meceData/buildGenerated.js` after
 * adding a scenario; the unit tests check the file matches the rule.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scenarios } from '../../utilities/scenarios/library.js';
import { generateCases } from './generate.js';

const out = {};
for (const s of Object.values(scenarios)) for (const c of await generateCases(s)) out[c.name] = c;
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'generated.json'), JSON.stringify(out, null, 1) + '\n');

const { allHardCases } = await import('./hard.js');
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'hard.json'), JSON.stringify(await allHardCases(), null, 1) + '\n');
