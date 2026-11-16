/**
 * A small parser for the equations sd-json models carry (XMILE / Stella syntax).
 *
 * sd-ai had no equation parser: SDJsonToXMILE passes equations through as text and PySD parses
 * them. The unit checker needs the structure, so this reads the subset the evals' models use:
 * numbers, variable references (bare, underscored, or "quoted with spaces"), + - * / ^ and the
 * safe-division //, comparisons, AND/OR/NOT, IF THEN ELSE, and function calls.
 *
 * AST nodes:
 *   {type: 'number', value}
 *   {type: 'name', name}                 a variable reference, or a bare builtin like TIME
 *   {type: 'unary', op, arg}             op is '-', '+' or 'not'
 *   {type: 'binary', op, left, right}    op is + - * / // ^ = <> < <= > >= and or
 *   {type: 'if', cond, then, else}
 *   {type: 'call', name, args}           name upper-cased
 *
 * @module utilities/units/equationParser
 */

const TOKEN = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|("(?:[^"\\]|\\.)*")|([A-Za-z_][A-Za-z0-9_.$]*)|(\/\/|<>|<=|>=|[-+*/^(),=<>\[\]]))/y;

/**
 * Split an equation into tokens.
 * @param {string} text The equation
 * @returns {Array<{kind: string, value: string}>} Tokens
 * @throws {Error} On a character the grammar does not know
 */
export const tokenize = function(text) {
    const tokens = [];
    let index = 0;
    const src = String(text);
    while (index < src.length) {
        if (/\s/.test(src[index])) { index++; continue; }
        TOKEN.lastIndex = index;
        const m = TOKEN.exec(src);
        if (!m || m.index !== index && src.slice(index, m.index).trim() !== '') throw new Error(`Unexpected "${src[index]}" in equation "${src}"`);
        index = TOKEN.lastIndex;
        if (m[1] !== undefined) tokens.push({ kind: 'number', value: m[1] });
        else if (m[2] !== undefined) tokens.push({ kind: 'name', value: m[2].slice(1, -1) });
        else if (m[3] !== undefined) tokens.push({ kind: 'word', value: m[3] });
        else tokens.push({ kind: 'op', value: m[4] });
    }
    return tokens;
};

const BINARY = {
    or: 1, and: 2,
    '=': 3, '<>': 3, '<': 4, '<=': 4, '>': 4, '>=': 4,
    '+': 5, '-': 5,
    '*': 6, '/': 6, '//': 6,
    '^': 8
};

/**
 * Parse an equation.
 * @param {string} text The equation
 * @returns {Object} The AST
 * @throws {Error} When the equation is not in the supported grammar
 */
export const parseEquation = function(text) {
    const tokens = tokenize(text);
    let pos = 0;
    const peek = () => tokens[pos];
    const isWord = (t, word) => t && t.kind === 'word' && t.value.toLowerCase() === word;
    const opOf = (t) => {
        if (!t) return null;
        if (t.kind === 'op' && BINARY[t.value] !== undefined) return t.value;
        if (isWord(t, 'and')) return 'and';
        if (isWord(t, 'or')) return 'or';
        return null;
    };
    const expect = (value) => {
        const t = tokens[pos++];
        if (!t || t.value !== value) throw new Error(`Expected "${value}" in "${text}"`);
    };

    const parsePrimary = () => {
        const t = tokens[pos++];
        if (!t) throw new Error(`Unexpected end of "${text}"`);
        if (t.kind === 'number') return { type: 'number', value: Number(t.value) };
        if (t.kind === 'op' && t.value === '(') {
            const inner = parseExpression(0);
            expect(')');
            return inner;
        }
        if (t.kind === 'op' && (t.value === '-' || t.value === '+')) return { type: 'unary', op: t.value, arg: parseExpression(7) };
        if (isWord(t, 'not')) return { type: 'unary', op: 'not', arg: parseExpression(3) };
        if (isWord(t, 'if')) {
            const cond = parseExpression(0);
            if (!isWord(peek(), 'then')) throw new Error(`Expected THEN in "${text}"`);
            pos++;
            const thenBranch = parseExpression(0);
            if (!isWord(peek(), 'else')) throw new Error(`Expected ELSE in "${text}"`);
            pos++;
            return { type: 'if', cond, then: thenBranch, else: parseExpression(0) };
        }
        if (t.kind === 'word' || t.kind === 'name') {
            if (peek() && peek().kind === 'op' && peek().value === '(' && t.kind === 'word') {
                pos++;
                const args = [];
                if (!(peek() && peek().value === ')')) {
                    args.push(parseExpression(0));
                    while (peek() && peek().value === ',') { pos++; args.push(parseExpression(0)); }
                }
                expect(')');
                return { type: 'call', name: t.value.toUpperCase(), args };
            }
            return { type: 'name', name: t.value };
        }
        throw new Error(`Unexpected "${t.value}" in "${text}"`);
    };

    const parseExpression = (minPrecedence) => {
        let left = parsePrimary();
        for (;;) {
            const op = opOf(peek());
            if (op === null) break;
            const precedence = BINARY[op];
            if (precedence < minPrecedence) break;
            pos++;
            // ^ is right-associative; everything else is left-associative.
            const right = parseExpression(op === '^' ? precedence : precedence + 1);
            left = { type: 'binary', op, left, right };
        }
        return left;
    };

    const ast = parseExpression(0);
    if (pos !== tokens.length) throw new Error(`Unexpected "${tokens[pos].value}" in "${text}"`);
    return ast;
};
