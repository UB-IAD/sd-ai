/**
 * Writes generated.json (a fixUnits case) and generatedBuild.json (a buildWithUnits case) for every
 * scenario in the library the general rules in generate.js can give one. Run with
 * `SDAI_TEST_MODE=true node evals/categories/unitConsistencyData/buildGenerated.js` after adding a
 * scenario; the unit tests check the file matches the rule. Also writes hard.json: a hard fixUnits
 * case for every scenario the rule in hard.js can give one.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scenarios } from '../../utilities/scenarios/library.js';
import { generateCase, generateBuildCase } from './generate.js';
import { generateHardCase } from './hard.js';

const out = {};
for (const s of Object.values(scenarios)) {
    const c = await generateCase(s);
    if (c) out[c.name] = c;
}
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'generated.json'), JSON.stringify(out, null, 1) + '\n');

const build = {};
for (const s of Object.values(scenarios)) {
    const c = generateBuildCase(s);
    if (c) build[c.name] = c;
}
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'generatedBuild.json'), JSON.stringify(build, null, 1) + '\n');

const hard = {};
for (const s of Object.values(scenarios)) {
    const c = await generateHardCase(s);
    if (c) hard[c.name] = c;
}
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'hard.json'), JSON.stringify(hard, null, 1) + '\n');
