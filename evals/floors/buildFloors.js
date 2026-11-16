/**
 * Writes floors.json: every new agent category's score for each null agent. Run with
 * `SDAI_TEST_MODE=true node evals/floors/buildFloors.js` after changing a category or its cases;
 * the unit tests check the file. No AI is used: the judge is replaced by the null agents' reading.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { setReader } from '../utilities/judge.js';
import { CATEGORIES, NULL_AGENTS, schemaReading } from './nullAgents.js';
import { floorOf } from './computeFloors.js';

const only = process.argv.slice(2);
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'floors.json');
const out = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
for (const name of CATEGORIES.filter((c) => !only.length || only.includes(c))) {
    const category = await import(`../categories/${name}.js`);
    out[name] = {};
    try {
        for (const agent of NULL_AGENTS) {
            setReader(agent === 'silent' ? (schema) => schemaReading(schema, 'no') : (schema) => schemaReading(schema, agent));
            out[name][agent] = await floorOf(category, agent);
        }
    } finally {
        setReader(null);
    }
    fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
    console.error(name, JSON.stringify(out[name]));
}
