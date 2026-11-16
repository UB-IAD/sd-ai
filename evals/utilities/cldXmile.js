/**
 * Write a causal loop diagram as XMILE the way Stella saves one.
 *
 * SDJsonToXMILE is built for simulating models: a CLD's variables become auxiliaries with
 * placeholder equations and its links survive only as references inside those equations, so the
 * link polarities are lost. A CLD handed to an agent as an uploaded file has to carry its links and
 * their polarities, and in a Stella CLD those live on the diagram's connectors. This writes the
 * variables as equation-less auxiliaries and every link as a view connector with its polarity.
 *
 * @module utilities/cldXmile
 */

const escapeXml = (text) => String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const xmileName = (name) => String(name).trim().replace(/\s+/g, '_');

/**
 * Convert a CLD to XMILE text.
 *
 * Variables are laid out on a circle so the file opens as a readable diagram in Stella; positions
 * carry no meaning.
 *
 * @param {{variables?: Array<{name: string, documentation?: string}>, relationships: Array<{from: string, to: string, polarity: string}>}} cld The CLD
 * @param {string} modelName Name written into the header
 * @returns {string} XMILE
 */
export const cldToXmile = function(cld, modelName) {
    const names = [];
    const docs = new Map();
    for (const variable of cld.variables || []) {
        if (!names.includes(variable.name)) names.push(variable.name);
        if (variable.documentation) docs.set(variable.name, variable.documentation);
    }
    for (const rel of cld.relationships) {
        for (const name of [rel.from, rel.to]) if (!names.includes(name)) names.push(name);
    }

    const radius = 60 + 25 * names.length;
    const center = radius + 60;
    const position = new Map(names.map((name, i) => {
        const angle = (2 * Math.PI * i) / names.length;
        return [name, { x: Math.round(center + radius * Math.cos(angle)), y: Math.round(center + radius * Math.sin(angle)) }];
    }));

    const variables = names.map((name) => {
        const doc = docs.has(name) ? `\n\t\t\t\t<doc>${escapeXml(docs.get(name))}</doc>` : '';
        return `\t\t\t<aux name="${escapeXml(name)}">${doc}\n\t\t\t</aux>`;
    }).join('\n');

    const auxViews = names.map((name) => {
        const p = position.get(name);
        return `\t\t\t\t<aux x="${p.x}" y="${p.y}" name="${escapeXml(name)}"/>`;
    }).join('\n');

    const connectors = cld.relationships.map((rel, i) => {
        const a = position.get(rel.from);
        const b = position.get(rel.to);
        const angle = ((Math.atan2(a.y - b.y, b.x - a.x) * 180) / Math.PI + 360) % 360;
        return `\t\t\t\t<connector uid="${i + 1}" angle="${angle.toFixed(2)}" polarity="${rel.polarity}">\n\t\t\t\t\t<from>${escapeXml(xmileName(rel.from))}</from>\n\t\t\t\t\t<to>${escapeXml(xmileName(rel.to))}</to>\n\t\t\t\t</connector>`;
    }).join('\n');

    return `<?xml version="1.0" encoding="utf-8"?>
<xmile version="1.0" xmlns="http://docs.oasis-open.org/xmile/ns/XMILE/v1.0" xmlns:isee="http://iseesystems.com/XMILE">
\t<header>
\t\t<smile version="1.0" namespace="std, isee"/>
\t\t<name>${escapeXml(modelName)}</name>
\t\t<vendor>sd-ai-evals</vendor>
\t\t<product version="1.0">sd-ai-evals</product>
\t</header>
\t<sim_specs method="Euler" time_units="Months">
\t\t<start>1</start>
\t\t<stop>13</stop>
\t\t<dt>0.25</dt>
\t</sim_specs>
\t<model>
\t\t<variables>
${variables}
\t\t</variables>
\t\t<views>
\t\t\t<view type="stock_flow">
${auxViews}
${connectors}
\t\t\t</view>
\t\t</views>
\t</model>
</xmile>
`;
};
