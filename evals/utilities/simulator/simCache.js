/**
 * A disk cache for simulation results.
 *
 * The case builders, the floors and the unit tests run the same models with the same overrides
 * many times, and each run starts a Python process and imports PySD. A successful run's result is
 * stored under a hash of everything that decides it: the XMILE, the variables asked for, and the
 * source of the simulator (PySDSimulator.js, the Python script it runs and its requirements.txt), so
 * a change to any of them misses the cache. An upgrade inside the Python environment that leaves
 * requirements.txt alone does not: delete evals/.simcache after one (and to reclaim space). Failed
 * runs are never stored, since a failure can come from the machine (a killed process, a timeout)
 * rather than the model.
 *
 * The cache lives in evals/.simcache (git-ignored). Set SDAI_SIM_CACHE=off to bypass it.
 *
 * @module utilities/simulator/simCache
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CACHE_DIR = path.join(here, '../../.simcache');
const SOURCES = [path.join(here, 'PySDSimulator.js'), path.join(here, '../../../third-party/PySD-simulator/simulator.py'), path.join(here, '../../../third-party/PySD-simulator/requirements.txt')];

let sourceHash = null;
const sources = () => {
    if (sourceHash === null) {
        const h = crypto.createHash('sha256');
        for (const f of SOURCES) h.update(fs.existsSync(f) ? fs.readFileSync(f) : `missing:${f}`);
        sourceHash = h.digest('hex');
    }
    return sourceHash;
};

export const cacheEnabled = () => process.env.SDAI_SIM_CACHE !== 'off';

/** The cache key for a run. */
export const keyFor = (xmile, variables) => crypto.createHash('sha256').update(sources()).update('\0').update(xmile).update('\0').update(JSON.stringify(variables)).digest('hex');

const fileFor = (key) => path.join(CACHE_DIR, key.slice(0, 2), `${key}.json`);

/** A stored result, or null. */
export const readCached = function(key) {
    try {
        return JSON.parse(fs.readFileSync(fileFor(key), 'utf8'));
    } catch {
        return null;
    }
};

/** Store a result; a failure to write is ignored (the cache is only an optimization). */
export const writeCached = function(key, value) {
    try {
        const file = fileFor(key);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(value));
        fs.renameSync(tmp, file);
    } catch {
        // ignore
    }
};
