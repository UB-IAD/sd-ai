/**
 * The general rule that gives a transferability case for any scenario without a hand-written one,
 * so a new scenario needs no case of its own. The policy is the scenario's misconception (a change
 * that does not meet the goal). Two of its bounded levers are pushed past their realistic limits —
 * the limits the scenario's own realistic text states, which the case gives the agent — until the
 * misconception, with them, meets the goal: those are the two unrealistic assumptions. One is noted
 * as a source ("From a consultant's report"), one as an assumption, so the wording gives nothing
 * away. The two sound assumptions are numbers left as they are: a protected quantity, noted as an
 * assumption that it stays as it has been, and an ordinary parameter (or, if the scenario has
 * none, a stock's recorded start or a second protected quantity), noted as from the records.
 */

import { glossaryModel } from '../../utilities/scenarios/renameModel.js';
import { simulateModel } from '../../utilities/simulateModel.js';
import { findVariable, isNumericEquation, foldName } from '../../utilities/modelDiff.js';

const FACTORS = [1.5, 2, 3, 5, 10];
const MARGIN = 0.10;

const goalVariable = (s) => Object.entries(s.glossaryToModel).find(([, m]) => m === s.goal.variable)?.[0] ?? s.goal.variable;
const toGlossary = (s, modelName) => Object.entries(s.glossaryToModel).find(([, m]) => m === modelName)?.[0] ?? modelName;

/** The goal measure, and whether it meets the goal with a margin, on the glossary model with overrides (glossary names). */
const goalWith = async function(s, overrides) {
    const m = { ...glossaryModel(s), specs: s.model.specs };
    for (const [n, v] of Object.entries(overrides)) findVariable(m.variables, n).equation = String(v);
    const g = findVariable(m.variables, goalVariable(s)).name;
    const run = await simulateModel(m, [g], null);
    if (!run.ok) return null;
    const x = run.series[g];
    const { measure, time, threshold, direction } = s.goal;
    const value = measure === 'max' ? Math.max(...x) : measure === 'overshoot' ? Math.max(...x) - x[x.length - 1] : x[run.time.findIndex((t) => t >= time - 1e-9)];
    const meets = direction === 'below' ? value < threshold * (1 - MARGIN) : value > threshold * (1 + MARGIN);
    // Misses by the margin: what the policy alone must do, so its assumptions are what make it work.
    const misses = direction === 'below' ? value > threshold * (1 + MARGIN) : value < threshold * (1 - MARGIN);
    return { value, meets, misses };
};

const fmt = (x) => Number(Number(x).toPrecision(3));

/** A value past a lever's realistic limit, in the direction that helps: beyond its max or below its min. */
const beyond = (bound, side, factor) => (side === 'max' ? bound.max * factor : bound.min / factor);

/**
 * @returns {Promise<Object|null>} A case in the shape of transferabilityData/cases.js, or null if the
 *   scenario cannot give one (no misconception, fewer than two bounded levers, or no push past the
 *   limits that meets the goal)
 */
