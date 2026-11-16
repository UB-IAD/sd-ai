/**
 * Writes generated.json: policyAnalysisMethods cases for every scenario in the library that the
 * hand-written cases do not use, by the general rule in generate.js; and hardGenerated.json: the
 * hard group's cases for every scenario that gives them (generate.js, generateHardCase and
 * generateUnreachableCase). Run with
 * `SDAI_TEST_MODE=true node evals/categories/policyAnalysisMethodsData/buildGenerated.js` after
 * adding a scenario (and after the calibration category's generated cases); the unit tests check
 * both files match the rules.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scenarios } from '../../utilities/scenarios/library.js';
import { cases as calibrationCases } from '../calibrationData/cases.js';
import { generateCases, generateHardCase, generateUnreachableCase } from './generate.js';

export const HAND_SCENARIOS = ['dialysisClinic', 'bikeShare', 'distributor'];

const here = path.dirname(fileURLToPath(import.meta.url));
const out = {};
for (const [id, s] of Object.entries(scenarios)) {
    if (HAND_SCENARIOS.includes(id)) continue;
    for (const c of await generateCases(s, calibrationCases)) out[c.name] = c;
}
fs.writeFileSync(path.join(here, 'generated.json'), JSON.stringify(out, null, 1) + '\n');

const hard = {};
for (const s of Object.values(scenarios)) {
    const c = await generateHardCase(s);
    if (c) hard[c.name] = c;
    const u = await generateUnreachableCase(s, c?.lever ?? null);
    if (u) hard[u.name] = u;
}
fs.writeFileSync(path.join(here, 'hardGenerated.json'), JSON.stringify(hard, null, 1) + '\n');
