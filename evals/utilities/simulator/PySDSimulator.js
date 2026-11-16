/**
 * PySDSimulator - A JavaScript wrapper for the PySD simulator
 *
 * This class provides a convenient interface for loading XMILE models,
 * running simulations, and extracting time series data for specified variables.
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { flattenXmileModules } from './flattenXmileModules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Ceiling on what we buffer from a single Python run. Real simulation output is a few MB at
// most; anything beyond this is a runaway model, and letting it accumulate crashes the caller
// long before the data could be useful.
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 4 * 1024 * 1024;

// Error messages embed the process output, so cap what goes into them.
const MAX_ERROR_OUTPUT_CHARS = 8 * 1024;

function truncateForError(output) {
    if (output.length <= MAX_ERROR_OUTPUT_CHARS) {
        return output;
    }
    return `${output.slice(0, MAX_ERROR_OUTPUT_CHARS)}... [truncated, ${output.length} chars total]`;
}

/**
 * Spell out the XMILE builtin constants that PySD's XMILE reader does not implement.
 *
 * XMILE defines PI as a builtin constant written bare, and Stella accepts it, but PySD's XMILE
 * grammar reads a bare PI as a reference to a variable named pi and refuses to load the model
 * (KeyError 'pi'). That failed physically correct pendulum answers in the v2 evals, so the
 * constant is substituted into the equations before PySD sees them. A model that defines its own
 * pi variable is left untouched, since there PI means that variable. PI() with parentheses is
 * already understood by PySD and is left alone too.
 * @param {string} xmileContent The XMILE model
 * @returns {string} The XMILE model with bare PI replaced by its value
 */
function resolveBuiltinConstants(xmileContent) {
    if (/<(?:aux|stock|flow)\s[^>]*name\s*=\s*"pi"/i.test(xmileContent)) {
        return xmileContent;
    }
    return xmileContent.replace(/<eqn>[\s\S]*?<\/eqn>/g, (equation) => {
        return equation.replace(/\bPI\b(?!\s*\()/gi, String(Math.PI));
    });
}

// The most points a resampled lookup may have. A lookup whose breakpoints all fall on an even grid
// of at most this many points is resampled exactly; one that needs more is resampled at this many,
// which approximates it closely but not exactly.
export const MAX_LOOKUP_POINTS = 1001;

// Decimal places considered when looking for an even grid through every breakpoint.
const LOOKUP_DECIMALS = 6;

const parsePoints = (text) => text.split(/[\s,]+/).filter((s) => s !== '').map(Number);
const formatNumber = (value) => String(Number(value.toPrecision(15)));
const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));

/**
 * The step of the coarsest even grid that passes through every breakpoint, or null when there is
 * none with at most MAX_LOOKUP_POINTS points.
 * @param {number[]} xs The breakpoints, ascending
 * @returns {number|null} The step
 */
function exactGridStep(xs) {
    const scale = 10 ** LOOKUP_DECIMALS;
    const offsets = xs.map((x) => Math.round((x - xs[0]) * scale));
    if (offsets.some((o, i) => Math.abs(o / scale - (xs[i] - xs[0])) > 1e-9 * Math.max(1, Math.abs(xs[i])))) return null;
    const divisor = offsets.slice(1).reduce((g, o) => gcd(g, o), 0);
    if (divisor === 0) return null;
    const points = offsets[offsets.length - 1] / divisor + 1;
    return points <= MAX_LOOKUP_POINTS ? divisor / scale : null;
}

/**
 * Linear interpolation of a lookup between its breakpoints.
 * @param {number[]} xs The breakpoints, ascending
 * @param {number[]} ys The values at them
 * @param {number} x Where to read it, between the first and last breakpoint
 * @returns {number} The value
 */
function interpolate(xs, ys, x) {
    let i = 1;
    while (i < xs.length - 1 && xs[i] < x) i++;
    const span = xs[i] - xs[i - 1];
    if (span === 0) return ys[i];
    return ys[i - 1] + ((ys[i] - ys[i - 1]) * (x - xs[i - 1])) / span;
}

/**
 * Rewrite lookups whose x points are unevenly spaced onto an even grid.
 *
 * PySD's XMILE reader ignores a graphical function's <xpts> and spaces its <ypts> evenly across
 * the <xscale> range. A lookup with breakpoints at 0, 1 and 10 is therefore read as if they were
 * at 0, 5 and 10, and the model simulates wrongly with no error. Stella and the XMILE spec honour
 * <xpts>, and SDJsonToXMILE writes them, so the lookup is resampled here, before PySD sees it:
 * on the coarsest even grid that passes through every breakpoint, which reproduces the
 * piecewise-linear curve exactly. If no such grid has at most MAX_LOOKUP_POINTS points,
 * MAX_LOOKUP_POINTS evenly spaced samples are used, which is close but not exact. A discrete
 * lookup (a step function) is left as it is, and so is one whose <xpts> are already evenly spaced.
 * Outside its range a lookup is held at its end values, as before: PySD also ignores
 * type="extrapolate" (SDJsonToXMILE never writes it), and that is not addressed here.
 * @param {string} xmileContent The XMILE model
 * @returns {string} The XMILE model with every uneven continuous lookup resampled evenly
 */
