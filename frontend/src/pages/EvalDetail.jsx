import { useParams, Link } from 'react-router-dom';
import evalsData from '../generated/evals.json';
import { groupKindExplanation, ROLE_TEXT } from './evalGuide';

// Calculate prev/next navigation for a specific test.
function calculateNavigation(categories, currentCategory, currentGroup, currentTestName) {
  const empty = { nextTest: null, nextGroup: null, previousTest: null, previousGroup: null };

  const category = categories.find((cat) => cat.name === currentCategory);
  if (!category) return empty;

  const groups = category.groups;
  const groupNames = groups.map((g) => g.name);
  const currentGroupIndex = groupNames.indexOf(currentGroup);
  const currentGroupData = groups.find((g) => g.name === currentGroup);
  if (!currentGroupData) return empty;

  const currentTestIndex = currentGroupData.tests.findIndex((t) => t.name === currentTestName);

  const makeLink = (group, testName) =>
    `/evals/${encodeURIComponent(currentCategory)}/${encodeURIComponent(group)}/${encodeURIComponent(testName)}`;

  let nextTest = null;
  let nextGroup = null;
  let previousTest = null;
  let previousGroup = null;

  if (currentTestIndex >= 0 && currentTestIndex < currentGroupData.tests.length - 1) {
    const t = currentGroupData.tests[currentTestIndex + 1];
    nextTest = { url: makeLink(currentGroup, t.name) };
  }
  if (currentTestIndex > 0) {
    const t = currentGroupData.tests[currentTestIndex - 1];
    previousTest = { url: makeLink(currentGroup, t.name) };
  }
  if (currentGroupIndex >= 0 && currentGroupIndex < groups.length - 1) {
    const g = groups[currentGroupIndex + 1];
    if (g && g.tests.length > 0)
      nextGroup = {
        url: `/evals/${encodeURIComponent(currentCategory)}/${encodeURIComponent(g.name)}/${encodeURIComponent(g.tests[0].name)}`,
      };
  }
  if (currentGroupIndex > 0) {
    const g = groups[currentGroupIndex - 1];
    if (g && g.tests.length > 0) {
      const last = g.tests[g.tests.length - 1];
      previousGroup = {
        url: `/evals/${encodeURIComponent(currentCategory)}/${encodeURIComponent(g.name)}/${encodeURIComponent(last.name)}`,
      };
    }
  }

  return { nextTest, nextGroup, previousTest, previousGroup };
}

// What each input the harness hands the engine is for. The panels below carry this so a
// reader can tell the framing of the task apart from the material the answer must come from,
// which is the distinction that makes these evals reproducible.
const INPUT_NOTES = {
  problemStatement:
    'Passed to the engine as its problemStatement parameter: what the user is trying to accomplish. It frames the task but is not itself the request.',
  backgroundKnowledge:
    'Passed as backgroundKnowledge: the material the answer has to be drawn from. Where a category generates its ground truth synthetically, this text and the ground truth are produced together from one specification, so they cannot disagree.',
  prompt: 'The request itself, exactly as the engine receives it.',
  currentModel:
    'An existing model handed to the engine as currentModel. Tests that supply one are asking the engine to extend, repair, restructure or discuss a model rather than build one from nothing. Where the criteria above include preserving what was already there, this is what the answer is compared against.',
  feedbackContent:
    'A precomputed feedback-loop dominance analysis, passed as feedbackContent. It supplies the loop information a discussion of dynamics depends on, so the task is to interpret that analysis rather than to derive it.',
};

