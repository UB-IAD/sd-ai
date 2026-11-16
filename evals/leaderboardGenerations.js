/**
 * Leaderboard generations.
 *
 * There is one results file per leaderboard, and it accumulates. The benchmark itself
 * changes over time — categories get added, tests get fixed — so a score from one round
 * is not comparable to a score from another. Rather than overwrite, each result row
 * carries the generation it was produced in, and the site groups and ranks by that.
 *
 * So a generation is a label on rows, not a file. `evals/collect.js` stamps it when
 * folding a run into a leaderboard, which is what lets one file hold several rounds
 * and still present them honestly.
 *
 * Ordered oldest first; the last one with rows present is treated as current.
 */

/**
 * The leaderboards, matching the `leaderboard_<mode>_full_results.json.gz` files.
 *
 * `agent` holds the persona-driven agent evaluations: categories graded on what an agent does
 * across a working session — the model it builds, the files it reads, the tools it runs and, for
 * conversations, every turn — rather than on one engine call.
 */
export const LEADERBOARD_MODES = ['cld', 'sfd', 'discussion', 'agent'];

/**
 * What a row with no `generation` belongs to. Every result predating generations was
 * produced by the original benchmark, so the absence of the field IS v1 — which is why
 * adding generations required no rewrite of the existing results files.
 */
export const DEFAULT_GENERATION = 'v1';

export const LEADERBOARD_GENERATIONS = [
    {
        id: 'v1',
        label: 'v1',
        description: 'The original benchmark. Predates per-test cost tracking, so these rows carry no cost.',
        // Shown alongside every v1 view. Scores here are not a clean measure of engine
        // quality, and presenting them next to later generations without saying so would
        // read as a like-for-like comparison.
        caveat: 'Some evals in this generation contained bugs that depressed engine scores. Treat v1 numbers as indicative only, and do not compare them directly against later generations.',
    },
    {
        id: 'v2',
        label: 'v2',
        description: 'Latest evals run on the engines plus the Merlin agent, with per-test cost recorded.',
    },
];

/**
 * The results filename for one leaderboard. One file per board, all generations in it.
 *
 * Gzipped — see `leaderboardFile.js`, which is the only place that reads or writes one.
 */
export function leaderboardResultsFilename(mode) {
    return `leaderboard_${mode}_full_results.json.gz`;
}

/** The generation a result row belongs to. */
export function generationOf(row) {
    return row.generation ?? DEFAULT_GENERATION;
}

/** Look up a generation by id, or undefined. */
export function findGeneration(id) {
    return LEADERBOARD_GENERATIONS.find((g) => g.id === id);
}

/**
 * Generation ids present in a result set, ordered by the registry with any undeclared
 * id appended. Undeclared ids are surfaced rather than dropped: a typo in a collect
 * command should be visible, not silently hide a whole run's results.
 */
export function generationsIn(results) {
    const present = new Set(results.map(generationOf));
    const declared = LEADERBOARD_GENERATIONS.map((g) => g.id).filter((id) => present.has(id));
    const undeclared = [...present].filter((id) => !findGeneration(id)).sort();
    return [...declared, ...undeclared];
}