export function evenLookups(xmileContent) {
    return xmileContent.replace(/<gf\b([^>]*)>([\s\S]*?)<\/gf>/g, (whole, attributes, body) => {
        if (/\btype\s*=\s*"discrete"/i.test(attributes)) return whole;
        const xMatch = body.match(/<xpts\b[^>]*>([\s\S]*?)<\/xpts>/);
        const yMatch = body.match(/<ypts\b[^>]*>([\s\S]*?)<\/ypts>/);
        if (!xMatch || !yMatch) return whole;
        const xs = parsePoints(xMatch[1]);
        const ys = parsePoints(yMatch[1]);
        if (xs.length < 2 || xs.length !== ys.length || ![...xs, ...ys].every(Number.isFinite)) return whole;
        if (xs.some((x, i) => i > 0 && x < xs[i - 1])) return whole;
        const first = xs[0];
        const last = xs[xs.length - 1];
        if (last <= first) return whole;
        const even = (last - first) / (xs.length - 1);
        if (xs.every((x, i) => Math.abs(x - (first + i * even)) <= 1e-9 * Math.max(1, Math.abs(last - first)))) return whole;

        const step = exactGridStep(xs);
        const count = step === null ? MAX_LOOKUP_POINTS : Math.round((last - first) / step) + 1;
        const grid = Array.from({ length: count }, (_, i) => (i === count - 1 ? last : first + (i * (last - first)) / (count - 1)));
        const resampled = grid.map((x) => interpolate(xs, ys, x));
        const rewritten = body
            .replace(/<xscale\b[^>]*\/>|<xscale\b[^>]*>[\s\S]*?<\/xscale>/, `<xscale min="${formatNumber(first)}" max="${formatNumber(last)}"/>`)
            .replace(/\s*<xpts\b[^>]*>[\s\S]*?<\/xpts>/, '')
            .replace(/<ypts\b([^>]*)>[\s\S]*?<\/ypts>/, (_, yAttributes) => `<ypts${yAttributes}>${resampled.map(formatNumber).join(',')}</ypts>`);
        const withScale = /<xscale\b/.test(rewritten) ? rewritten : `<xscale min="${formatNumber(first)}" max="${formatNumber(last)}"/>${rewritten}`;
        return `<gf${attributes}>${withScale}</gf>`;
    });
}

// PySD only integrates with Euler: its XMILE reader never reads sim_specs' method, so a model
// written for RK4 is silently run with Euler at the RK4 step, and an oscillator's amplitude grows
// without bound (a 30 degree pendulum swung to 74 degrees). Euler's error shrinks only in proportion
// to the step, so such models run at a step up to this many times finer...
const MAX_RK_REFINEMENT = 100;
// ...but never beyond this many steps in total. Past roughly 600k steps PySD stops partway and
// still reports success, and the output of every step comes back over the pipe.
const MAX_REFINED_STEPS = 200000;

/**
 * Decode the XML escapes that can appear in a name attribute, and XMILE's \n and \r escapes,
 * into the name PySD reports for the element.
 * @param {string} attribute The raw name attribute
 * @returns {string} The element name as PySD knows it
 */
function decodeNameAttribute(attribute) {
    return attribute
        .replace(/\\[nr]/g, ' ')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

/**
 * The XMILE identity of a name: case-insensitive, with spaces, underscores and line breaks all
 * the same separator. PySD matches element names exactly, so "angular velocity",
 * "Angular_Velocity" and "angular_velocity" are three different requests to it and one variable
 * to XMILE.
 * @param {string} name A variable name in any of its spellings
 * @returns {string} The canonical form of the name
 */
function canonicalName(name) {
    return String(name).replace(/\\[nr]/g, ' ').replace(/[\s_]+/g, '_').replace(/^_|_$/g, '').toLowerCase();
}

/**
 * Map every model element's canonical name to the name PySD knows it by.
 * @param {string} xmileContent The XMILE model
 * @returns {Map<string, string>} Canonical name to PySD element name
 */
function elementNames(xmileContent) {
    const names = new Map();
    for (const match of xmileContent.matchAll(/<(?:stock|flow|aux)\s[^>]*?name\s*=\s*"([^"]*)"/g)) {
        const name = decodeNameAttribute(match[1]);
        names.set(canonicalName(name), name);
    }
    return names;
}

