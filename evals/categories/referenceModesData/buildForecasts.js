/**
 * Writes forecasts.json: the hard group's forecast question for every scenario of the library, by
 * the general rule in forecast.js. Run with
 * `SDAI_TEST_MODE=true node evals/categories/referenceModesData/buildForecasts.js` after changing a
 * scenario or the rule; the unit tests check the file matches the rule. It also writes
 * trajectories.json, the second hard group's questions (trajectoryFor).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scenarios } from '../../utilities/scenarios/library.js';
import { forecastFor, trajectoryFor } from './forecast.js';

const out = {};
for (const s of Object.values(scenarios)) out[s.id] = await forecastFor(s);
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'forecasts.json'), JSON.stringify(out, null, 1) + '\n');

// trajectories.json: the second hard group's question for every scenario, from its forecast question.
const trajectories = {};
for (const s of Object.values(scenarios)) trajectories[s.id] = await trajectoryFor(s, out[s.id]);
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'trajectories.json'), JSON.stringify(trajectories, null, 1) + '\n');
