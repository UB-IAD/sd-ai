/**
 * Board titles and copy, shared by the leaderboard index and the per-board page.
 *
 * `blurb` is the one-line version for the index cards. `description` is the board's page
 * lead-in, and `categoryNotes` says what each column of that board's grid measures, keyed
 * by the category id the results carry. The page lists them in the grid's own order and
 * links each to its test, so a reader can carry a column heading straight to the line that
 * explains it and from there to the eval itself. `note` is for anything true of the board
 * rather than of one column.
 *
 * They live together so the two pages cannot disagree about what a board is, and beside
 * the boards themselves so a category added to `evals/categories` has one obvious place
 * to be described.
 */

export const leaderboardConfig = {
  cld: {
    blurb:
      'Turning plain English into causal loop diagrams: link and loop translation, extending a diagram that already exists, instruction conformance, and causal reasoning about real-world systems.',
    title: 'Causal Loop Diagrams',
    description:
      'Each column measures one thing an engine has to get right when it turns a description into a causal loop diagram.',
    categoryNotes: {
      conformance:
        'Instruction-following in open-ended real-world contexts — whether the diagram includes the variables the user named, and honors limits on how many variables and feedback loops it may contain.',
      qualitativeCausalReasoning:
        'Whether a diagram built for a real domain contains the variables and causal mechanisms domain experts consider essential.',
      qualitativeIteration:
        'Adding the relationships asked for to a diagram that already exists, without disturbing the structure already there.',
      qualitativeTranslation:
        'Extracting every causal link, with the right polarity, from single sentences, single feedback loops and sets of overlapping loops — set in a synthetic “gibberish” universe of invented variable names, so nothing can be answered from training data.',
    },
    note:
      'The qualitative-zero “engine” is the control on this board: a plain, non-prompt-engineered LLM run against the same tests.',
  },
  sfd: {
    blurb:
      'Building stock-and-flow models that actually simulate: translation and iteration, modular structure, behavioral patterns, physical laws, error fixing, conformance and documentation.',
    title: 'Stock & Flow Diagrams',
    description:
      'Each column measures one thing an engine has to get right when it builds a stock-and-flow model that simulates.',
    categoryNotes: {
      behavioralPattern:
        'Building a model that produces a named behavior over time — exponential growth or decay, logistic growth or decay, sustained oscillation — with the simulated output classified against the target.',
      conformance:
        'Instruction-following: whether the model includes the variables the user named, and honors limits on how many variables and feedback loops it may contain.',
      physicalLaws:
        'Models of pendulums, spring-mass systems and gases, checked against the physics they are meant to obey.',
      quantitativeCausalReasoning:
        'Whether a model built for a real domain carries the stocks, flows and causal mechanisms domain experts consider essential.',
      quantitativeErrorFixing:
        'Repairing a model that contains known formulation errors, and explaining what was wrong and why.',
      quantitativeIteration:
        'Extending a stock-and-flow model that already exists without breaking the structure already there.',
      quantitativeModularModification:
        'Restructuring a model on request: making a flat model modular, flattening a modular one, and adding or removing modules and relationships.',
      quantitativeModularReasoning:
        'Whether a model built for a real domain carries the expected modules, and connects them through valid cross-module relationships.',
      quantitativeModularTranslation:
        'The same translation task where the structure has to be split across modules, with both intra-module and cross-module processes.',
      quantitativeTranslation:
        'Recovering fixed, proportional and interdependent flows from a written description, set in a synthetic “gibberish” universe of invented variable names.',
      simulationCompletion:
        'The most basic property of all: that the model integrates to the end of its own time horizon instead of failing in the simulator.',
      variableDocumentation:
        'Whether every variable comes back documented, with an LLM judge rejecting documentation that merely restates the variable’s name.',
    },
  },
  discussion: {
    blurb:
      'Talking about models rather than building them: explaining feedback loops, laying out model-building steps, setting the model boundary, suggesting fixes, and guiding a novice to policy leverage.',
    title: 'Discussion',
    description:
      'Each column measures one thing an engine has to get right when it talks about a model rather than building one.',
    categoryNotes: {
      errorFixingSuggestions:
        'Identifying and explaining the formulation errors in a model it is shown — where the stock-and-flow board’s error fixing test demands a repaired model back.',
      feedbackExplanation:
        'Explaining the loops in an existing model in a way that carries the specific facts an expert would expect to hear.',
      modelBuildingSteps:
        'Laying out the sequence of steps to build a model from a problem statement and background knowledge, judged against a ground-truth sequence.',
      modelScoping:
        'The boundary decision: given a list of candidate mechanisms — some genuinely in-boundary, the rest plausible-sounding distractors — saying which belong in a model of this problem and which do not.',
      policyGuidance:
        'Tutoring a novice: handed a complete model that behaves badly, bringing them to the leverage points through guiding questions tied to the model’s feedback structure, rather than simply naming a fix.',
    },
  },
  agent: {
    blurb:
      'Agents doing the work a modeler does across a session: putting models into equilibrium, summarizing models as causal loop diagrams from the model or an uploaded file, and the other tasks modelers, teachers and decision-makers ask of them.',
    title: 'Agents',
    description:
      'Each column measures one thing an agent has to get right over a working session. Tests grade what the agent actually did — the model it left behind, the files it read, the tools it ran — rather than what it said it did.',
    categoryNotes: {
      equilibrium:
        'Parameterizing a model that starts out of balance so that every named stock holds steady, changing only the initial values and constants the user allowed — checked by diffing the model and simulating it.',
      modelToCLD:
        'Summarizing a model as a correct, succinct causal loop diagram, from the current model or from an uploaded Stella file the agent has to find and read: key loops kept with the right polarity, every link backed by a real causal path, and far fewer variables than the source.',
      guidedCorrection:
        'Finding the formulation errors planted in a model, explaining each so the modeler understands it, and fixing it — and fixing an error left in a model the agent built earlier when only an unrelated addition was asked for. Each fix is checked by simulation.',
      sensitivityInterpretation:
        'Reading the results of a one-at-a-time sensitivity sweep: which parameters change the shape of the behavior rather than its size, which way each one moves the outcome, and which matter most and least — against keys computed from the same runs.',
      unitConsistency:
        'Dimensionally consistent models: built from descriptions that state every unit, and repaired where unit errors were planted — checked by a deterministic unit checker whose warnings the agent sees as it works, plus simulation to make sure a fix did not change what the model computes.',
      referenceModes:
        'Defining a problem as behavior over time: from a user\'s plain account, naming the patterns a model must explain (and not the unrelated trend also mentioned), then building a causal loop diagram that contains the loops which, in the hidden simulation behind the account, produce that behavior.',
      sfdFromBoundary:
        'Building a working stock-and-flow model from a problem description, deciding what belongs inside the boundary: mechanisms the hidden simulation shows matter must be in the model, ones that do not (or lie outside the system) left out — and the model must simulate, reproduce the behavior described, be unit-consistent and follow formulation best practice.',
      elicitation:
        'Asking the questions a modeler needs: from a one-line complaint, questioning a scripted user who answers only what is asked, the agent must draw out every mechanism the hidden simulation shows matters, put each into its causal loop diagram and inside its stated boundary, and keep irrelevant facts out.',
      noviceCoaching:
        'Coaching a novice who arrives convinced of a policy that does not work: leading with questions, showing why that policy falls short, and recommending only policies that meet the goal when each candidate is run in the hidden simulation.',
      multiplePerspectives:
        'Keeping every stakeholder\'s view in play: given two conflicting explanations, the agent must keep both (in its diagram or explicitly as alternatives), say they disagree, and propose an experiment that — run in the hidden simulation under each account — would actually tell them apart.',
      cldInterpretation:
        'Reading an existing causal loop diagram correctly: whether each loop is reinforcing or balancing, which way a change in one variable moves another, and how many loops pass through a variable — every answer computed from the diagram itself, including diagrams with invented variable names.',
      formulationCritique:
        'Reviewing formulations for best practice — too many inputs, numbers buried in equations, divisions that can reach zero, hard-coded time switches — explaining what is wrong and fixing it without changing what the model computes, checked by a deterministic linter and by simulation.',
      extremeConditions:
        'Testing a model under extreme inputs with what-if runs, finding the formulation that behaves impossibly there, and fixing it without changing normal behavior — finding read from the agent\'s own runs replayed on the original model, fixing checked by simulation.',
      policyImplementation:
        'Designing a policy with a model: suggesting a change the organization could adopt, implementing it in the model, and meeting a goal the current behavior misses — without touching what management does not control, removing any of the model, or producing impossible behavior.',
      mece:
        'Finding variables that are not mutually exclusive and collectively exhaustive — quantities counted twice because they overlap, totals that leave a part out — explaining them and fixing them so the model behaves like the correct one.',
      cldStocksAndLeverage:
        'Recognizing which quantities accumulate and keeping them in a causal loop diagram, and — given a working model and a goal — recommending the changes that would do the most while avoiding the one a novice wrongly expects to work, graded against hidden simulations.',
      mentalModelVsBug:
        'Telling a bug in the model from a mistaken expectation: when a modeler is surprised by what a model does, fixing the model if it is wrong, and explaining the behavior while leaving the model alone if it is right.',
      archetypes:
        'Recognizing which classic system archetype a situation fits — told in plain words with no archetype named — and drawing a causal loop diagram with the archetype\'s loops and polarities.',
      analysisSetup:
        'Setting up a sensitivity analysis on a working model — sweeping the parameters a measure depends on over sensible ranges while recording that measure — and reporting which parameters matter and which hardly do, against a key from sweeping every parameter.',
      transferability:
        'Telling when a policy that works in a model would not work in practice: flagging the assumptions it rests on that experience contradicts or no evidence supports, without doubting the ones that are well founded.',
      aggregationCritique:
        'Judging whether a model\'s aggregation is good enough for the question it is for — when groups that differ must be split out and when the average will do — against a key from simulating the split model.',
      calibration:
        'Calibrating a model to historical data — fitting its parameters when the structure is right — and recognizing when no parameter values can make it fit, naming the mechanism the model is missing instead of forcing a fit.',
      policyAnalysisMethods:
        'Choosing the analysis a question calls for — a what-if run, a sensitivity analysis, a calibration or an optimization — carrying it out with the model\'s analysis tools, and getting the answer right against the hidden model.',
      causalSources:
        'Grounding a causal loop diagram in uploaded documents: drawing the links they state, citing for each the document it comes from, marking unsupported links as assumptions, and never inventing a source.',
    },
    note:
      'A row is one agent on one model; its label names the agent. Each column is either a regression guard (basic correctness a good agent should always pass) or discriminating (a judgement skill whose hard, held-out tests are built to separate strong agents from weak ones). Every column mixes dev tests, written alongside the grader, with held-out tests written after it was frozen. Merlin and Socrates support both model types and can run every column; Athena’s two personas and Themis each support only one type, so columns that run in the other type do not apply to them. The Evaluations page explains how agent tests are run and graded.',
  },
};

/** The order the boards are presented in, everywhere. */
export const LEADERBOARD_ORDER = ['sfd', 'cld', 'discussion', 'agent'];
