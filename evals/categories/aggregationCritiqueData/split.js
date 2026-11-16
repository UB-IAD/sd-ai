/**
 * Split an aggregate sd-json model into groups: every variable is copied once per group (named
 * "<name> <group>"), each copy's equation refers to its own group's copies, and group overrides set
 * the groups' own values. Variables listed as `shared` stay single (a city-wide advertising effect).
 * For each `totals` name, a variable "<name>" is added that sums the groups' copies, so a split
 * model can be read with the aggregate model's names.
 */

const token = (name) => name.trim().replace(/\s+/g, '_');
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const splitModel = function(model, groups, overrides, shared, totals) {
    const names = model.variables.map((v) => v.name).filter((n) => !shared.includes(n)).sort((a, b) => b.length - a.length);
    const renameIn = (equation, group) => {
        let out = String(equation);
        for (const n of names) out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${escape(token(n))}(?![A-Za-z0-9_])`, 'gi'), `${token(n)}_${group}`);
        return out;
    };
    const variables = [];
    for (const v of model.variables) {
        if (shared.includes(v.name)) { variables.push(structuredClone(v)); continue; }
        for (const g of groups) {
            const copy = structuredClone(v);
            copy.name = `${v.name} ${g}`;
            copy.equation = overrides[g]?.[v.name] !== undefined ? String(overrides[g][v.name]) : renameIn(v.equation, g);
            if (copy.inflows) copy.inflows = copy.inflows.map((f) => `${f} ${g}`);
            if (copy.outflows) copy.outflows = copy.outflows.map((f) => `${f} ${g}`);
            variables.push(copy);
        }
    }
    for (const t of totals) {
        const v = model.variables.find((x) => x.name === t);
        variables.push({ name: `${t} total`, type: 'variable', equation: groups.map((g) => `${token(t)}_${g}`).join(' + '), units: v.units });
    }
    return { variables, relationships: [], specs: structuredClone(model.specs) };
};
