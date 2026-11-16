import { useState } from 'react';
import { Link } from 'react-router-dom';
import evalsData from '../generated/evals.json';
import { leaderboardConfig, LEADERBOARD_ORDER } from './leaderboardMeta';
import { boardsForCategory, groupKindLabel, ROLE_TEXT } from './evalGuide';

// What each board's section says above its categories, in addition to the board's own
// description. The agent board gets the longest note because its tests work differently.
const SECTION_INTRO = {
  sfd: 'Engine evals: one request goes in, one stock-and-flow model comes out, and that model is graded, usually by simulating it.',
  cld: 'Engine evals: one request goes in, one causal loop diagram comes out, and its links, polarities and loops are graded.',
  discussion: 'Engine evals: one request goes in, one written answer comes out, and a judge model checks it against fixed criteria.',
  agent:
    'Agent evals: an agent such as Merlin or Socrates works through a whole session, the way it does for a real user. It can edit the model, run it, use analysis tools, read uploaded files and, in some categories, question a scripted user over several turns. Tests grade what the agent actually did: the model it left behind, its tool calls and the full conversation. Each category is either a regression guard (basic correctness that must not slip) or discriminating (a judgement skill with deliberately hard cases), and its groups are split into dev, held-out and hard tests.',
};

function CategoryCard({ category, isAgent }) {
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const toggle = (groupName) => {
    const next = new Set(expandedGroups);
    if (next.has(groupName)) next.delete(groupName);
    else next.add(groupName);
    setExpandedGroups(next);
  };
  const totalTests = category.groups.reduce((n, g) => n + g.tests.length, 0);
  const otherBoards = boardsForCategory(category.name).length > 1;
  const role = category.role ? ROLE_TEXT[category.role.kind] : null;

  return (
    <div className="bg-white rounded-lg shadow-md border border-gray-200 hover:shadow-lg flex flex-col">
      <div className="p-6 flex-1">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <h3 className="text-xl font-bold text-gray-800">{category.name}</h3>
          {role && (
            <span className={`text-xs font-medium border rounded px-2 py-0.5 ${role.tone}`} title={role.short}>
              {role.label}
            </span>
          )}
        </div>
        {category.description && (
          <p className="mb-3 text-sm text-gray-700 leading-relaxed">{category.description}</p>
        )}
        {category.role && (
          <p className="mb-3 text-xs text-gray-600 leading-relaxed">
            <span className="font-semibold">{role.label}:</span> {category.role.reason}
          </p>
        )}
        <p className="text-xs text-gray-500 mb-3">
          {totalTests} tests in {category.groups.length} groups
          {otherBoards && <> · also scored on {boardsForCategory(category.name).map((m) => leaderboardConfig[m].title).join(' and ')}</>}
        </p>
        <div className="space-y-2">
          {category.groups.map((group) => {
            const isExpanded = expandedGroups.has(group.name);
            const kind = groupKindLabel(group.name, isAgent);
            return (
              <div key={group.name}>
                <h4
                  onClick={() => toggle(group.name)}
                  className="text-sm font-semibold text-gray-700 cursor-pointer flex items-center flex-wrap gap-x-2"
                >
                  <svg
                    className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span>
                    {group.name} ({group.tests.length} tests)
                  </span>
                  {kind && <span className="text-xs font-normal text-gray-500">{kind}</span>}
                </h4>
                {isExpanded && (
                  <ul className="list-disc ml-5 text-xs text-gray-600 space-y-1 mt-1">
                    {group.tests.map((test) => (
                      <li key={test.name}>
                        <Link
                          to={`/evals/${encodeURIComponent(category.name)}/${encodeURIComponent(group.name)}/${encodeURIComponent(test.name)}`}
                          className="text-blue-600 underline"
                        >
                          {test.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="p-6 pt-0">
        <div className="flex gap-2">
          {category.firstTestUrl && (
            <Link
              to={category.firstTestUrl}
              className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 rounded text-sm font-medium no-underline inline-block"
              title="Browse tests in this category"
            >
              Browse
            </Link>
          )}
          {category.link && (
            <a
              href={category.link}
              target="_blank"
              rel="noopener noreferrer"
              className="bg-gray-100 hover:bg-gray-200 text-gray-700 hover:text-gray-900 px-3 py-2 rounded text-sm font-medium no-underline inline-block"
            >
              Learn More
            </a>
          )}
          {category.source && (
            <a
              href={category.source}
              target="_blank"
              rel="noopener noreferrer"
              className="bg-gray-100 hover:bg-gray-200 text-gray-700 hover:text-gray-900 px-3 py-2 rounded text-sm font-medium no-underline inline-block"
              title="View source code on GitHub"
            >
              View Source
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function EvalsList() {
  const categories = evalsData.categories || [];
  const byName = new Map(categories.map((c) => [c.name, c]));

  // Each board lists its categories in the order its leaderboard columns are described.
  const sections = LEADERBOARD_ORDER.map((mode) => ({
    mode,
    config: leaderboardConfig[mode],
    categories: Object.keys(leaderboardConfig[mode].categoryNotes || {})
      .map((name) => byName.get(name))
      .filter(Boolean),
  }));
  const placed = new Set(sections.flatMap((s) => s.categories.map((c) => c.name)));
  const unplaced = categories.filter((c) => !placed.has(c.name));

  return (
    <div className="evals-page p-5">
      <div className="mb-8">
        <h3 className="text-xl sm:text-2xl text-gray-600 leading-relaxed uppercase mb-6 mt-12">
          Evaluation Categories
        </h3>
        <p className="text-sm text-gray-600 max-w-3xl mb-3">
          Evaluations (evals) are the quality tests used to benchmark engines and agents. Each category is a set of test
          cases, each with a prompt, any model or files it hands over, and the expectations the answer is graded against.
          Every test is pass or fail, and a category’s score is the share of its tests that pass.
        </p>
        <p className="text-sm text-gray-600 max-w-3xl mb-6">
          The categories are grouped below by the leaderboard they are scored on. A category scored on two boards appears
          under both.
        </p>
        <nav className="flex flex-wrap gap-2 text-sm">
          {sections.map((s) => (
            <a
              key={s.mode}
              href={`#board-${s.mode}`}
              onClick={(e) => { e.preventDefault(); document.getElementById(`board-${s.mode}`)?.scrollIntoView({ behavior: 'smooth' }); }}
              className="bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-1.5 rounded no-underline"
            >
              {s.config.title} ({s.categories.length})
            </a>
          ))}
        </nav>
      </div>

      {categories.length === 0 && (
        <div className="p-8 text-center text-gray-600 italic">No evals data available</div>
      )}

      {sections.map(({ mode, config, categories: list }) =>
        list.length === 0 ? null : (
          <section key={mode} id={`board-${mode}`} className="mb-14 scroll-mt-4">
            <div className="mb-6 border-b border-gray-200 pb-4">
              <h2 className="text-2xl font-bold text-gray-800 mb-2">
                {config.title}{' '}
                <span className="text-base font-normal text-gray-500">({list.length} categories)</span>
              </h2>
              <p className="text-sm text-gray-700 max-w-4xl mb-2 leading-relaxed">{SECTION_INTRO[mode]}</p>
              <div className="flex flex-wrap gap-3 text-sm">
                <Link to={`/leaderboard/${mode}`} className="text-blue-600 hover:underline">
                  View the {config.title} leaderboard →
                </Link>
                {mode === 'agent' && (
                  <Link to="/evals/agents" className="text-blue-600 hover:underline font-medium">
                    How the agent evals work →
                  </Link>
                )}
              </div>
              {mode === 'agent' && (
                <dl className="mt-4 grid gap-2 sm:grid-cols-3 text-xs text-gray-600 max-w-4xl">
                  <div className="bg-gray-50 border border-gray-200 rounded p-2">
                    <dt className="font-semibold text-gray-700">dev</dt>
                    <dd>Built from material the grader was developed against.</dd>
                  </div>
                  <div className="bg-gray-50 border border-gray-200 rounded p-2">
                    <dt className="font-semibold text-gray-700">held out (…HeldOut)</dt>
                    <dd>Built from material written after the grader was frozen. The honest score.</dd>
                  </div>
                  <div className="bg-gray-50 border border-gray-200 rounded p-2">
                    <dt className="font-semibold text-gray-700">hard (…Hard, …Hard2)</dt>
                    <dd>The same task with a difficulty lever applied by rule, so strong and weak agents score apart.</dd>
                  </div>
                </dl>
              )}
            </div>
            <div className="grid gap-6 md:grid-cols-2">
              {list.map((category) => (
                <CategoryCard key={category.name} category={category} isAgent={mode === 'agent'} />
              ))}
            </div>
          </section>
        )
      )}

      {unplaced.length > 0 && (
        <section className="mb-14">
          <h2 className="text-2xl font-bold text-gray-800 mb-2">Not on a leaderboard</h2>
          <p className="text-sm text-gray-700 max-w-4xl mb-6">Categories that exist in the repository but are not yet a column on any board.</p>
          <div className="grid gap-6 md:grid-cols-2">
            {unplaced.map((category) => (
              <CategoryCard key={category.name} category={category} isAgent={Boolean(category.role)} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export default EvalsList;
