/**
 * Deterministic behavior-shape labels for a simulated series.
 *
 * The answer keys of the sensitivity categories need to say, without judgment, whether a parameter
 * change altered the *shape* of a behavior or only its size. This counts turning points with
 * hysteresis (a wiggle smaller than a set share of the series' range is not a turn), which is
 * enough to tell the shapes modelers name apart: flat, rising, falling, rising then falling,
 * falling then rising, and oscillating. Being plain code, the same series always gets the same
 * label, and the keys built from it are fixed.
 *
 * @module utilities/shape
 */

/** The shape vocabulary, in the words the categories use with engines. */
export const SHAPES = ['flat', 'rising', 'falling', 'rises then falls', 'falls then rises', 'oscillating'];

/**
 * Label the shape of a series.
 *
 * @param {Array<number>} values The series
 * @param {number} flatShare A series whose range is below this share of its mean magnitude is flat
 * @param {number} turnShare A reversal must exceed this share of the range to count as a turn
 * @returns {{shape: string, turns: number}} The label and how many turns it rests on
 */
export const classifyShape = function(values, flatShare, turnShare) {
    const finite = values.filter((v) => Number.isFinite(v));
    if (finite.length < 2) return { shape: 'flat', turns: 0 };
    const min = Math.min(...finite);
    const max = Math.max(...finite);
    const range = max - min;
    const scale = Math.max(Math.abs(finite.reduce((a, b) => a + b, 0) / finite.length), Math.abs(max), 1e-12);
    if (range <= flatShare * scale) return { shape: 'flat', turns: 0 };

    const threshold = turnShare * range;
    let direction = 0; // +1 rising, -1 falling, 0 undecided
    let extreme = finite[0];
    let firstDirection = 0;
    let turns = 0;
    for (const v of finite) {
        if (direction >= 0 && v > extreme) { extreme = v; if (direction === 0 && v - finite[0] > threshold) { direction = 1; firstDirection = 1; } }
        else if (direction <= 0 && v < extreme) { extreme = v; if (direction === 0 && finite[0] - v > threshold) { direction = -1; firstDirection = -1; } }
        if (direction === 1 && extreme - v > threshold) { turns++; direction = -1; extreme = v; }
        else if (direction === -1 && v - extreme > threshold) { turns++; direction = 1; extreme = v; }
    }
    if (turns === 0) return { shape: firstDirection >= 0 ? 'rising' : 'falling', turns };
    if (turns === 1) return { shape: firstDirection > 0 ? 'rises then falls' : 'falls then rises', turns };
    return { shape: 'oscillating', turns };
};

/** The defaults every category uses, so all keys agree on what a shape is. */
export const FLAT_SHARE = 0.01;
export const TURN_SHARE = 0.1;

/**
 * Label a series with the shared defaults.
 * @param {Array<number>} values The series
 * @returns {string} The shape
 */
export const shapeOf = function(values) {
    return classifyShape(values, FLAT_SHARE, TURN_SHARE).shape;
};
