/**
 * Held-out bookkeeping shared by the agent categories.
 *
 * A test is held out when the case it comes from is: a scenario with `split: 'heldout'` in the
 * scenario library, or a hand-written case, corpus or diagram marked `heldOut`. Every category's
 * groups are split by it: held-out tests move from a group `g` to `gHeldOut`, so a run can select
 * dev and held-out tests separately (the runner selects by group) and report the gap between them.
 * Every test also carries `heldOut: true|false`.
 *
 * @module utilities/heldOut
 */

import { scenarios } from './scenarios/library.js';

/** Whether a scenario of the library is held out. */
export const isHeldOutScenario = (id) => scenarios[id]?.split === 'heldout';

/** Whether a case is held out: marked so, or built on a held-out scenario. */
export const caseHeldOut = (c) => Boolean(c && (c.heldOut || (c.scenario && isHeldOutScenario(c.scenario))));

/**
 * Whether a case is built on a held-out scenario of a later batch: `batch` 2, written after Phase 2's
 * runs. Rules that cap how many held-out cases they take count only the first batch toward the cap,
 * so adding a later batch never displaces a case already picked.
 */
export const laterBatch = (c) => Boolean(c?.scenario && (scenarios[c.scenario]?.batch ?? 1) > 1);

export const HELD_OUT_SUFFIX = 'HeldOut';

/**
 * Split each group into its dev tests (kept under the group's name) and its held-out tests (under
 * `${name}HeldOut`), marking every test. A group with no held-out tests stays as it is.
 * @param {Object<string, Array<Object>>} groups The category's groups
 * @param {function(Object): boolean} isHeldOut Whether a test is held out
 * @returns {Object<string, Array<Object>>} The split groups
 */
export const splitHeldOut = function(groups, isHeldOut) {
    const out = {};
    for (const [name, tests] of Object.entries(groups)) {
        const marked = tests.map((t) => ({ ...t, heldOut: Boolean(isHeldOut(t)) }));
        const dev = marked.filter((t) => !t.heldOut);
        const held = marked.filter((t) => t.heldOut);
        if (dev.length) out[name] = dev;
        if (held.length) out[`${name}${HELD_OUT_SUFFIX}`] = held;
    }
    return out;
};

/** Every test of a group as it was before the split: its dev and held-out halves together. */
export const groupTests = (groups, name) => [...(groups[name] || []), ...(groups[`${name}${HELD_OUT_SUFFIX}`] || [])];