export const generateCase = async function(s) {
    const mis = s.policies?.find((p) => p.id === s.misconception);
    const bounds = s.realistic?.bounds || {};
    if (!mis || Object.keys(bounds).length < 2) return null;
    const policyChanges = Object.fromEntries(Object.entries(mis.overrides).map(([n, v]) => [toGlossary(s, n), String(v)]));
    const base = glossaryModel(s);
    const valueOf = (n) => Number(findVariable(base.variables, n)?.equation);
    // Which side of each bounded lever helps the goal, from a small push each way on top of the policy.
    const sides = [];
    for (const [name, b] of Object.entries(bounds)) {
        if (!Number.isFinite(valueOf(name))) continue;
        for (const side of ['max', 'min']) {
            if (b[side] === undefined) continue;
            // A push must land strictly past the limit: dividing a lower limit of 0 stays at 0.
            if (!(side === 'max' ? beyond(b, side, FACTORS[0]) > b.max : beyond(b, side, FACTORS[0]) < b.min)) continue;
            const at = await goalWith(s, { ...policyChanges, [name]: b[side] });
            const none = await goalWith(s, policyChanges);
            if (!at || !none) continue;
            const better = s.goal.direction === 'below' ? at.value < none.value : at.value > none.value;
            if (better) sides.push({ name, side, bound: b });
        }
    }
    if (sides.length < 2) return null;
    // The misconception's own lever first, if it is bounded and pushing past its limit goes the
    // same way as the policy (so the assumption extends the policy rather than undoing it); then the
    // other levers that help.
    const ownName = (x) => Object.keys(policyChanges).find((n) => foldName(n) === foldName(x.name));
    const sameWay = (x) => { const n = ownName(x); const to = Number(policyChanges[n]); const from = valueOf(n); return x.side === 'max' ? to > from : to < from; };
    const own = sides.filter((x) => ownName(x) && sameWay(x));
    const others = sides.filter((x) => !ownName(x));
    const pair = [...own, ...others].filter((x, i, all) => all.findIndex((y) => y.name === x.name) === i).slice(0, 2);
    if (pair.length < 2) return null;
    for (const f of FACTORS) {
        const pushed = Object.fromEntries(pair.map((x) => [x.name, beyond(x.bound, x.side, f)]));
        const withThem = await goalWith(s, { ...policyChanges, ...pushed });
        if (!withThem?.meets) continue;
        const reverted = await goalWith(s, policyChanges);
        if (!reverted || !reverted.misses) return null;
        const protectedConstant = s.protected.variables.find((n) => isNumericEquation(findVariable(base.variables, n)?.equation));
        const ordinary = base.variables.find((v) => v.type !== 'stock' && isNumericEquation(v.equation) && Number(v.equation) !== 0
            && !s.levers.some((l) => foldName(l) === foldName(v.name)) && !s.protected.variables.some((p) => foldName(p) === foldName(v.name))
            && !Object.keys(bounds).some((b) => foldName(b) === foldName(v.name)) && !Object.keys(policyChanges).some((n) => foldName(n) === foldName(v.name)));
        // The second sound note: an ordinary parameter if there is one; else a stock's recorded
        // start, or a second protected quantity, as it is.
        const startStock = base.variables.find((v) => v.type === 'stock' && isNumericEquation(v.equation) && Number(v.equation) !== 0 && foldName(v.name) !== foldName(protectedConstant || '') && !pair.some((x) => foldName(x.name) === foldName(v.name)));
        const secondProtected = s.protected.variables.find((n) => n !== protectedConstant && isNumericEquation(findVariable(base.variables, n)?.equation));
        const sound = ordinary || startStock || (secondProtected && findVariable(base.variables, secondProtected));
        if (!protectedConstant || !sound) return null;
        const [u1, u2] = pair;
        return {
            scenario: s.id,
            policy: mis.text.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase()),
            context: s.realistic.text,
            generated: true,
            policyChanges,
            assumptions: [
                { id: `${u1.name} pushed`, variable: u1.name, value: String(fmt(pushed[u1.name])), realistic: false, note: `Assumed "${u1.name}" can be brought to ${fmt(pushed[u1.name])}.`, revert: findVariable(base.variables, u1.name).equation },
                { id: `${u2.name} pushed`, variable: u2.name, value: String(fmt(pushed[u2.name])), realistic: false, note: `From a consultant's report: "${u2.name}" can be ${fmt(pushed[u2.name])}.`, revert: findVariable(base.variables, u2.name).equation },
                { id: `${protectedConstant} as it is`, variable: protectedConstant, realistic: true, note: `Assumed "${protectedConstant}" stays at ${fmt(valueOf(protectedConstant))}, as it has been.` },
                { id: `${sound.name} from records`, variable: sound.name, realistic: true, note: `From our records: "${sound.name}" ${sound.type === 'stock' ? 'started at' : 'is'} about ${fmt(sound.equation)}.` }
            ]
        };
    }
    return null;
};

/** Finer pushes for the hard cases: the smallest step past a limit that makes the policy work. */
const HARD_FACTORS = [1.25, 1.5, 2, 3, 5, 10];

/**
 * The hard group's general rule: as generateCase, with three unrealistic assumptions among three
 * sound ones. Three bounded levers that help the policy are pushed past their realistic limits by
 * the smallest factor in HARD_FACTORS with which the policy meets the goal (with the margin); the
 * policy without them must miss it (with the margin). The three sound assumptions are numbers left
 * as they are: protected constants, ordinary parameters and stocks' recorded starts, one of each
 * kind where there is one. Every other bounded lever is noted too, as sound, at the value it has in
 * the case's model (the policy's own lever at its new value) where that is within its realistic
 * limits, in the same wording as the unrealistic notes: a lever the account limits is not by that
 * alone a number to doubt. Each side has notes written as assumptions and notes citing a source,
 * so the wording gives nothing away.
 * @returns {Promise<Object|null>} A case, or null if the scenario cannot give one
 */