const OTHER_PARAM_NOTES = {
  mainTopics: 'Topic hint passed through to engines that accept one.',
  depth: 'Depth hint passed through to engines that accept one.',
  supportsArrays: 'Tells the engine that array (subscripted) structure is permitted in the answer.',
  supportsModules: 'Tells the engine that modules are permitted in the answer.',
  mode: 'The kind of model the agent works in for this test (cld or sfd), overriding the experiment\'s default — a test that asks for a causal loop diagram runs its agent in a CLD session.',
  attachments:
    'Files attached to the agent\'s session as if the user had uploaded them. They go through the same document pipeline as a real upload, so the agent has to find and read them with its document tools; the tests check its tool log to see that it did.',
  turns:
    'Fixed follow-up messages. After the agent answers the prompt, each of these is sent to it in order, as the user\'s next turn, and the agent answers each in the same session.',
  userScript:
    'A scripted user. It holds a fixed bank of facts, each filed under a topic. After every agent turn a judge reads only the agent\'s message and the topic list and decides which topics were specifically asked about; the user replies with those facts (at most maxFactsPerTurn per turn), or with the fixed unknownReply when nothing matches. It stops after maxQuestionTurns rounds, or as soon as the agent asks nothing, then sends closingMessage if there is one. Every released fact is recorded on the transcript.',
  analysisTools:
    'Gives the agent the eval analysis tools: run_scenario (what-if runs), run_sensitivity (one-at-a-time sweeps), load_calibration_data and run_calibration (fitting parameters to history) and run_optimization (searching one lever). Every call lands in the tool log, so graders can check what the agent actually ran.',
  unitChecking:
    'Turns on the deterministic unit checker: every time the model is echoed back to the agent it carries the checker\'s unit warnings, the way Stella reports its own unit check.',
  calibrationData:
    'The historical data that load_calibration_data returns to the agent, and that run_calibration fits against.',
};

// The panels rendered above verbatim; everything else in additionalParameters is listed
// compactly, so the page never implies the engine got less than it did.
const NAMED_PARAMS = ['problemStatement', 'backgroundKnowledge', 'feedbackContent'];

function Panel({ tone, title, note, children }) {
  const tones = {
    blue: 'bg-blue-50 border-blue-200 text-blue-900',
    green: 'bg-green-50 border-green-200 text-green-900',
    purple: 'bg-purple-50 border-purple-200 text-purple-900',
    amber: 'bg-amber-50 border-amber-200 text-amber-900',
    gray: 'bg-gray-50 border-gray-200 text-gray-900',
  };
  return (
    <div className={`border rounded-lg p-4 ${tones[tone]}`}>
      <h3 className="font-semibold mb-1">{title}</h3>
      {note && <p className="text-xs opacity-80 mb-3 leading-relaxed max-w-3xl">{note}</p>}
      {children}
    </div>
  );
}

