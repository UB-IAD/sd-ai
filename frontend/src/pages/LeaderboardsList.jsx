import { Link } from 'react-router-dom';
import leaderboards from '../generated/leaderboards.json';
import { leaderboardConfig, LEADERBOARD_ORDER } from './leaderboardMeta';

/**
 * The index for the boards.
 *
 * Leaderboards used to be reachable only from inside the Engines section, which buried
 * the thing most people arrive looking for. This is the section's own landing page, and
 * the card for each board carries enough to choose between them without opening all three.
 */
function LeaderboardsList() {
  const boards = LEADERBOARD_ORDER.map((mode) => ({
    mode,
    meta: leaderboardConfig[mode],
    data: leaderboards[mode],
  })).filter((b) => b.meta);

  return (
    <div className="py-3 sm:py-5">
      <div className="mb-6 sm:mb-8">
        <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold mb-2 sm:mb-3 text-gray-800">
          Leaderboards
        </h1>
        <p className="text-base text-gray-600">
          How each engine scores on the SD-AI benchmark, by modelling task. Scores are the
          share of tests passed; cost and time are per test.
        </p>
      </div>

      <div className="grid gap-4 sm:gap-5 md:grid-cols-2 xl:grid-cols-4">
        {boards.map(({ mode, meta, data }) => {
          // Current generation only, throughout. Scores from different generations are
          // measured over different test sets, so a "leader" picked across all of them is
          // not a ranking of anything — and a card naming a current-generation leader
          // beside an all-generations engine count reads as though the leader beat them
          // all. The counts are scoped to match.
          const generations = data?.generations ?? [];
          const current = data?.currentGeneration ?? null;
          const currentGeneration = generations.find((g) => g.id === current);
          // Every engine/model pairing the board has ever scored, across generations —
          // this counts the breadth of what has been benchmarked, so it is not scoped to
          // the current generation the way the leader below is.
          const allEngines = data?.engines ?? [];
          const engines = allEngines.filter((e) => (e.generations ?? []).includes(current));
          const top = engines.reduce(
            (best, e) => (best == null || e.score > best.score ? e : best),
            null
          );

          return (
            <Link
              key={mode}
              to={`/leaderboard/${mode}`}
              className="no-underline flex flex-col bg-white border border-gray-200 rounded-lg p-4 hover:border-blue-400 hover:shadow-md"
            >
              <h2 className="text-lg font-bold text-gray-800 mb-1">{meta.title}</h2>
              <p className="text-sm text-gray-600 mb-3 flex-grow">{meta.blurb}</p>

              {data == null || engines.length === 0 ? (
                <p className="text-sm text-gray-400">No current-generation results yet.</p>
              ) : (
                <>
                  <dl className="text-sm text-gray-600 mb-3">
                    <div className="flex justify-between gap-3 py-0.5">
                      {/* A row is one engine paired with one model, not one engine — the
                          same engine appears many times over different LLMs. */}
                      <dt>Engines + LLM combinations</dt>
                      <dd className="font-medium text-gray-800">{allEngines.length}</dd>
                    </div>
                    <div className="flex justify-between py-0.5">
                      <dt>Categories</dt>
                      <dd className="font-medium text-gray-800">
                        {currentGeneration?.categoryCount ?? data.categories.length}
                      </dd>
                    </div>
                    <div className="flex justify-between py-0.5">
                      <dt>Tests each</dt>
                      <dd className="font-medium text-gray-800">
                        {(currentGeneration?.testCount ?? 0).toLocaleString()}
                      </dd>
                    </div>
                  </dl>

                  {top && (
                    <div className="border-t border-gray-100 pt-2">
                      <div className="text-xs text-gray-500">Leader</div>
                      <div className="text-sm font-medium text-gray-800">{top.configName}</div>
                      <div className="text-sm text-gray-600">
                        {(top.score * 100).toFixed(1)}% pass
                      </div>
                    </div>
                  )}

                </>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export default LeaderboardsList;
