/**
 * Writes generated.json: a transferability case for every scenario that has no hand-written one,
 * by the general rule in generate.js; and hardGenerated.json: the hard group's case (three
 * unrealistic assumptions among three sound ones) for every scenario that can give one. Run with
 * `SDAI_TEST_MODE=true node evals/categories/transferabilityData/buildGenerated.js` after adding a
 * scenario; the unit tests check the file matches the rule.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scenarios } from '../../utilities/scenarios/library.js';
import { handCases } from './cases.js';
import { generateCase, generateHardCase } from './generate.js';

const covered = new Set(Object.values(handCases).map((c) => c.scenario));
const out = {};
for (const [id, s] of Object.entries(scenarios)) {
    if (covered.has(id)) continue;
    const c = await generateCase(s);
    if (c) out[s.title] = c;
}
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'generated.json'), JSON.stringify(out, null, 1) + '\n');
const hard = {};
for (const s of Object.values(scenarios)) {
    const c = await generateHardCase(s);
    if (c) hard[`${s.title}: three and three`] = c;
}
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'hardGenerated.json'), JSON.stringify(hard, null, 1) + '\n');
