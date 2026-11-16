/**
 * Each new agent category's role, by the kind of task it tests, not by how it scores.
 *
 * - A regression guard checks correctness the product must never lose. A good agent should pass
 *   it; a drop in its score means quality has slipped. It must have enough cases, and enough held
 *   out, to show a real slip, but it is not built to leave headroom.
 * - A discriminating category tests a judgement skill the suite exists to compare agents on. Its
 *   hard group carries the headroom (held-out hard at or below 0.70 with at least 3 generations);
 *   its ordinary groups may score high and then double as regression coverage.
 *
 * Both kinds stay in the suite and on the board, scored the same way.
 * @module utilities/categoryRoles
 */

export const REGRESSION_GUARD = 'regression guard';
export const DISCRIMINATING = 'discriminating';

export const CATEGORY_ROLES = {
    equilibrium: { kind: REGRESSION_GUARD, reason: 'The returned model is in equilibrium with nothing else changed, checked by simulation.' },
    unitConsistency: { kind: REGRESSION_GUARD, reason: 'Equations are dimensionally consistent, checked by the unit checker.' },
    cldInterpretation: { kind: REGRESSION_GUARD, reason: 'Loop polarity and the effects of a change are read off a diagram correctly; the key is computed from the graph.' },
    modelToCLD: { kind: REGRESSION_GUARD, reason: 'The diagram drawn from a model carries its loops with the right polarity.' },
    guidedCorrection: { kind: REGRESSION_GUARD, reason: 'Planted errors are named and fixed, so the model simulates like the correct one.' },
    mece: { kind: REGRESSION_GUARD, reason: 'Planted double counting and gaps are flagged and fixed.' },
    formulationCritique: { kind: REGRESSION_GUARD, reason: 'Bad formulations defined by the linter are found and fixed, and a clean model is left alone.' },
    extremeConditions: { kind: REGRESSION_GUARD, reason: 'Planted extreme-condition failures are found by running the model, and fixed.' },
    sensitivityInterpretation: { kind: REGRESSION_GUARD, reason: 'Sensitivity results that are handed over are read correctly; choosing the analysis is analysisSetup.' },
    causalSources: { kind: REGRESSION_GUARD, reason: 'Only uploaded documents that state a link are cited, the rest are marked as assumptions, and nothing is fabricated.' },
    elicitation: { kind: DISCRIMINATING, reason: 'Asking the questions that draw out the facts that matter.' },
    noviceCoaching: { kind: DISCRIMINATING, reason: 'Bringing a novice, by questions, to a policy that works.' },
    multiplePerspectives: { kind: DISCRIMINATING, reason: 'Keeping rival views apart and proposing a test that separates them.' },
    sfdFromBoundary: { kind: DISCRIMINATING, reason: 'Choosing what belongs inside the model boundary.' },
    referenceModes: { kind: DISCRIMINATING, reason: 'Specifying and forecasting the behaviour a model must explain.' },
    cldStocksAndLeverage: { kind: DISCRIMINATING, reason: 'Finding the points of high leverage.' },
    policyImplementation: { kind: DISCRIMINATING, reason: 'Designing a policy that meets a goal beyond the options listed.' },
    transferability: { kind: DISCRIMINATING, reason: 'Spotting the assumptions that would fail in practice.' },
    archetypes: { kind: DISCRIMINATING, reason: 'Recognising the archetype a problem fits.' },
    mentalModelVsBug: { kind: DISCRIMINATING, reason: 'Telling a wrong expectation from a bug in the model.' },
    analysisSetup: { kind: DISCRIMINATING, reason: 'Choosing what to vary in an analysis, and over what ranges.' },
    policyAnalysisMethods: { kind: DISCRIMINATING, reason: 'Choosing and running the right analysis for a question.' },
    calibration: { kind: DISCRIMINATING, reason: 'Fitting history, and telling parameter error from missing structure.' },
    aggregationCritique: { kind: DISCRIMINATING, reason: 'Choosing the level of aggregation.' }
};

/** The sentence a category's methodology states about its role. */
export const roleStatement = function(name) {
    const r = CATEGORY_ROLES[name];
    if (!r) return null;
    return r.kind === REGRESSION_GUARD
        ? `Role: regression guard. ${r.reason} A good agent should pass it; a drop in this category's score means quality has slipped, not that the task got harder.`
        : `Role: discriminating. ${r.reason} The hard group carries the headroom that tells agents apart; the ordinary groups may score high and then also guard against regressions.`;
};