function JsonBlock({ value }) {
  return (
    <pre className="w-full text-gray-800 text-xs font-mono bg-white border border-gray-200 rounded p-3 whitespace-pre-wrap overflow-x-auto max-h-96 overflow-y-auto">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

// Big inputs (a whole model, a whole feedback analysis) are folded away rather than dropped:
// they are part of what the engine was given, so the page has to be able to show them.
function CollapsibleJson({ label, value }) {
  return (
    <details className="group">
      <summary className="cursor-pointer text-sm font-medium hover:underline">{label}</summary>
      <div className="mt-3">
        <JsonBlock value={value} />
      </div>
    </details>
  );
}

function EvalDetail() {
  const { category, group, testname } = useParams();
  const decodedCategory = decodeURIComponent(category);
  const decodedGroup = decodeURIComponent(group);
  const decodedTestName = decodeURIComponent(testname);

  const categories = evalsData.categories || [];
  const categoryData = categories.find((c) => c.name === decodedCategory);
  const groupData = categoryData?.groups.find((g) => g.name === decodedGroup);
  const test = groupData?.tests.find((t) => t.name === decodedTestName);

  const navigation = calculateNavigation(categories, decodedCategory, decodedGroup, decodedTestName);

  const methodology = categoryData?.methodology;
  const totalTests = (categoryData?.groups || []).reduce((n, g) => n + g.tests.length, 0);

  const additionalParameters = test?.additionalParameters || {};
  const problemStatement = additionalParameters.problemStatement || '';
  const backgroundKnowledge = additionalParameters.backgroundKnowledge || '';
  const feedbackContent = additionalParameters.feedbackContent;
  const otherParameters = Object.entries(additionalParameters).filter(
    ([key, value]) => !NAMED_PARAMS.includes(key) && value !== undefined && value !== null && value !== ''
  );
  const prompt = test?.prompt || '';
  const currentModel = test?.currentModel;
  const jsonExpectations = test?.expectations ? JSON.stringify(test.expectations, null, 2) : '';

  return (
    <div className="eval-detail-page">
      {/* Sticky Navigation Header */}
      <div className="sticky top-0 z-10 bg-white border-b border-gray-200 shadow-sm mb-6">
        <div className="p-4">
          <div className="flex flex-col space-y-3 mb-4 md:flex-row md:items-center md:justify-between md:space-y-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm md:text-lg">
              <span className="text-gray-500">Category:</span>
              <span className="font-medium text-gray-800">{decodedCategory}</span>
              <span className="text-gray-400">›</span>
              <span className="text-gray-500">Group:</span>
              <span className="font-medium text-gray-800">{decodedGroup}</span>
              <span className="text-gray-400">›</span>
              <span className="text-gray-500">Test:</span>
              <span className="font-semibold text-blue-600">{decodedTestName}</span>
            </div>

            <Link
              to="/evals"
              className="text-sm text-gray-600 hover:text-blue-600 underline flex-shrink-0"
            >
              ← Back to All Evaluations
            </Link>
          </div>

          {(navigation.nextTest || navigation.nextGroup || navigation.previousTest || navigation.previousGroup) && (
            <div className="border-t border-gray-200 pt-4">
              <div className="flex flex-col space-y-3 md:flex-row md:items-center md:justify-between md:space-y-0">
                <div className="flex flex-wrap gap-2">
                  {navigation.previousGroup && (
                    <Link
                      to={navigation.previousGroup.url}
                      className="inline-flex items-center px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700 text-sm font-medium"
                    >
                      <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 17l-5-5m0 0l5-5m-5 5h12" />
                      </svg>
                      Previous Group
                    </Link>
                  )}
                  {navigation.previousTest && (
                    <Link
                      to={navigation.previousTest.url}
                      className="inline-flex items-center px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700 text-sm"
                    >
                      <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                      </svg>
                      Previous Test
                    </Link>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  {navigation.nextTest && (
                    <Link
                      to={navigation.nextTest.url}
                      className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm"
                    >
                      Next Test
                      <svg className="w-4 h-4 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </Link>
                  )}
                  {navigation.nextGroup && (
                    <Link
                      to={navigation.nextGroup.url}
                      className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm font-medium"
                    >
                      Next Group
                      <svg className="w-4 h-4 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                      </svg>
                    </Link>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="p-5">
        {!test ? (
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 mb-6">
            <strong>Not found:</strong> no test "{decodedTestName}" in {decodedCategory} ›{' '}
            {decodedGroup}.
          </div>
        ) : (
          <>
            {/* What this evaluation measures — the category's own description, in full. */}
            <section className="mb-10">
              <h2 className="text-xl sm:text-2xl font-bold text-gray-800 mb-1">{decodedCategory}</h2>
              <p className="text-xs text-gray-500 mb-4">
                {totalTests} test{totalTests === 1 ? '' : 's'} in{' '}
                {categoryData.groups.length} group
                {categoryData.groups.length === 1 ? '' : 's'} · this test is one of{' '}
                {groupData.tests.length} in <span className="font-medium">{decodedGroup}</span>.
                Groups bucket a category's tests by kind or by difficulty; every test in a
                category is graded by the same criteria.
              </p>
              {categoryData.role && (
                <div className="mb-4 max-w-4xl space-y-2">
                  <p className="text-sm text-gray-700 leading-relaxed">
                    <span className={`text-xs font-medium border rounded px-2 py-0.5 mr-2 ${ROLE_TEXT[categoryData.role.kind].tone}`}>
                      {ROLE_TEXT[categoryData.role.kind].label}
                    </span>
                    {categoryData.role.reason} {ROLE_TEXT[categoryData.role.kind].short}
                  </p>
                  <p className="text-sm text-gray-700 leading-relaxed">
                    <span className="font-semibold">This group ({decodedGroup}):</span> {groupKindExplanation(decodedGroup)}
                  </p>
                  <p className="text-sm text-gray-700 leading-relaxed">
                    This is an agent eval: the agent works through a whole session and is graded on what it actually did.{' '}
                    <Link to="/evals/agents" className="text-blue-600 hover:underline">
                      How the agent evals work →
                    </Link>
                  </p>
                </div>
              )}
              {categoryData.description && (
                <p className="text-sm text-gray-700 leading-relaxed max-w-4xl">
                  {categoryData.description}
                </p>
              )}
              <div className="flex flex-wrap gap-2 mt-4">
                {categoryData.link && (
                  <a
                    href={categoryData.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="bg-gray-100 hover:bg-gray-200 text-gray-700 hover:text-gray-900 px-3 py-2 rounded text-sm font-medium no-underline"
                  >
                    Learn More
                  </a>
                )}
                {categoryData.source && (
                  <a
                    href={categoryData.source}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="bg-gray-100 hover:bg-gray-200 text-gray-700 hover:text-gray-900 px-3 py-2 rounded text-sm font-medium no-underline"
                  >
                    View Source
                  </a>
                )}
              </div>
            </section>

            {methodology?.howItWorks?.length > 0 && (
              <section className="mb-10">
                <h2 className="text-lg font-bold text-gray-800 mb-3">How this evaluation works</h2>
                <div className="max-w-4xl space-y-3">
                  {methodology.howItWorks.map((paragraph, i) => (
                    <p key={i} className="text-sm text-gray-700 leading-relaxed">
                      {paragraph}
                    </p>
                  ))}
                </div>
              </section>
            )}

            {methodology?.criteria?.length > 0 && (
              <section className="mb-10">
                <h2 className="text-lg font-bold text-gray-800 mb-3">
                  How this test is graded
                </h2>
                <div className="max-w-4xl space-y-3 mb-5">
                  {/* True of every eval in the suite: run.js records pass when the evaluator
                      returns no failures at all. Stated here so each criterion below reads as a
                      condition that must hold, not as a point to be scored. */}
                  <p className="text-sm text-gray-700 leading-relaxed">
                    Grading is pass/fail and admits no partial credit. The category's{' '}
                    <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">evaluate</code>{' '}
                    function compares what the engine returned against this test's expectations and
                    returns a list of failures; the test passes only if that list is empty. Every
                    criterion below is therefore a condition that has to hold, and a single
                    violation of any one of them fails the test.
                  </p>
                  {methodology.scoring && (
                    <p className="text-sm text-gray-700 leading-relaxed">{methodology.scoring}</p>
                  )}
                </div>

                <h3 className="text-sm font-semibold text-gray-700 mb-2">
                  Criteria applied to the response
                </h3>
                <p className="text-xs text-gray-500 mb-3 max-w-4xl leading-relaxed">
                  Each criterion is named by the failure the evaluator records when it does not
                  hold, so a failure in a results file or on a leaderboard can be carried straight
                  back to the rule that produced it. A criterion that depends on something this
                  test's expectations do not specify does not apply to this test.
                </p>
                <div className="border border-gray-200 rounded-lg divide-y divide-gray-200 overflow-hidden">
                  {methodology.criteria.map((criterion, i) => (
                    <div key={i} className="p-4 bg-white">
                      <code className="text-xs font-semibold text-red-800 bg-red-50 border border-red-100 px-2 py-0.5 rounded">
                        {criterion.name}
                      </code>
                      <p className="text-sm text-gray-700 mt-2 leading-relaxed">
                        {criterion.description}
                      </p>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* This particular test: exactly what the engine is handed. */}
            <section className="mb-10">
              <h2 className="text-lg font-bold text-gray-800 mb-1">
                What this test gives the engine
              </h2>
              <p className="text-xs text-gray-500 mb-4 max-w-4xl leading-relaxed">
                Everything below is passed to the engine under test, and nothing else is. The
                expectations that follow are never shown to it.
              </p>

              <div className="grid gap-6">
                {problemStatement && (
                  <Panel tone="blue" title="Problem Statement" note={INPUT_NOTES.problemStatement}>
                    <div className="text-blue-800 text-sm whitespace-pre-wrap leading-relaxed">
                      {problemStatement}
                    </div>
                  </Panel>
                )}

                {backgroundKnowledge && (
                  <Panel
                    tone="green"
                    title="Background Knowledge"
                    note={INPUT_NOTES.backgroundKnowledge}
                  >
                    <div className="text-green-800 text-sm whitespace-pre-wrap leading-relaxed">
                      {backgroundKnowledge}
                    </div>
                  </Panel>
                )}

                {prompt && (
                  <Panel tone="purple" title="Prompt" note={INPUT_NOTES.prompt}>
                    <div className="text-purple-800 text-sm whitespace-pre-wrap leading-relaxed">
                      {prompt}
                    </div>
                  </Panel>
                )}

                {currentModel && (
                  <Panel tone="amber" title="Current Model" note={INPUT_NOTES.currentModel}>
                    <div className="text-amber-900">
                      <CollapsibleJson
                        label={`Show the model handed to the engine (${(currentModel.variables || []).length} variables, ${(currentModel.relationships || []).length} relationships)`}
                        value={currentModel}
                      />
                    </div>
                  </Panel>
                )}

                {feedbackContent && (
                  <Panel
                    tone="amber"
                    title="Feedback Analysis"
                    note={INPUT_NOTES.feedbackContent}
                  >
                    <div className="text-amber-900">
                      <CollapsibleJson label="Show the feedback analysis" value={feedbackContent} />
                    </div>
                  </Panel>
                )}

                {otherParameters.length > 0 && (
                  <Panel
                    tone="gray"
                    title="Other Parameters"
                    note="Further values the harness passes through to the engine alongside the request."
                  >
                    <dl className="text-sm text-gray-700 space-y-2">
                      {otherParameters.map(([key, value]) => (
                        <div key={key}>
                          <dt className="inline">
                            <code className="text-xs font-semibold text-gray-800">{key}</code>
                            <span className="text-gray-500"> = </span>
                            {typeof value === 'object' ? null : (
                              <code className="text-xs text-gray-700">{String(value)}</code>
                            )}
                          </dt>
                          {typeof value === 'object' && (
                            <dd className="mt-1">
                              <CollapsibleJson label={`Show ${key}`} value={value} />
                            </dd>
                          )}
                          {OTHER_PARAM_NOTES[key] && (
                            <dd className="text-xs text-gray-500 leading-relaxed">
                              {OTHER_PARAM_NOTES[key]}
                            </dd>
                          )}
                        </div>
                      ))}
                    </dl>
                  </Panel>
                )}
              </div>
            </section>

            {jsonExpectations && jsonExpectations !== '{}' && jsonExpectations !== '[]' && (
              <section className="mb-6">
                <h2 className="text-lg font-bold text-gray-800 mb-1">
                  Expectations for this test
                </h2>
                <p className="text-xs text-gray-500 mb-4 max-w-4xl leading-relaxed">
                  This test's ground truth, handed verbatim to the category's{' '}
                  <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">evaluate</code>{' '}
                  function once the engine has answered, and never shown to the engine itself.
                  This is what the criteria above are applied against, and for the categories
                  whose checks are driven by the expectations it is also what decides which of
                  them apply.
                </p>
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                  <pre className="w-full text-gray-800 text-sm font-mono bg-transparent whitespace-pre-wrap overflow-x-auto">
                    {jsonExpectations}
                  </pre>
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default EvalDetail;
