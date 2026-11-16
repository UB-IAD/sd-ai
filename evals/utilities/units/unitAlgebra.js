/**
 * Unit algebra for the unit checker: parse unit strings and combine units.
 *
 * A unit is a map from base unit name to integer exponent, so "widgets/person/month" is
 * {widget: 1, person: -1, month: -1}, and the empty map is dimensionless. Unit strings come from
 * people and models, so parsing is forgiving about how they are written:
 *   - operators: *, /, ^, parentheses, and the word "per"
 *   - several words with no operator between them name one unit ("degrees C")
 *   - common abbreviations fold together (people/person, months/month/mo, yr/year), and a plural
 *     folds onto its singular when the model spells that singular somewhere (see unitVocabulary)
 *   - "dimensionless", "unitless", "fraction", "1" and "%" are dimensionless
 *
 * @module utilities/units/unitAlgebra
 */

/** Names that fold to one canonical unit. Keys and values are lower case. */
const SYNONYMS = {
    people: 'person', persons: 'person',
    // Time units fold whatever else the model spells: TIME, DT and every flow depend on them.
    mo: 'month', mos: 'month', mon: 'month', months: 'month',
    yr: 'year', yrs: 'year', annum: 'year', years: 'year',
    wk: 'week', wks: 'week', weeks: 'week',
    d: 'day', days: 'day',
    hr: 'hour', hrs: 'hour', h: 'hour', hours: 'hour',
    min: 'minute', mins: 'minute', minutes: 'minute',
    sec: 'second', secs: 'second', s: 'second', seconds: 'second',
    dollars: 'dollar',
    lbs: 'lb',
    children: 'child', geese: 'goose', mice: 'mouse', men: 'man', women: 'woman', teeth: 'tooth', feet: 'foot',
    '$': 'dollar', usd: 'dollar'
};

/**
 * Words that mean "no units". "unit" and "units" are deliberately not here: models very often use
 * "units" as the commodity (inventory in units, shipments in units per week).
 */
const DIMENSIONLESS_WORDS = new Set(['dimensionless', 'unitless', 'fraction', 'fractions', 'ratio', 'percent', '%', 'dmnl', 'nondimensional', 'none', '1']);

/**
 * The singular spellings a plural word could have, most likely first: "companies" could be
 * "company", "calories" could be "calorie", "leaves" could be "leaf" or "leafe", "analyses" could
 * be "analysis". Only spellings that actually appear in the model are used (see foldWord), so a
 * candidate that is not a real word costs nothing.
 */
const singularCandidates = function(word) {
    const out = [];
    if (word.endsWith('ies')) out.push(word.slice(0, -3) + 'y', word.slice(0, -1));
    if (word.endsWith('ves')) out.push(word.slice(0, -3) + 'f', word.slice(0, -3) + 'fe');
    if (word.endsWith('ses')) out.push(word.slice(0, -2) + 'is');
    if (word.endsWith('es')) out.push(word.slice(0, -2), word.slice(0, -1));
    else if (word.endsWith('s') && !word.endsWith('ss')) out.push(word.slice(0, -1));
    if (word.endsWith('a')) out.push(word.slice(0, -1) + 'um', word.slice(0, -1) + 'on');
    return out.filter((c) => c.length > 0);
};

/**
 * Rewrite spellings people use that the unit grammar does not read: superscript powers, a degree
 * sign, and a hyphen joining two unit words ("person-months" is person*months). Applied both when
 * parsing a unit and when collecting a model's unit words, so the two always see the same words.
 * @param {string} text A unit string
 * @returns {string} The rewritten string
 */
const preprocessUnits = function(text) {
    return text
        .replace(/²/g, '^2').replace(/³/g, '^3')
        .replace(/°\s*/g, 'degree ')
        .replace(/([A-Za-z])-(?=[A-Za-z])/g, '$1*');
};

/**
 * The words a model writes its units with, each folded through the synonyms. Plurals are folded
 * only onto singulars from this set: "calories" becomes "calorie" when the model also says
 * "calorie", and "care" never becomes "car", because folding never invents a spelling.
 * @param {Array<string>} unitTexts Every unit string in a model (variables' units and its time unit)
 * @returns {Set<string>} The vocabulary
 */
export const unitVocabulary = function(unitTexts) {
    const words = new Set();
    for (const text of unitTexts) {
        for (const w of preprocessUnits(String(text ?? '')).toLowerCase().split(/[^a-z_$%]+/)) {
            if (w) words.add(SYNONYMS[w] ?? w);
        }
    }
    return words;
};

/**
 * Fold one word: through the synonyms, then, if it is a plural whose singular the model also
 * uses, onto that singular.
 */
const foldWord = function(word, vocabulary) {
    const w = SYNONYMS[word] ?? word;
    for (const candidate of singularCandidates(w)) {
        const c = SYNONYMS[candidate] ?? candidate;
        if (c !== w && vocabulary.has(c)) return c;
    }
    return w;
};

