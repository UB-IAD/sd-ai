/**
 * Writes hard2.json: the second hard group's case for every held-out scenario the rule in hard2.js
 * can give one, from the frozen generated cases (generated.json) and the first hard group's cases
 * (hard.json). Run with
 * `SDAI_TEST_MODE=true node evals/categories/mentalModelVsBugData/buildHard2.js` after adding a
 * scenario (and after buildGenerated.js); the unit tests check the file matches the rule.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scenarios } from '../../utilities/scenarios/library.js';
import { isHeldOutScenario } from '../../utilities/heldOut.js';
import { generateHard2Case } from './hard2.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const generated = Object.values(JSON.parse(fs.readFileSync(path.join(dir, 'generated.json'), 'utf8')));
const firstHard = Object.values(JSON.parse(fs.readFileSync(path.join(dir, 'hard.json'), 'utf8')));
const out = {};
for (const s of Object.values(scenarios).filter((x) => isHeldOutScenario(x.id))) {
    const c = await generateHard2Case(s, generated.filter((g) => g.scenario === s.id), firstHard);
    if (c) out[c.name] = c;
    console.error(s.id, c ? c.items.map((x) => `${x.kind}:${x.constant}`).join(', ') : 'none');
}
fs.writeFileSync(path.join(dir, 'hard2.json'), JSON.stringify(out, null, 1) + '\n');
