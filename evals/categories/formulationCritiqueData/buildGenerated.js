/**
 * Writes generated.json: a formulationCritique case for every scenario in the library the general
 * rule in generate.js can give one, other than a scenario a hand-written case already uses. Run
 * with `SDAI_TEST_MODE=true node evals/categories/formulationCritiqueData/buildGenerated.js` after
 * adding a scenario; the unit tests check the file matches the rule. Also writes hard.json: a hard
 * case for every scenario the rule in hard.js can give one.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scenarios } from '../../utilities/scenarios/library.js';
import { handCases } from './cases.js';
import { generateCase } from './generate.js';
import { generateHardCase } from './hard.js';

const out = {};
for (const s of Object.values(scenarios)) {
    const c = generateCase(s);
    if (c && !handCases[c.name]) out[c.name] = c;
}
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'generated.json'), JSON.stringify(out, null, 1) + '\n');

const hard = {};
for (const s of Object.values(scenarios)) {
    const c = await generateHardCase(s);
    if (c) hard[c.name] = c;
}
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'hard.json'), JSON.stringify(hard, null, 1) + '\n');