/**
 * Fold one unit name to its canonical form, so spellings of the same unit within a model compare
 * equal. Every word of a multi-word name is folded ("degrees C" and "degree C" agree when the model
 * uses both).
 * @param {string} name A unit name as written
 * @param {Set<string>} vocabulary The model's unit words (see unitVocabulary); an empty set folds
 *   synonyms only
 * @returns {string} The canonical name ('' for dimensionless)
 */
export const canonicalUnitName = function(name, vocabulary) {
    const n = String(name).trim().toLowerCase().replace(/\s+/g, '_');
    if (DIMENSIONLESS_WORDS.has(n)) return '';
    return n.split('_').map((w) => foldWord(w, vocabulary)).join('_');
};

/** Make a unit from entries, dropping zero exponents. */
const unitOf = function(entries) {
    const u = new Map();
    for (const [name, exp] of entries) {
        if (!name) continue;
        const next = (u.get(name) || 0) + exp;
        if (next === 0) u.delete(name); else u.set(name, next);
    }
    return u;
};

export const DIMENSIONLESS = new Map();

export const multiplyUnits = (a, b) => unitOf([...a, ...b]);
export const divideUnits = (a, b) => unitOf([...a, ...[...b].map(([n, e]) => [n, -e])]);
export const powerUnits = (a, k) => unitOf([...a].map(([n, e]) => [n, e * k]));
export const sameUnits = (a, b) => a.size === b.size && [...a].every(([n, e]) => b.get(n) === e);
export const isDimensionless = (u) => u.size === 0;

/**
 * Render a unit for messages: positive exponents over negative ones.
 * @param {Map<string, number>} u A unit
 * @returns {string} e.g. "widget/(month*person)" or "dimensionless"
 */
export const formatUnits = function(u) {
    if (u.size === 0) return 'dimensionless';
    const term = ([n, e]) => (Math.abs(e) === 1 ? n : `${n}^${Math.abs(e)}`);
    const byName = (a, b) => a[0].localeCompare(b[0]);
    const up = [...u].filter(([, e]) => e > 0).sort(byName).map(term);
    const down = [...u].filter(([, e]) => e < 0).sort(byName).map(term);
    const top = up.length ? up.join('*') : '1';
    if (!down.length) return top;
    return `${top}/${down.length > 1 ? `(${down.join('*')})` : down[0]}`;
};

/**
 * Parse a unit string.
 * @param {string} text A unit as written on a variable, e.g. "widgets per person per month"
 * @param {Set<string>} vocabulary The model's unit words, for folding plurals (see unitVocabulary)
 * @returns {Map<string, number>|null} The unit, or null when the string is empty or unreadable
 */
export const parseUnits = function(text, vocabulary) {
    if (text === undefined || text === null) return null;
    const source = preprocessUnits(String(text).trim());
    if (!source) return null;
    // Tokens: names (runs of words), numbers, operators, parentheses. "per" is division.
    const tokens = [];
    const re = /\s*(\(|\)|\*|\/|\^|-?\d+(?:\.\d+)?|%|\$|[A-Za-z_][A-Za-z0-9_'.]*)/y;
    let index = 0;
    while (index < source.length) {
        re.lastIndex = index;
        const m = re.exec(source);
        if (!m) {
            if (/\s/.test(source[index])) { index++; continue; }
            return null;
        }
        index = re.lastIndex;
        const t = m[1];
        if (/^per$/i.test(t)) tokens.push('/');
        else tokens.push(t);
    }
    // Join consecutive name words into one unit name ("degrees C").
    const merged = [];
    for (const t of tokens) {
        const isWord = /^[A-Za-z_%$]/.test(t);
        const prev = merged[merged.length - 1];
        if (isWord && prev !== undefined && /^[A-Za-z_%$]/.test(prev) && !/^per$/i.test(prev)) merged[merged.length - 1] = `${prev} ${t}`;
        else merged.push(t);
    }
    // "per year" is "1/year".
    if (merged[0] === '/') merged.unshift('1');
    let pos = 0;
    const peek = () => merged[pos];
    const parseFactor = () => {
        const t = merged[pos++];
        if (t === undefined) throw new Error('unexpected end');
        let base;
        if (t === '(') {
            base = parseProduct();
            if (merged[pos++] !== ')') throw new Error('missing )');
        } else if (/^-?\d/.test(t)) {
            base = DIMENSIONLESS; // "1/year": the 1 carries no unit
        } else {
            base = unitOf([[canonicalUnitName(t, vocabulary), 1]]);
        }
        if (peek() === '^') {
            pos++;
            const exp = Number(merged[pos++]);
            if (!Number.isInteger(exp)) throw new Error('bad exponent');
            base = powerUnits(base, exp);
        }
        return base;
    };
    const parseProduct = () => {
        let u = parseFactor();
        while (peek() === '*' || peek() === '/') {
            const op = merged[pos++];
            const rhs = parseFactor();
            u = op === '*' ? multiplyUnits(u, rhs) : divideUnits(u, rhs);
        }
        return u;
    };
    try {
        const u = parseProduct();
        return pos === merged.length ? u : null;
    } catch {
        return null;
    }
};
