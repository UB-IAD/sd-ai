/**
 * Writes generated.json: a guidedCorrection case for every scenario in the library that the general
 * rule in generate.js can give one; and hard.json: a hard case for every scenario the rule in
 * hard.js can give one. Run with
 * `SDAI_TEST_MODE=true node evals/categories/guidedCorrectionData/buildGenerated.js` after adding a
 * scenario; the unit tests check the file matches the rule.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scenarios } from '../../utilities/scenarios/library.js';
import { generateCase } from './generate.js';
import { generateHardCase } from './hard.js';

const out = {};
for (const s of Object.values(scenarios)) {
    const c = await generateCase(s);
    if (c) out[c.name] = c;
}
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'generated.json'), JSON.stringify(out, null, 1) + '\n');

const hard = {};
for (const s of Object.values(scenarios)) {
    const c = await generateHardCase(s);
    if (c) hard[c.name] = c;
}
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'hard.json'), JSON.stringify(hard, null, 1) + '\n');