/**
 * Read the numeric run specs from sim_specs. Anything that is not a plain number (an expression,
 * a missing element) yields undefined for that field, which turns off what depends on it.
 * @param {string} xmileContent The XMILE model
 * @returns {{method: string, start: number, stop: number, dt: number}} The run specs
 */
function readSimSpecs(xmileContent) {
    const specs = xmileContent.match(/<sim_specs\b([^>]*)>([\s\S]*?)<\/sim_specs>/);
    if (!specs) {
        return { method: '', start: undefined, stop: undefined, dt: undefined };
    }
    const number = (tag) => {
        const element = specs[2].match(new RegExp(`<${tag}\\b([^>]*)>([^<]*)</${tag}>`));
        if (!element) return undefined;
        const value = Number(element[2].trim());
        if (element[2].trim() === '' || !Number.isFinite(value)) return undefined;
        return /reciprocal\s*=\s*"true"/i.test(element[1]) ? 1 / value : value;
    };
    const method = (specs[1].match(/\bmethod\s*=\s*"([^"]*)"/i) || [])[1] || '';
    return { method, start: number('start'), stop: number('stop'), dt: number('dt') };
}

/**
 * How many times finer than its own step to run a model, so that PySD's Euler stands in for the
 * Runge-Kutta method the model asked for. Euler models run as written.
 * @param {{method: string, start: number, stop: number, dt: number}} specs The run specs
 * @returns {number} The refinement factor, 1 for no refinement
 */
function rkRefinement(specs) {
    if (!/^rk/i.test(specs.method.trim())) return 1;
    if (![specs.start, specs.stop, specs.dt].every(Number.isFinite) || specs.dt <= 0 || specs.stop <= specs.start) return 1;
    const steps = (specs.stop - specs.start) / specs.dt;
    return Math.max(1, Math.min(MAX_RK_REFINEMENT, Math.floor(MAX_REFINED_STEPS / steps)));
}

/**
 * Replace the model's step with a finer one. The reciprocal attribute is dropped because the
 * new step is written as the step itself.
 * @param {string} xmileContent The XMILE model
 * @param {number} dt The step to run at
 * @returns {string} The XMILE model with its step replaced
 */
function withTimeStep(xmileContent, dt) {
    return xmileContent.replace(/(<sim_specs\b[^>]*>[\s\S]*?)<dt\b[^>]*>[^<]*<\/dt>/, (whole, before) => {
        return `${before}<dt>${dt}</dt>`;
    });
}

class PySDSimulator {
    /**
     * Create a new PySD simulator instance
     * @param {string} xmileContent - XMILE model content as a string
     * @param {string} [pythonCommand='python3'] - Python command to use (python3, python, etc.)
     */
    constructor(xmileContent, pythonCommand = 'python3') {
        if (!xmileContent || typeof xmileContent !== 'string') {
            throw new Error('xmileContent must be a non-empty string');
        }

        const flat = flattenXmileModules(xmileContent);
        const resolved = evenLookups(resolveBuiltinConstants(flat.xmile));
        this.specs = readSimSpecs(resolved);
        this.refinement = rkRefinement(this.specs);
        this.xmileContent = this.refinement > 1 ? withTimeStep(resolved, this.specs.dt / this.refinement) : resolved;
        this.elementNames = elementNames(resolved);
        // A module variable can still be asked for by its qualified name (chickens.count).
        for (const [qualified, flatName] of flat.aliases) {
            this.elementNames.set(qualified, flatName);
        }
        this.pythonCommand = pythonCommand;

        // Path to the Python simulator script
        this.simulatorScript = path.join(__dirname, '../../../third-party/PySD-simulator/simulator.py');

        // Verify the simulator script exists
        if (!fs.existsSync(this.simulatorScript)) {
            throw new Error(`PySD simulator script not found: ${this.simulatorScript}`);
        }
    }

    /**
     * Get list of available variables in the model
     * @returns {Promise<string[]>} Array of variable names
     */
    async getAvailableVariables() {
        const input = {
            model_content: this.xmileContent,
            action: 'get_variables'
        };

        const result = await this._executePython(input);
        return result.variables;
    }

