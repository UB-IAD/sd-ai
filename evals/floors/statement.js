/**
 * The floors sentence each new agent category's methodology states: what its null agents score
 * (see nullAgents.js), read from floors.json.
 * @module floors/statement
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CATEGORY_ROLES, roleStatement } from '../utilities/categoryRoles.js';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'floors.json');
const FLOORS = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
const pct = (x) => `${Math.round(100 * x)}%`;

/** The floors sentence for a category. */
export const floorsStatement = function(name) {
    const f = FLOORS[name];
    if (!f) return 'Floors: not yet computed for this category.';
    return `Floors: an agent that returns nothing scores ${pct(f.silent.share)}; one that hands back the model unchanged and is read as answering every question in the most assertive way scores ${pct(f.yes.share)}, and in the most noncommittal way ${pct(f.no.share)}. These are the scores to read the category's results against.`;
};

/** A methodology with its role (regression guard or discriminating) and floors sentence added. */
export const withFloors = function(name, methodology) {
    const role = roleStatement(name);
    return {
        ...methodology,
        ...(CATEGORY_ROLES[name] ? { role: CATEGORY_ROLES[name] } : {}),
        howItWorks: [...methodology.howItWorks, ...(role ? [role] : []), floorsStatement(name)]
    };
};