export const generateHardCase = async function(s) {
    const mis = s.policies?.find((p) => p.id === s.misconception);
    const bounds = s.realistic?.bounds || {};
    if (!mis || Object.keys(bounds).length < 3) return null;
    const policyChanges = Object.fromEntries(Object.entries(mis.overrides).map(([n, v]) => [toGlossary(s, n), String(v)]));
    const base = glossaryModel(s);
    const valueOf = (n) => Number(findVariable(base.variables, n)?.equation);
    const none = await goalWith(s, policyChanges);
    if (!none || !none.misses) return null;
    const sides = [];
    for (const [name, b] of Object.entries(bounds)) {
        if (!Number.isFinite(valueOf(name))) continue;
        for (const side of ['max', 'min']) {
            if (b[side] === undefined) continue;
            if (!(side === 'max' ? beyond(b, side, HARD_FACTORS[0]) > b.max : beyond(b, side, HARD_FACTORS[0]) < b.min)) continue;
            const at = await goalWith(s, { ...policyChanges, [name]: b[side] });
            if (!at) continue;
            const better = s.goal.direction === 'below' ? at.value < none.value : at.value > none.value;
            if (better) sides.push({ name, side, bound: b });
        }
    }
    const ownName = (x) => Object.keys(policyChanges).find((n) => foldName(n) === foldName(x.name));
    const sameWay = (x) => { const n = ownName(x); const to = Number(policyChanges[n]); const from = valueOf(n); return x.side === 'max' ? to > from : to < from; };
    const own = sides.filter((x) => ownName(x) && sameWay(x));
    const others = sides.filter((x) => !ownName(x));
    const trio = [...own, ...others].filter((x, i, all) => all.findIndex((y) => y.name === x.name) === i).slice(0, 3);
    if (trio.length < 3) return null;
    let pushed = null;
    for (const f of HARD_FACTORS) {
        const p = Object.fromEntries(trio.map((x) => [x.name, fmt(beyond(x.bound, x.side, f))]));
        const withThem = await goalWith(s, { ...policyChanges, ...p });
        if (withThem?.meets) { pushed = p; break; }
    }
    if (!pushed) return null;
    const used = new Set([...trio.map((x) => foldName(x.name)), ...Object.keys(policyChanges).map(foldName)]);
    const numeric = (v) => v && isNumericEquation(v.equation) && Number(v.equation) !== 0;
    const isLever = (n) => s.levers.some((l) => foldName(l) === foldName(n)) || Object.keys(bounds).some((b) => foldName(b) === foldName(n));
    const isProtected = (n) => s.protected.variables.some((p) => foldName(p) === foldName(n));
    const candidates = [
        ...s.protected.variables.map((n) => findVariable(base.variables, n)).filter((v) => numeric(v) && v.type !== 'stock').map((v) => ({ v, kind: 'protected' })),
        ...base.variables.filter((v) => v.type !== 'stock' && numeric(v) && !isLever(v.name) && !isProtected(v.name)).map((v) => ({ v, kind: 'ordinary' })),
        ...base.variables.filter((v) => v.type === 'stock' && numeric(v) && !isLever(v.name)).map((v) => ({ v, kind: 'start' }))
    ].filter((c, i, all) => !used.has(foldName(c.v.name)) && all.findIndex((d) => foldName(d.v.name) === foldName(c.v.name)) === i);
    const sound = [];
    for (const kind of ['protected', 'ordinary', 'start']) { const c = candidates.find((x) => x.kind === kind); if (c) sound.push(c); }
    for (const c of candidates) if (sound.length < 3 && !sound.includes(c)) sound.push(c);
    if (sound.length < 3) return null;
    const soundNote = (c, i) => {
        const n = c.v.name;
        const x = fmt(c.v.equation);
        if (c.kind === 'start') return i === 0 ? `Assumed "${n}" starts at ${x}, where it was when we began.` : `From our records: "${n}" started at about ${x}.`;
        if (c.kind === 'protected') return i === 0 ? `Assumed "${n}" stays at ${x}, as it has been.` : `From our records: "${n}" has been about ${x}.`;
        return i === 0 ? `Assumed "${n}" is ${x}, as it has been.` : `From our records: "${n}" is about ${x}.`;
    };
    const [u1, u2, u3] = trio;
    const unrealistic = (x, note) => ({ id: `${x.name} pushed`, variable: x.name, value: String(pushed[x.name]), realistic: false, note, revert: findVariable(base.variables, x.name).equation });
    // Within-limit levers: every other bounded lever, noted at the value it has in the case's model
    // (the policy's own lever at its new value) when that is within its realistic limits, in the
    // unrealistic notes' own wording — so a lever the account puts a limit on is not by that alone a
    // number to doubt; its value has to be checked against the limit.
    const LEVER_NOTES = [
        (n, x) => `Assumed "${n}" can be brought to ${x}.`,
        (n, x) => `From a consultant's report: "${n}" can be ${x}.`,
        (n, x) => `From an industry benchmark study: "${n}" of ${x} is achievable.`
    ];
    const within = Object.entries(bounds).map(([name, b]) => {
        if (trio.some((x) => foldName(x.name) === foldName(name))) return null;
        const own = Object.keys(policyChanges).find((n) => foldName(n) === foldName(name));
        const x = Number(own ? policyChanges[own] : valueOf(name));
        if (!Number.isFinite(x) || (b.max !== undefined && x > b.max) || (b.min !== undefined && x < b.min)) return null;
        return { name: findVariable(base.variables, name).name, x: fmt(x) };
    }).filter(Boolean).map((l, i) => ({ id: `${l.name} within its limit`, variable: l.name, realistic: true, note: LEVER_NOTES[i % LEVER_NOTES.length](l.name, l.x) }));
    return {
        scenario: s.id,
        policy: mis.text.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase()),
        context: s.realistic.text,
        generated: true,
        policyChanges,
        assumptions: [
            unrealistic(u1, `Assumed "${u1.name}" can be brought to ${pushed[u1.name]}.`),
            unrealistic(u2, `From a consultant's report: "${u2.name}" can be ${pushed[u2.name]}.`),
            unrealistic(u3, `From an industry benchmark study: "${u3.name}" of ${pushed[u3.name]} is achievable.`),
            ...sound.slice(0, 3).map((c, i) => ({ id: `${c.v.name} as it is`, variable: c.v.name, realistic: true, note: soundNote(c, i) })),
            ...within
        ]
    };
};