    /**
     * Simulate the model and return time series data for specified variables.
     * Uses the simulation specs (initial time, final time, time step) defined in the model.
     * @param {string[]} variables - Array of variable names to track
     * @returns {Promise<Object>} Object with 'time' array and arrays for each variable
     */
    async simulate(variables) {
        if (!variables || !Array.isArray(variables) || variables.length === 0) {
            throw new Error('variables must be a non-empty array');
        }

        // Ask PySD for each variable by the model's own spelling of its name, and hand the
        // series back under the spelling the caller used.
        const requested = variables.map((name) => {
            return this.elementNames.get(canonicalName(name)) ?? name;
        });

        const input = {
            model_content: this.xmileContent,
            variables: requested
        };

        const result = await this._executePython(input);
        const raw = result.results;

        // A refined run returns every fine step; keep only the model's own time grid.
        const keep = (series) => {
            return this.refinement > 1 ? series.filter((_, i) => { return i % this.refinement === 0 }) : series;
        };

        const results = { time: keep(raw.time) };
        variables.forEach((name, i) => {
            results[name] = keep(raw[requested[i]]);
        });

        this._assertRunReachedStop(results.time);
        return results;
    }

    /**
     * Reject a run that ended before its stop time. PySD can stop partway through a long run
     * and still report success, and a series that covers only part of the run would otherwise
     * be graded as if it were the whole of it.
     * @private
     * @param {number[]} time The time series the run returned
     */
    _assertRunReachedStop(time) {
        const { stop, dt } = this.specs;
        if (!Number.isFinite(stop) || !Number.isFinite(dt) || !time || time.length === 0) {
            return;
        }
        const last = time[time.length - 1];
        if (last < stop - dt / 2) {
            throw new Error(`Simulation ended early: PySD stopped at time ${last} of a run to ${stop}.`);
        }
    }

    /**
     * Execute the Python simulator with given input
     * @private
     * @param {Object} input - Input object to send to Python script
     * @returns {Promise<Object>} Parsed result from Python script
     */
    _executePython(input) {
        return new Promise((resolve, reject) => {
            const pythonProcess = spawn(this.pythonCommand, [this.simulatorScript]);

            // Buffer the raw chunks rather than concatenating them into a string as they
            // arrive: a runaway model blew past V8's maximum string length and crashed the
            // whole eval run with "RangeError: Invalid string length". Holding Buffers also
            // keeps multi-byte UTF-8 characters intact across chunk boundaries.
            const stdoutChunks = [];
            const stderrChunks = [];
            let stdoutBytes = 0;
            let stderrBytes = 0;
            let settled = false;

            const settle = (error, value) => {
                if (settled) {
                    return;
                }
                settled = true;
                // Release whatever we buffered; on the overflow path this can be hundreds of MB.
                stdoutChunks.length = 0;
                stderrChunks.length = 0;
                if (error) {
                    reject(error);
                } else {
                    resolve(value);
                }
            };

            pythonProcess.stdout.on('data', (data) => {
                if (settled) {
                    return;
                }

                stdoutBytes += data.length;
                if (stdoutBytes > MAX_STDOUT_BYTES) {
                    pythonProcess.kill('SIGKILL');
                    settle(new Error(
                        `Python process produced more than ${MAX_STDOUT_BYTES} bytes of output before it finished. ` +
                        `This usually means the model has a runaway simulation spec (a tiny dt or an enormous stop time).`
                    ));
                    return;
                }

                stdoutChunks.push(data);
            });

            pythonProcess.stderr.on('data', (data) => {
                if (settled || stderrBytes > MAX_STDERR_BYTES) {
                    return;
                }
                // stderr is only ever used for diagnostics, so drop the overflow and let the
                // process run instead of killing it over chatty warnings.
                stderrBytes += data.length;
                stderrChunks.push(data);
            });

            pythonProcess.on('close', (code) => {
                if (settled) {
                    return;
                }

                const stdout = Buffer.concat(stdoutChunks).toString('utf8');
                const stderr = Buffer.concat(stderrChunks).toString('utf8');

                if (code !== 0) {
                    settle(new Error(`Python process exited with code ${code}\nStderr: ${truncateForError(stderr)}\nStdout: ${truncateForError(stdout)}`));
                    return;
                }

                try {
                    const result = JSON.parse(stdout);

                    if (!result.success) {
                        settle(new Error(result.error || 'Unknown error from Python script'));
                        return;
                    }

                    settle(null, result);
                } catch (e) {
                    settle(new Error(`Failed to parse Python output: ${e.message}\nOutput: ${truncateForError(stdout)}`));
                }
            });

            pythonProcess.on('error', (err) => {
                settle(new Error(`Failed to start Python process: ${err.message}`));
            });

            // Killing the process on overflow (or a Python crash) can tear the pipe down while
            // we are still writing the model, which surfaces here as EPIPE. That is expected,
            // and the real failure is already reported through the handlers above.
            pythonProcess.stdin.on('error', () => {});

            // Send input to Python script via stdin
            pythonProcess.stdin.write(JSON.stringify(input));
            pythonProcess.stdin.end();
        });
    }
}

export default PySDSimulator;
