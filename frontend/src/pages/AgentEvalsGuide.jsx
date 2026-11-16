import { Link } from 'react-router-dom';
import evalsData from '../generated/evals.json';
import { leaderboardConfig } from './leaderboardMeta';
import { ROLE_TEXT } from './evalGuide';

// The hidden scenarios behind most agent categories (evals/utilities/scenarios). Listed here so a
// reader can see what "held out" refers to; the scenario files themselves are the source of truth.
const SCENARIOS = [
  { title: 'Rural dialysis network', split: 'dev', structure: 'capacity ordered against a waiting list, with a nine-month build delay' },
  { title: 'City bike-share membership', split: 'dev', structure: 'word-of-mouth adoption that saturates a fixed market' },
  { title: 'Regional distributor inventory', split: 'dev', structure: 'stock management that ignores the supply line, so inventory oscillates' },
  { title: 'Coffee-growing cooperative', split: 'held out', structure: 'overshoot and collapse of soil fertility' },
  { title: 'Kitchen fitting backlog', split: 'held out', structure: 'rework caused by rushing' },
  { title: 'Regional specialty mushroom growers', split: 'held out', structure: 'a commodity cycle driven by construction delays' },
  { title: 'Regional ambulance service', split: 'held out', structure: 'a response-time target that drifts toward performance' },
  { title: 'Parcel delivery van fleet', split: 'held out', structure: 'a fleet with co-flowing mileage' },
  { title: 'Community food bank volunteers', split: 'held out', structure: 'volunteer recruitment and fatigue (an original structure)' },
  { title: "Regional electricians' guild", split: 'held out (batch 2)', structure: 'an apprentice → journeyman → master chain capped by masters' },
  { title: 'Hospital contract cleaning standard', split: 'held out (batch 2)', structure: 'an inspection standard that erodes' },
  { title: 'Valley groundwater board', split: 'held out (batch 2)', structure: 'a town and orchards competing for one aquifer' },
];

// Results of the final smoke runs. Every figure is one agent (Merlin)
// on one configuration (Sonnet 5.5 agent, Haiku 5.5 tools), pooled over every reading.
const RESULTS = [
  ['elicitation', '0.00', 8, 'meets'],
  ['archetypes', '0.17', 3, 'meets'],
  ['noviceCoaching', '0.25', 6, 'meets'],
  ['calibration', '0.25', 6, 'meets'],
  ['multiplePerspectives', '0.44', 9, 'meets'],
  ['aggregationCritique', '0.57', 7, 'meets'],
  ['mentalModelVsBug', '0.63', 5, 'meets'],
  ['transferability', '0.63', 4, 'meets'],
  ['sfdFromBoundary', '0.75', 4, 'does not meet'],
  ['referenceModes', '0.85', 7, 'borderline'],
  ['analysisSetup', '0.87', 10, 'borderline'],
  ['cldStocksAndLeverage', '0.88', 8, 'does not meet'],
  ['policyImplementation', '0.95', 10, 'does not meet'],
  ['policyAnalysisMethods', '0.98', 14, 'does not meet'],
];

function Section({ id, title, children }) {
  return (
    <section id={id} className="mb-12 scroll-mt-4">
      <h2 className="text-xl font-bold text-gray-800 mb-4">{title}</h2>
      <div className="space-y-3 text-sm text-gray-700 leading-relaxed max-w-4xl">{children}</div>
    </section>
  );
}

function Term({ children }) {
  return <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">{children}</code>;
}

const categoryLink = (name) => {
  const c = (evalsData.categories || []).find((x) => x.name === name);
  return c?.firstTestUrl ? (
    <Link to={c.firstTestUrl} className="text-blue-600 hover:underline">
      {name}
    </Link>
  ) : (
    name
  );
};

function AgentEvalsGuide() {
  const agentCategories = (evalsData.categories || []).filter((c) => c.role);
  const guards = agentCategories.filter((c) => c.role.kind === 'regression guard');
  const disc = agentCategories.filter((c) => c.role.kind === 'discriminating');

  return (
    <div className="p-5">
      <Link to="/evals" className="text-sm text-gray-600 hover:text-blue-600 underline">
        ← All evaluation categories
      </Link>
      <h1 className="text-2xl sm:text-3xl font-bold text-gray-800 mt-6 mb-2">How the agent evals work</h1>
      <p className="text-base text-gray-600 max-w-4xl mb-6">
        The agent evals are {agentCategories.length} categories that test an AI agent doing a modeler’s job over a
        working session: building and repairing models, running them, reading uploaded files, asking a client
        questions, coaching a novice. This page explains how a test is set up, how it is graded, what the group
        names mean and how to read the scores.
      </p>
      <nav className="mb-10 text-sm max-w-4xl bg-gray-50 border border-gray-200 rounded-lg p-4">
        <span className="font-semibold text-gray-700 mr-2">On this page:</span>
        {[
          ['difference', 'Agent evals vs engine evals'],
          ['session', 'How a test is run'],
          ['scenarios', 'Hidden scenarios'],
          ['grading', 'How tests are graded'],
          ['groups', 'Group names: dev, held out, hard'],
          ['roles', 'Category roles'],
          ['floors', 'Floors and constant answers'],
          ['results', 'Current results'],
          ['limits', 'Known limits'],
        ].map(([id, label], i) => (
          <span key={id}>
            {i > 0 && <span className="text-gray-400 mx-1">·</span>}
            <a href={`#${id}`} className="text-blue-600 hover:underline" onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); }}>
              {label}
            </a>
          </span>
        ))}
      </nav>

      <Section id="difference" title="Agent evals vs engine evals">
        <p>
          The older categories on the Stock &amp; Flow, Causal Loop Diagram and Discussion boards test an{' '}
          <strong>engine</strong>: one request goes in, one model or one answer comes out, and that output is graded.
        </p>
        <p>
          The agent categories test an <strong>agent</strong> (Merlin, Athena, Socrates or Themis) running inside a full
          session, the same way it runs for a real user. During a test the agent can read and edit the model, run it in a
          simulator, call analysis tools, search uploaded documents and, in some categories, talk with a scripted user over
          several turns. Grading looks at what the agent actually did, not at what it says it did. It reads:
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li>the model the agent left in the session at the end;</li>
          <li>the text the agent wrote to the user;</li>
          <li>
            the <strong>tool log</strong>: every tool call in order, with its arguments, for example every what-if run, every
            document search and every model update;
          </li>
          <li>
            for conversations, the full <strong>transcript</strong>, turn by turn, with a snapshot of the model after each
            agent turn.
          </li>
        </ul>
        <p>
          The agent categories are scored on the <Link to="/leaderboard/agent" className="text-blue-600 hover:underline">Agents leaderboard</Link>.
        </p>
      </Section>

      <Section id="session" title="How a test is run">
        <p>
          Every test is run by <Term>agent/utilities/AgentEvalRunner.js</Term>, through one of three harness engines:{' '}
          <Term>test-agent-build</Term> (the agent must leave a model), <Term>test-agent-discuss</Term> (an answer in
          text is enough) and <Term>test-agent-converse</Term> (a multi-turn conversation). The runner creates a fresh
          session, loads the agent’s configuration and gives it the test’s inputs:
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li><strong>prompt</strong>: the user’s request, exactly as the agent receives it.</li>
          <li><strong>currentModel</strong>: an existing model, when the task is to repair, extend, analyse or discuss one.</li>
          <li><strong>mode</strong>: whether the session is a causal loop diagram (<Term>cld</Term>) or a stock-and-flow model (<Term>sfd</Term>), and whether it is a discussion (<Term>-discuss</Term>).</li>
          <li><strong>problemStatement</strong>: what the user is trying to accomplish, which frames the task.</li>
        </ul>
        <p>Depending on the test, the session can also have:</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <strong>Uploaded files</strong> (<Term>attachments</Term>). They go through the same upload pipeline as a
            real user’s file, so the agent has to find them with its document tools. Tests check the tool log to confirm
            the file was actually read.
          </li>
          <li>
            <strong>Analysis tools</strong> (<Term>analysisTools</Term>): <Term>run_scenario</Term> for what-if runs,{' '}
            <Term>run_sensitivity</Term> for one-at-a-time sweeps, <Term>load_calibration_data</Term> and{' '}
            <Term>run_calibration</Term> for fitting parameters to history, and <Term>run_optimization</Term> for
            searching one lever. They run the agent’s current model in PySD.
          </li>
          <li>
            <strong>Unit checking</strong> (<Term>unitChecking</Term>). A deterministic dimensional-analysis checker
            reports unit warnings to the agent every time the model is echoed back, the way Stella does.
          </li>
          <li>
            <strong>Fixed follow-up turns</strong> (<Term>turns</Term>), for example “now build the diagram”, or a{' '}
            <strong>scripted user</strong> (<Term>userScript</Term>).
          </li>
        </ul>
        <p>
          <strong>The scripted user</strong> holds a fixed bank of facts, each a pre-written sentence filed under a topic.
          After each agent turn, a judge model reads only the agent’s message and the list of topics, and decides which
          topics the agent specifically asked about. The user then replies with those facts, at most a set number per
          turn. A question about anything else gets a fixed “I don’t know” reply, and a catch-all request such as “tell me
          everything” asks about no topic, so the bank cannot be emptied in one go. The judge’s decisions are cached by the
          agent’s exact text, so the same question always gets the same answer. Every released fact is recorded on the
          transcript, so the grader knows exactly what the agent learned and when.
        </p>
        <p>
          <strong>Eval mode.</strong> When no user is present, the agent is told not to stop and wait for input. In a
          conversation it is told instead that a user will reply, so it is free to ask. If a build test ends without the
          agent ever writing a model, the harness sends one fixed correction (“your answer never reached the model”) and
          grades what follows. This nudge is tagged on the transcript, so graders never count it as the user speaking.
        </p>
        <p>
          <strong>Simulation.</strong> All simulation, by the agent’s tools and by the graders, goes through PySD via{' '}
          <Term>evals/utilities/simulator/PySDSimulator.js</Term>. That wrapper works around known PySD gaps without
          changing PySD:
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li>It writes the builtin PI as its value.</li>
          <li>It runs Runge-Kutta models with Euler at a finer step.</li>
          <li>It flattens modules.</li>
          <li>It resamples lookups whose x points are unevenly spaced onto an even grid, which PySD needs.</li>
        </ul>
      </Section>

      <Section id="scenarios" title="Hidden scenarios">
        <p>
          Most agent categories are built on <strong>hidden scenarios</strong> (<Term>evals/utilities/scenarios/</Term>). A
          scenario is a small, working simulation model of an ordinary situation, which the agent never sees, together with
          what a user would say about it. It contains:
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li>a plain-language account and history, with no modeling vocabulary;</li>
          <li>the key quantities and the shape each follows over time;</li>
          <li>an unrelated distractor trend;</li>
          <li>
            the causal mechanisms, each with a switch that removes it from the model. <strong>Ablation</strong>, running
            the model with one mechanism off, decides whether that mechanism matters. It matters if switching it off changes
            a key quantity’s shape, or moves a peak or final value by 25% or more. It does not matter if everything moves
            by less than 10%. Anything in between is ambiguous and is never asked about;
          </li>
          <li>
            a goal, and candidate policies that each meet it or miss it in the hidden simulation, by a margin checked in
            the unit tests;
          </li>
          <li>
            for some, two stakeholders’ conflicting accounts, each with a variant of the model in which the world works
            their way, plus candidate experiments that do or do not tell the two variants apart.
          </li>
        </ul>
        <p>
          Because every answer key comes from simulating the hidden model, a test cannot reward a merely plausible answer.
          The policy has to work, the mechanism has to matter, and the experiment has to separate the accounts. The twelve
          scenarios are:
        </p>
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-gray-600">
              <tr>
                <th className="p-2">Scenario</th>
                <th className="p-2">Split</th>
                <th className="p-2">Structure</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {SCENARIOS.map((s) => (
                <tr key={s.title}>
                  <td className="p-2 font-medium text-gray-800">{s.title}</td>
                  <td className="p-2 whitespace-nowrap">{s.split}</td>
                  <td className="p-2">{s.structure}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          The categories that are not built on scenarios use other fixed material:
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li>small hand-written models with planted errors (guidedCorrection, mece, formulationCritique, extremeConditions, mentalModelVsBug, unitConsistency, equilibrium);</li>
          <li>seeded causal loop diagrams with invented (“gibberish”) variable names, so nothing can be answered from memory (modelToCLD, cldInterpretation);</li>
          <li>sets of short documents (causalSources).</li>
        </ul>
      </Section>

      <Section id="grading" title="How tests are graded">
        <p>
          <strong>Pass or fail, one criterion per test.</strong> A test passes only if its category’s{' '}
          <Term>evaluate</Term> function returns no failures. A category’s score is the share of its tests that pass.
          Each test checks one thing, for example “draws out mechanism X”, “the diagram contains loop Y” or “the fixed
          model behaves like the correct one”. One agent session therefore gives a separate pass or fail for each thing
          it had to get right.
        </p>
        <p>
          <strong>Sibling tests share one generation.</strong> Tests with the same prompt, model and parameters are
          answered by a single agent session, and all of them grade it. A category of 100 tests may rest on 20
          sessions. The number that matters for confidence is the number of distinct sessions (“generations”), not the
          number of tests.
        </p>
        <p>
          <strong>Deterministic checks wherever possible.</strong> Most criteria are decided by code:
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li>simulating the returned model and comparing it with the correct model or the goal;</li>
          <li>diffing the model against what was handed over, so a change outside what was permitted fails;</li>
          <li>the unit checker and the formulation linter;</li>
          <li>graph analysis of a causal loop diagram: loops, polarities, and causal paths with their signs;</li>
          <li>the tool log, for example whether the agent ran the model after its last change.</li>
        </ul>
        <p>
          A planted error is graded <strong>on its own</strong>. The agent’s version of only the variable the error lives in
          is put back into the correct model. If that hybrid simulates like the correct model, the error is fixed,
          whatever else the agent changed.
        </p>
        <p>
          <strong>A judge reads text, but never grades it.</strong> Where a criterion depends on what the agent said, a
          fixed judge model reports only what the text says, choosing from a closed list of options. For example: which of
          these numbered problems did the review identify? Which policy does the advice recommend? The judge is never
          shown the answer key, and the lists mix real items with distractors, so the judge is never handed only true
          things to tick off. The category’s code then compares the judge’s reading with the key. A judge call that fails
          is retried; one that still fails is recorded as a failure, so a broken judge never reads as a good answer.
        </p>
      </Section>

      <Section id="groups" title="Group names: dev, held out, hard">
        <p>Every agent category’s tests are split into groups by two rules, and the group name tells you which:</p>
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-gray-600">
              <tr>
                <th className="p-2">Group name</th>
                <th className="p-2">What it holds</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              <tr><td className="p-2"><Term>elicitation</Term></td><td className="p-2">Ordinary tests on <strong>dev</strong> material, which the grader was developed and checked against.</td></tr>
              <tr><td className="p-2"><Term>elicitationHeldOut</Term></td><td className="p-2">Ordinary tests on <strong>held-out</strong> material, written after the grader was frozen and never used to tune it.</td></tr>
              <tr><td className="p-2"><Term>elicitationHard</Term></td><td className="p-2">Hard tests on dev material: the same task with a difficulty lever applied by rule.</td></tr>
              <tr><td className="p-2"><Term>elicitationHardHeldOut</Term></td><td className="p-2">Hard tests on held-out material. For a discriminating category, this is the group that decides whether the category leaves headroom.</td></tr>
              <tr><td className="p-2"><Term>…Hard2HeldOut</Term></td><td className="p-2">A second hard rule added in Phase 3, where the first hard group was still too easy. Held-out material only.</td></tr>
            </tbody>
          </table>
        </div>
        <p>
          <strong>Why held out matters.</strong> A grader tuned while looking at a set of cases tends to fit those cases. A
          held-out case was written by an author who could not see the graders, after the grader was frozen. If a grader
          had to change after a held-out case was run, that case would move to dev. The gap between the dev and held-out scores is therefore a direct
          measure of overfitting.
        </p>
        <p>
          <strong>How hard cases are made.</strong> Difficulty levers are applied by rule to every eligible case, never by
          picking the cases an agent failed. The levers include:
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li>no hint about the method or the kind of problem;</li>
          <li>several faults of different kinds, plus a clean model where the right answer is “nothing is wrong”;</li>
          <li>feedback withheld, for example unit checking off or a tighter question budget;</li>
          <li>exact numbers graded instead of shapes;</li>
          <li>answers balanced so that “yes” is wrong about half the time.</li>
        </ul>
        <p>
          <strong>Clean controls</strong> are hard cases where the model is already correct. An agent that “fixes” a correct
          model fails them.
        </p>
      </Section>

      <Section id="roles" title="Category roles">
        <p>
          Each agent category has one of two roles. The role is decided by the <em>kind of task</em>, not by how it
          scores, and is stated on every test page.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          {[['regression guard', guards], ['discriminating', disc]].map(([kind, list]) => (
            <div key={kind} className={`border rounded-lg p-4 ${ROLE_TEXT[kind].tone}`}>
              <h3 className="font-semibold mb-1">{ROLE_TEXT[kind].label} ({list.length})</h3>
              <p className="text-xs mb-3">{ROLE_TEXT[kind].short}</p>
              <ul className="text-xs space-y-1">
                {list.map((c) => (
                  <li key={c.name}>
                    <span className="font-medium">{categoryLink(c.name)}</span>: {c.role.reason}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p>
          A <strong>regression guard</strong> is expected to score high. It still needs enough cases, and enough of them
          held out, that a real drop would show. A <strong>discriminating</strong> category’s ordinary groups may also
          score high; its hard held-out group is what has to leave headroom.
        </p>
      </Section>

      <Section id="floors" title="Floors and constant answers">
        <p>
          A score means little without knowing what doing nothing would score. Three{' '}
          <strong>null agents</strong> are run through every agent category’s grader by{' '}
          <Term>evals/floors/buildFloors.js</Term>, which stores their scores in <Term>floors.json</Term>; the unit tests check that file:
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li>one that returns nothing;</li>
          <li>one that hands the model back unchanged and is read as answering every question in the most assertive way;</li>
          <li>one read as answering in the most noncommittal way.</li>
        </ul>
        <p>
          Their scores, the <strong>floors</strong>, are stated in each category’s “How this evaluation works” section.
          They are 0% for most categories. Tests that a do-nothing agent could pass, such as “keeps the irrelevant fact
          outside the boundary”, only count once the paired positive test passes.
        </p>
        <p>
          A <strong>contract test</strong> also checks every closed-answer field of every judge question. An agent that
          gives the same answer every time must not pass more than half of the held-out tests that read that field. A few groups
          frozen before this check existed fail it, and are recorded in{' '}
          <Term>tests/evals/fixtures/closedFieldBaseline.json</Term>. Their scores should be read beside the
          constant-answer rate, not against zero. The most important case is cldStocksAndLeverage’s{' '}
          <Term>leverageHeldOut</Term> group: an agent that hedges every answer passes it, so its score is not
          interpretable. <Term>leverageHard2HeldOut</Term> is the clean measurement of that skill.
        </p>
      </Section>

      <Section id="results" title="Current results">
        <p>
          These are smoke-run results: <strong>one agent (Merlin) on one configuration</strong>, Sonnet 5.5 for the agent
          and Haiku 5.5 for its tools, pooled over every reading each test got. They show whether the evals measure
          something. They do not rank agents or providers.
        </p>
        <p>
          The table gives each discriminating category’s pass rate on its held-out hard groups, pooled. “g” is the number of
          distinct sessions behind it. The target is 0.70 or lower on at least 3 sessions, so that a better agent has room
          to score higher. <strong>8 of 14 meet it.</strong>
        </p>
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-gray-600">
              <tr>
                <th className="p-2">Discriminating category</th>
                <th className="p-2">Held-out hard pass rate</th>
                <th className="p-2">Sessions</th>
                <th className="p-2">Headroom target</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {RESULTS.map(([name, rate, g, verdict]) => (
                <tr key={name}>
                  <td className="p-2">{categoryLink(name)}</td>
                  <td className="p-2">{rate}</td>
                  <td className="p-2">{g}</td>
                  <td className={`p-2 ${verdict === 'meets' ? 'text-green-700' : verdict === 'borderline' ? 'text-amber-700' : 'text-red-700'}`}>{verdict}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          <strong>Borderline:</strong> referenceModes and analysisSetup meet the target only on their second hard group taken
          alone, at the minimum size or exactly at 0.70.
        </p>
        <p><strong>Other findings from these runs:</strong></p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            Held-out scores are within 0.10 of dev scores in most categories, so the graders are mostly not overfitted. The
            largest gaps, all traced to the agent’s own misses, are aggregationCritique (0.22), extremeConditions (0.19),
            elicitation (0.18), noviceCoaching (0.16) and referenceModes (0.15).
          </li>
          <li>The agent changed a correct model in 5 of the dev clean controls. Every held-out clean control passed.</li>
          <li>
            Single runs are noisy: the same cases moved by up to 0.39 between two readings. Read any one run of a small
            group as ±0.1–0.3.
          </li>
        </ul>
      </Section>

      <Section id="limits" title="Known limits">
        <ul className="list-disc pl-5 space-y-2">
          <li>Every reported number comes from one agent on one configuration. Nothing here ranks agents or providers yet.</li>
          <li>Several hard groups rest on 3 to 6 sessions. That is enough to show headroom, not enough for fine comparisons.</li>
          <li>PySD ignores <Term>type=&quot;extrapolate&quot;</Term> on lookups and holds them at their end values. sd-ai’s own XMILE converter never writes that setting, so only files saved from Stella are affected.</li>
          <li>The sign analysis cannot sign a term through ZIDZ, XIDZ or MAX(0,·). Mechanism checks that would need it are skipped by rule.</li>
          <li>
            Not every agent fits every category. Athena’s CLD and SFD personas and Themis support only one model type
            each, so a category that runs in the other mode does not apply to them.
          </li>
        </ul>
        <p className="pt-2">
          See also the <Link to="/leaderboard/agent" className="text-blue-600 hover:underline">{leaderboardConfig.agent.title} leaderboard</Link> and{' '}
          <Link to="/evals" className="text-blue-600 hover:underline">every evaluation category</Link>.
        </p>
      </Section>
    </div>
  );
}

export default AgentEvalsGuide;
