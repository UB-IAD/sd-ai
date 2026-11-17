import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import Plot from 'react-plotly.js';
import DataTable from 'react-data-table-component';
import { StyleSheetManager } from 'styled-components';
import isPropValid from '@emotion/is-prop-valid';
import leaderboards from '../generated/leaderboards.json';
import { leaderboardConfig } from './leaderboardMeta';
import {
  SEQUENTIAL_BLUE,
  INK_FLIP_AT,
  CATEGORICAL,
  CHROME,
  CHART_FONT,
  camelCaseToWords,
  rampStep,
} from './leaderboardTheme';

/** Row labels have to fit a fixed gutter; the full name is always in the hover. */
const truncate = (s) => (s.length > 42 ? `${s.slice(0, 41)}…` : s);

/**
 * A filter toggle. Reads as a checkbox rather than a button: these are inclusions the
 * reader turns back on, and an unlabelled pressed/unpressed button leaves it ambiguous
 * which state is the filtered one.
 */
const FilterChip = ({ on, onClick, children, title }) => (
  <button
    onClick={onClick}
    title={title}
    aria-pressed={on}
    className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-sm rounded-full border ${
      on
        ? 'bg-blue-50 border-blue-300 text-blue-900 hover:bg-blue-100'
        : 'bg-white border-gray-300 text-gray-500 hover:bg-gray-50'
    }`}
  >
    <span
      className={`inline-flex items-center justify-center w-3.5 h-3.5 rounded-sm border text-[10px] leading-none ${
        on ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-gray-400 text-transparent'
      }`}
      aria-hidden="true"
    >
      ✓
    </span>
    {children}
  </button>
);

const Panel = ({ title, subtitle, children }) => (
  <section className="mb-6 sm:mb-8">
    <h2 className="text-xl sm:text-2xl font-bold mb-1 text-gray-800">{title}</h2>
    {subtitle && <p className="text-sm text-gray-600 mb-3">{subtitle}</p>}
    <div className="bg-white p-2 sm:p-4 border border-gray-200 rounded-lg">{children}</div>
  </section>
);

/** RFC-4180 quoting: anything with a comma, quote or newline has to be wrapped. */
const csvCell = (value) => {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const downloadCsv = (filename, rows) => {
  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

/**
 * react-data-table-component hands its column layout props — `grow`, `minWidth`,
 * `maxWidth`, `hide` and friends — to styled-components v6, which unlike v5 no longer
 * filters unknown props out of the DOM. The result is a console warning per column and
 * an invalid attribute on the rendered div. The props are still wanted for the CSS, so
 * they are blocked at the DOM boundary instead: styled-components keeps passing them to
 * the style template, and only host elements get the filter.
 */
const forwardOnlyValidDomProps = (prop, target) =>
  typeof target === 'string' ? isPropValid(prop) : true;

const PLOT_CONFIG = {
  displayModeBar: false,
  responsive: true,
  displaylogo: false,
};

function Leaderboard() {
  const { mode } = useParams();
  const navigate = useNavigate();
  // The full matrix is still the source of truth, so it stays one click away — collapsed
  // by default because it is the wide, side-scrolling view the charts exist to replace.
  const [showRaw, setShowRaw] = useState(false);
  // Both default to excluded — see the filter bar below for why.
  const [showLocal, setShowLocal] = useState(false);
  const [showBaseline, setShowBaseline] = useState(false);
  const [showOlder, setShowOlder] = useState(false);
  // Row order for the per-category grid. `key: null` is the board's own ranking; a
  // category sorts the grid by that column, which is the only way to read "who is best at
  // X" off a matrix whose rows are otherwise ordered by the overall score.
  const [heatSort, setHeatSort] = useState({ key: null, dir: 'desc' });

  const config = leaderboardConfig[mode];
  const leaderboardData = leaderboards[mode] || null;

  // Generations present in this board, and whether any of them carries a warning about
  // its own results. A newer run overwrites the older result for a test, so a board is
  // a single current table — the generation only records which benchmark version each
  // surviving row came from.
  const generations = leaderboardData?.generations ?? [];
  const caveated = generations.filter((g) => g.caveat && g.count > 0);

  const backLink = (
    <div className="mb-4">
      <Link to="/leaderboards" className="text-blue-600 hover:text-blue-800 no-underline">
        ← All leaderboards
      </Link>
    </div>
  );

  // A board that is defined but has nothing published yet still explains its columns, so a
  // link to it from the evals pages lands on something useful rather than an error.
  if (config && !leaderboardData) {
    return (
      <div className="leaderboard-page py-3 sm:py-5">
        {backLink}
        <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold mb-2 sm:mb-3 text-gray-800">
          {config.title} Leaderboard
        </h1>
        <p className="text-base text-gray-600 mb-3">{config.description}</p>
        <div className="p-4 bg-amber-50 border border-amber-200 rounded text-amber-900 mb-4 text-sm">
          No results have been published to this board yet. The columns it will show are listed below.
        </div>
        <ul className="mb-3 space-y-1.5 text-sm text-gray-600 list-disc pl-5 marker:text-gray-400">
          {Object.entries(config.categoryNotes).map(([category, note]) => (
            <li key={category}>
              <span className="font-semibold text-gray-800">{camelCaseToWords(category)}</span> — {note}
            </li>
          ))}
        </ul>
        {config.note && <p className="text-sm text-gray-600 mb-4">{config.note}</p>}
        {mode === 'agent' && (
          <Link to="/evals/agents" className="text-blue-600 hover:underline text-sm">
            How the agent evals work →
          </Link>
        )}
      </div>
    );
  }

  if (!config || !leaderboardData) {
    return (
      <div className="leaderboard-page py-3 sm:py-5">
        {backLink}
        <div className="p-4 bg-red-50 border border-red-200 rounded text-red-700 mb-4">
          <strong>Error:</strong> No leaderboard data available for mode: {mode}
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------------------- filters */

  // `qualitative-zero` is the no-prompt-engineering control rather than an engine, and the
  // locally-hosted rows are largely sampling sweeps of the same weights at different
  // seeds and quantisations. Both are worth keeping on the board and neither is what
  // someone comparing engines wants to read past, so they are excluded by default and
  // one click away.
  const allEngines = leaderboardData.engines;
  const current = leaderboardData.currentGeneration;
  const isOlder = (engine) => !(engine.generations ?? []).includes(current);

  const passLocal = (engine) => showLocal || !engine.isLocal;
  const passBaseline = (engine) => showBaseline || engine.engineName !== 'qualitative-zero';
  const passGeneration = (engine) => showOlder || !isOlder(engine);

  const visible = allEngines.filter(
    (engine) => passLocal(engine) && passBaseline(engine) && passGeneration(engine)
  );

  // Each chip's count is the size of its class among engines the OTHER chips already
  // admit — not the raw total. On this board every local and baseline engine is also an
  // older-generation one, so a raw total would promise 54 rows that toggling cannot
  // reveal while the generation filter is on.
  const countIn = (inClass, ...others) =>
    allEngines.filter((e) => inClass(e) && others.every((p) => p(e))).length;
  const localCount = countIn((e) => e.isLocal, passBaseline, passGeneration);
  const baselineCount = countIn((e) => e.engineName === 'qualitative-zero', passLocal, passGeneration);
  const olderCount = countIn(isOlder, passLocal, passBaseline);

  // Most engines name their configs after themselves (`qualitative` -> `qualitative-opus-5`),
  // so the engine name is the family label a reader wants. Agent rows do not work that way:
  // every board's agent runs go through one harness engine (`test-agent-build`) whose id
  // says nothing about which agent or which board, while the config name leads with the
  // pair that does — `merlin-cld`, `merlin-sfd`, `merlin-discuss`. So agent rows are
  // labelled from the config, and only the link keeps pointing at the real thing.
  const labelFor = (engine) =>
    engine.agentName ? engine.configName.split('-').slice(0, 2).join('-') : engine.engineName;
  // A row's own title. One agent runs on several models, so its rows would read identically
  // on the family label alone; the model is added to tell them apart. labelFor stays the
  // family, which is what colour and the family legend group on.
  const titleFor = (engine) =>
    engine.agentName && engine.llmModels?.length
      ? `${labelFor(engine)} · ${engine.llmModels.join(' + ')}`
      : labelFor(engine);

  const hasLocal = allEngines.some((e) => e.isLocal);
  const hasBaseline = allEngines.some((e) => e.engineName === 'qualitative-zero');
  const hasOlder = allEngines.some(isOlder);
  const hasFilters = hasLocal || hasBaseline || hasOlder;

  // Sorted once. The rank used to be recomputed inside the cell renderer, which re-sorted
  // the whole board for every row it drew. Ranks are positions within the current filter,
  // which is what a filtered table is claiming to show.
  const ranked = [...visible].sort((a, b) => b.score - a.score);
  const rankOf = new Map(ranked.map((engine, i) => [engine.configName, i + 1]));

  // Alphabetical rather than first-seen: the order a category happens to appear in the
  // results file is arbitrary, and a column order that shifts between runs makes two
  // screenshots of the same board hard to compare.
  const categories = [...leaderboardData.categories].sort((a, b) =>
    camelCaseToWords(a).localeCompare(camelCaseToWords(b))
  );

  // A generation's warning belongs on the page only while its rows are on the page. With
  // the earlier-versions filter off (the default) there are no v1 rows to warn about, and
  // a caveat about numbers the reader cannot see is noise that trains them to skip the
  // banner for the times it does matter.
  const visibleCaveats = caveated.filter((g) =>
    ranked.some((engine) => (engine.generations ?? []).includes(g.id))
  );

  const isCaveated = (engine) =>
    (engine.generations ?? []).some((id) => caveated.some((g) => g.id === id));

  /* ------------------------------------------------------------ per-category grid */

  // The per-category scores were twelve numeric columns, which pushed the table into
  // horizontal scrolling — the one interaction that makes a wide table unreadable, since
  // the engine name scrolls away from the number you are reading. The same values as a
  // heatmap fit the page width whatever the category count, and comparing down a column
  // or across a row becomes a glance instead of a scroll.
  // A sort key from another board survives the route change, so it is checked against
  // this board's categories rather than trusted.
  const sortKey = categories.includes(heatSort.key) ? heatSort.key : null;

  const byCategory = (a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    // An engine that did not run a category has nothing to compare, so it sinks to the
    // bottom in both directions rather than reading as a zero.
    if (av == null || bv == null) return av == null ? (bv == null ? 0 : 1) : -1;
    if (av !== bv) return heatSort.dir === 'desc' ? bv - av : av - bv;
    // Ties fall back to the board order, so equal cells keep a stable, meaningful order.
    return rankOf.get(a.configName) - rankOf.get(b.configName);
  };

  const heatRows = sortKey
    ? [...ranked].sort(byCategory)
    : heatSort.dir === 'desc'
      ? ranked
      : [...ranked].reverse();

  // Two long config names can truncate to the same label, and a category axis merges rows
  // that share one — the second engine's scores would draw on top of the first's. A
  // trailing hair space per collision keeps them distinct to Plotly and identical on
  // screen. Built off `ranked` so a row keeps its label whatever the sort is.
  const labelCounts = new Map();
  const rowLabelOf = new Map(
    ranked.map((engine) => {
      const base = truncate(engine.configName);
      const seen = labelCounts.get(base) ?? 0;
      labelCounts.set(base, seen + 1);
      return [engine.configName, base + '\u200a'.repeat(seen)];
    })
  );

  const heatmapZ = heatRows.map((engine) => categories.map((c) => engine[c] ?? null));
  // The slanted headers stand out of the plot by their own length projected at 45°, and
  // `automargin` takes that out of the chart box — so the box has to grow by it, or the
  // rows get squeezed to nothing on a board with long category names.
  const longestHeader = Math.max(...categories.map((c) => camelCaseToWords(c).length));
  const headerBand = Math.round(((longestHeader * 6.2 + 20) / Math.SQRT2) + 20);
  const heatmapHeight = Math.max(340, ranked.length * 26 + headerBand + 110);

  // A number in every cell is noise once the grid is large, and the skill's own rule is
  // selective labelling. Past ~20 engines the colour carries the comparison and the hover
  // carries the exact figure.
  const labelCells = ranked.length <= 20;
  const cellLabels = labelCells
    ? heatRows.flatMap((engine, row) =>
        categories
          .map((category, col) => {
            const value = engine[category];
            if (value == null) return null;
            return {
              x: col,
              y: row,
              text: `${Math.round(value * 100)}%`,
              showarrow: false,
              font: {
                ...CHART_FONT,
                size: 11,
                // The ramp crosses into dark at its midpoint, so ink flips there.
                color: value >= INK_FLIP_AT ? '#ffffff' : CHROME.textPrimary,
              },
            };
          })
          .filter(Boolean)
      )
    : [];

  /* ------------------------------------------------------------ engine families */

  // Which engine family a point belongs to is an identity distinction, so both scatter
  // charts give it hue, from the same fixed slots. On a scatter any two points can sit
  // side by side, and only the first three categorical slots stay distinguishable for
  // every pair (colour-vision deficiency included), so families past three fold into a
  // muted "Other" rather than growing the palette. Slots are assigned from the whole
  // board, not the filtered view, so a filter never repaints the families that survive
  // it. Family names are compared case-insensitively: "Seldon" and "seldon" are one engine.
  const familyKey = (engine) => labelFor(engine).toLowerCase();
  const familyTally = allEngines.reduce((acc, e) => {
    const key = familyKey(e);
    acc[key] ??= { count: 0, names: {} };
    acc[key].count += 1;
    acc[key].names[labelFor(e)] = (acc[key].names[labelFor(e)] ?? 0) + 1;
    return acc;
  }, {});
  const familyOrder = Object.entries(familyTally)
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([key]) => key);
  const familyColor = new Map(familyOrder.slice(0, CATEGORICAL.length).map((key, i) => [key, CATEGORICAL[i]]));
  // Shown under its most common spelling.
  const familyName = new Map(
    familyOrder.map((key) => [key, Object.entries(familyTally[key].names).sort((a, b) => b[1] - a[1])[0][0]])
  );
  const seriesOf = (engine) => (familyColor.has(familyKey(engine)) ? familyKey(engine) : 'other');

  /**
   * One scatter trace per engine family, in slot order with "Other" last, so both charts
   * share colours, legend and marks. An engine still carrying results from a caveated
   * generation is drawn hollow: the fill is the only thing that changes, so the family
   * stays readable while the chart does not present a flagged score as equal footing.
   */
  const familyTraces = (engines, { x, y, customdata, hovertemplate }) => {
    const series = [...familyOrder.filter((key) => familyColor.has(key)), 'other'];
    return series
      .map((key) => {
        const members = engines.filter((e) => seriesOf(e) === key);
        if (members.length === 0) return null;
        const color = familyColor.get(key) ?? CHROME.muted;
        return {
          x: members.map(x),
          y: members.map(y),
          text: members.map((e) => e.llmModel),
          customdata: members.map(customdata),
          name: key === 'other' ? 'Other' : familyName.get(key),
          mode: 'markers+text',
          type: 'scatter',
          textposition: 'top center',
          textfont: { ...CHART_FONT, size: 10, color: CHROME.textSecondary },
          marker: {
            size: 13,
            color: members.map((e) => (isCaveated(e) ? '#ffffff' : color)),
            symbol: members.map((e) => (isCaveated(e) ? 'circle-open-dot' : 'circle')),
            // A surface ring keeps two points that land on each other readable as two;
            // a hollow point keeps its family colour on the ring instead.
            line: { width: 2, color: members.map((e) => (isCaveated(e) ? color : '#ffffff')) },
          },
          hovertemplate,
        };
      })
      .filter(Boolean);
  };

  /* ------------------------------------------------------------------- cost chart */

  // Results predating cost tracking have none, and a board can be entirely unpriced.
  const priced = ranked.filter((e) => e.costPerTest != null);

  const costTraces = familyTraces(priced, {
    x: (e) => e.score,
    y: (e) => e.costPerTest,
    customdata: (e) => [e.configName, e.costTotal, e.costUnpricedCalls],
    hovertemplate:
      '<b>%{customdata[0]}</b><br>%{text}<br>' +
      'Score: %{x:.1%}<br>Cost/test: $%{y:.4f}<br>' +
      'Benchmark total: $%{customdata[1]:.2f}<extra></extra>',
  });

  /* ------------------------------------------------------------------ speed chart */

  const speedTraces = familyTraces(ranked, {
    x: (e) => e.score,
    y: (e) => e.speed,
    customdata: (e) => e.configName,
    hovertemplate: '<b>%{customdata}</b><br>%{text}<br>Score: %{x:.1%}<br>Avg time: %{y:.1f}s<extra></extra>',
  });

  const hasHollow = ranked.some(isCaveated);

  const unpricedNote = ranked.length - priced.length;

  /* --------------------------------------------------------------------- raw data */

  // Header plus one row per engine, in the same order the page shows. Cost stays blank
  // rather than 0 for unpriced rows so a spreadsheet won't average "free" into the column.
  const csvRows = [
    ['rank', 'engineConfig', 'engine', 'llmModels', 'overallScore', 'avgCostPerTest',
     'benchmarkCostTotal', 'avgSecondsPerTest', 'generations', ...categories],
    ...ranked.map((engine) => [
      rankOf.get(engine.configName),
      engine.configName,
      engine.engineName,
      (engine.llmModels ?? []).join(' + '),
      engine.score.toFixed(6),
      engine.costPerTest == null ? '' : engine.costPerTest.toFixed(6),
      engine.costTotal == null ? '' : engine.costTotal.toFixed(4),
      engine.speed.toFixed(3),
      (engine.generations ?? []).join(' '),
      ...categories.map((c) => (engine[c] == null ? '' : engine[c].toFixed(6))),
    ]),
  ];

  return (
    <div className="leaderboard-page py-3 sm:py-5">
      {backLink}

      <div className="mb-6 sm:mb-8">
        <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold mb-2 sm:mb-3 text-gray-800">
          {config.title} Leaderboard
        </h1>
        <p className="text-base text-gray-600 mb-3">{config.description}</p>
        {/* Driven off the board's own categories rather than the copy, so the list is
            always exactly the columns of the grid below, in the same order — a category
            that gains a column but no description shows up as a bare heading rather than
            silently going unexplained. Each heading links to one of its tests, which is
            the next question a reader has after "what does this column mean". */}
        <ul className="mb-3 space-y-1.5 text-sm text-gray-600 list-disc pl-5 marker:text-gray-400">
          {categories.map((category) => {
            const test = leaderboardData.categoryFirstTests[category];
            const heading = camelCaseToWords(category);
            return (
              <li key={category}>
                {test ? (
                  <Link
                    to={`/evals/${encodeURIComponent(test.category)}/${encodeURIComponent(test.group)}/${encodeURIComponent(test.testName)}`}
                    className="font-semibold text-blue-600 hover:text-blue-800 no-underline"
                  >
                    {heading}
                  </Link>
                ) : (
                  <span className="font-semibold text-gray-800">{heading}</span>
                )}
                {config.categoryNotes[category] && <> — {config.categoryNotes[category]}</>}
              </li>
            );
          })}
        </ul>
        {config.note && <p className="text-sm text-gray-600 mb-4">{config.note}</p>}

        {/* A generation whose own results are known to be unreliable says so on the
            page, not just in the repo. A number shown without its caveat gets quoted
            without it. */}
        {visibleCaveats.map((g) => {
          // Only claimed where the numbers back it. The benchmark grew by different
          // amounts per board: SFD went 5 categories -> 12, while CLD stayed at 4, so on
          // CLD this sentence would be false.
          const now = generations.find((x) => x.id === leaderboardData.currentGeneration);
          const harder = now && now.id !== g.id && now.testCount > g.testCount;
          return (
            <div
              key={g.id}
              className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded text-sm text-amber-900"
            >
              <strong>{g.label} results:</strong> {g.caveat}
              {harder && (
                <>
                  {' '}
                  {now.label} also runs more evaluations than {g.label} — {now.testCount} tests
                  across {now.categoryCount} categories, against {g.testCount} across{' '}
                  {g.categoryCount} — and the added ones are harder, so {now.label} scores may
                  read lower than {g.label} scores for the same engine.
                </>
              )}
            </div>
          );
        })}
      </div>

      {hasFilters && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-sm text-gray-600">
            Showing <strong className="text-gray-800">{ranked.length}</strong> of{' '}
            {allEngines.length} engines
          </span>
          {hasOlder && (
            <FilterChip
              on={showOlder}
              onClick={() => setShowOlder(!showOlder)}
              title={`Engines whose results predate the current generation (${current}). Their scores were measured on a different set of tests and are not comparable.`}
            >
              Include results from earlier benchmark versions ({olderCount})
            </FilterChip>
          )}
          {hasLocal && (
            <FilterChip
              on={showLocal}
              onClick={() => setShowLocal(!showLocal)}
              title="Models run locally through LM Studio / llama.cpp — identified by the seed, quantisation and context size recorded in the config name"
            >
              Locally-hosted ({localCount})
            </FilterChip>
          )}
          {hasBaseline && (
            <FilterChip
              on={showBaseline}
              onClick={() => setShowBaseline(!showBaseline)}
              title="qualitative-zero: the control that measures a plain, non-prompt-engineered LLM on the same tasks"
            >
              Baseline control ({baselineCount})
            </FilterChip>
          )}
          {(showLocal || showBaseline || showOlder) && (
            <button
              onClick={() => {
                setShowLocal(false);
                setShowBaseline(false);
                setShowOlder(false);
              }}
              className="text-sm text-blue-600 hover:text-blue-800 underline"
            >
              Reset
            </button>
          )}
        </div>
      )}

      {/* Headline numbers only. Everything per-category moved to the heatmap below, which
          is what keeps this table inside the page width. */}
      <Panel
        title="Standings"
        subtitle="Overall score, plus cost and wall-clock time per test. Per-category scores are in the grid below."
      >
        <StyleSheetManager shouldForwardProp={forwardOnlyValidDomProps}>
          <DataTable
            columns={[
              {
                name: '#',
                selector: (row) => rankOf.get(row.configName),
                sortable: true,
                width: '64px',
              },
              {
                name: 'Engine',
                selector: (row) => row.configName,
                sortable: true,
                grow: 3,
                minWidth: '260px',
                cell: (row) => (
                  <div className="py-1">
                    {/* Two different kinds of thing share this column: engines, and agents
                        driven through an engine that wraps them. They score on the same
                        tests but they are not the same kind of entry, so each row says
                        which it is rather than leaving it to be read off a name. */}
                    <div className="flex items-center gap-1.5">
                      <Link
                        to={
                          row.agentName
                            ? `/agents/${row.agentName}`
                            : `/engines/${row.engineName}`
                        }
                        className="text-blue-600 hover:text-blue-800 no-underline font-medium"
                      >
                        {titleFor(row)}
                      </Link>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide border ${
                          row.agentName
                            ? 'bg-violet-50 text-violet-700 border-violet-200'
                            : 'bg-gray-100 text-gray-600 border-gray-200'
                        }`}
                        title={
                          row.agentName
                            ? `The ${row.agentName} agent, run through the ${row.engineName} engine`
                            : `The ${row.engineName} engine`
                        }
                      >
                        {row.agentName ? 'agent' : 'engine'}
                      </span>
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">{row.configName}</div>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {(row.llmModels ?? []).length === 0 ? (
                        <span
                          className="inline-block px-2 py-0.5 text-xs bg-gray-100 text-gray-500 rounded"
                          title="This engine drives no LLM of its own"
                        >
                          no LLM
                        </span>
                      ) : (
                        row.llmModels.map((model) => (
                          <span
                            key={model}
                            className="inline-block px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-600 rounded"
                          >
                            {model}
                          </span>
                        ))
                      )}
                    </div>
                  </div>
                ),
              },
              {
                name: 'Score',
                selector: (row) => row.score,
                sortable: true,
                format: (row) => `${(row.score * 100).toFixed(1)}%`,
                width: '110px',
              },
              {
                name: 'Cost / Test',
                // Results produced before evals captured cost have none. Sorting them
                // below every priced engine keeps "cheapest first" meaningful; the cell
                // still renders an em dash so unknown never reads as free.
                selector: (row) => row.costPerTest ?? Number.MAX_VALUE,
                sortable: true,
                width: '130px',
                cell: (row) =>
                  row.costPerTest == null ? (
                    <span className="text-gray-400" title="These results predate cost tracking">
                      —
                    </span>
                  ) : (
                    <span
                      title={
                        `$${row.costTotal.toFixed(2)} total across the benchmark` +
                        (row.costUnpricedCalls > 0
                          ? ` — at least, ${row.costUnpricedCalls} call(s) used a model with no published pricing`
                          : '')
                      }
                    >
                      ${row.costPerTest.toFixed(4)}
                      {row.costUnpricedCalls > 0 && <span className="text-amber-600">*</span>}
                    </span>
                  ),
              },
              {
                name: 'Time / Test',
                selector: (row) => row.speed,
                sortable: true,
                format: (row) => `${row.speed.toFixed(1)}s`,
                width: '130px',
              },
              ...(generations.length > 1
                ? [{
                    name: 'Results',
                    // Which benchmark generation this engine's numbers come from. Only
                    // worth a column once a board holds more than one, and it shows the
                    // mix rather than a single label because a partly re-run engine
                    // genuinely is part-old.
                    selector: (row) => (row.generations ?? []).join(','),
                    sortable: true,
                    width: '120px',
                    cell: (row) => (
                      <span
                        className="flex flex-wrap gap-1"
                        title={Object.entries(row.generationCounts ?? {})
                          .map(([id, n]) => `${n} result(s) from ${id}`)
                          .join(', ')}
                      >
                        {(row.generations ?? []).map((id) => (
                          <span
                            key={id}
                            className={`inline-block px-2 py-1 text-xs font-medium rounded ${
                              caveated.some((g) => g.id === id)
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-indigo-50 text-indigo-700'
                            }`}
                          >
                            {id}
                          </span>
                        ))}
                      </span>
                    ),
                  }]
                : []),
            ]}
            data={ranked}
            defaultSortFieldId={1}
            pagination={false}
            highlightOnHover
            striped
            responsive
            customStyles={{
              table: { style: { minWidth: '100%', border: 'none' } },
              headRow: {
                style: {
                  backgroundColor: '#f9fafb',
                  borderBottom: '1px solid #d1d5db',
                  minHeight: '44px',
                },
              },
              headCells: {
                style: {
                  padding: '8px 12px',
                  fontSize: '14px',
                  fontWeight: '600',
                  color: '#374151',
                },
              },
              cells: {
                style: {
                  padding: '10px 12px',
                  fontSize: '14px',
                  color: '#374151',
                  borderBottom: '1px solid #e5e7eb',
                },
              },
              rows: { style: { minHeight: '56px', '&:hover': { backgroundColor: '#f3f4f6' } } },
            }}
          />
        </StyleSheetManager>
      </Panel>

      {/* Per-category scores */}
      <Panel
        title="Scores by Category"
        subtitle={
          labelCells
            ? 'Darker is better. Hover a cell for the exact figure; blank means the engine did not run that category.'
            : `Darker is better. Hover a cell for the exact figure — with ${ranked.length} engines the cells are left unlabelled. Blank means the engine did not run that category.`
        }
      >
        {/* The old per-column "View" buttons lived in the table header. They move here so
            the link to each category's test survives the switch to a heatmap. */}
        <div className="flex flex-wrap gap-1.5 mb-3">
          {categories.map((category) => {
            const test = leaderboardData.categoryFirstTests[category];
            return (
              <button
                key={category}
                onClick={() =>
                  navigate(
                    `/evals/${encodeURIComponent(test.category)}/${encodeURIComponent(test.group)}/${encodeURIComponent(test.testName)}`
                  )
                }
                className="px-2 py-1 text-xs bg-blue-50 text-blue-700 hover:bg-blue-100 hover:text-blue-900 rounded"
                title={`View a ${camelCaseToWords(category)} test`}
              >
                {camelCaseToWords(category)} ↗
              </button>
            );
          })}
        </div>

        {/* Rows arrive in the board's own ranking, which answers "who is best overall" and
            nothing else. Re-sorting on a column is what turns the grid into an answer to
            "who is best at this one thing". */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <label htmlFor="heatmap-sort" className="text-sm text-gray-600">
            Sort rows by
          </label>
          <select
            id="heatmap-sort"
            value={sortKey ?? ''}
            onChange={(e) => setHeatSort({ key: e.target.value || null, dir: 'desc' })}
            className="px-2 py-1 text-sm border border-gray-300 rounded bg-white text-gray-800"
          >
            <option value="">Overall score</option>
            {categories.map((category) => (
              <option key={category} value={category}>
                {camelCaseToWords(category)}
              </option>
            ))}
          </select>
          <button
            onClick={() =>
              setHeatSort((prev) => ({ ...prev, dir: prev.dir === 'desc' ? 'asc' : 'desc' }))
            }
            className="px-2 py-1 text-sm border border-gray-300 rounded bg-white text-gray-700 hover:bg-gray-50"
            title="Reverse the row order"
          >
            {heatSort.dir === 'desc' ? 'High → low ▾' : 'Low → high ▴'}
          </button>
        </div>

        <Plot
          data={[
            {
              type: 'heatmap',
              x: categories.map((c) => camelCaseToWords(c)),
              y: heatRows.map((e) => rowLabelOf.get(e.configName)),
              z: heatmapZ,
              zmin: 0,
              zmax: 1,
              colorscale: SEQUENTIAL_BLUE,
              hoverongaps: false,
              // A 2px surface gap between fills, per the mark spec.
              xgap: 2,
              ygap: 2,
              customdata: heatRows.map((e) => categories.map(() => e.configName)),
              hovertemplate:
                '<b>%{customdata}</b><br>%{x}<br>Score: %{z:.1%}<extra></extra>',
              colorbar: {
                title: { text: 'Score', side: 'right', font: { ...CHART_FONT, size: 11 } },
                tickformat: '.0%',
                thickness: 12,
                len: 0.6,
                outlinewidth: 0,
                tickfont: { ...CHART_FONT, size: 10, color: CHROME.muted },
              },
            },
          ]}
          layout={{
            autosize: true,
            annotations: cellLabels,
            xaxis: {
              type: 'category',
              side: 'top',
              // A dozen category names across the width will not fit side by side at any
              // font size, so they lean instead of wrapping — a slanted label stays one
              // readable line, and `automargin` buys back whatever room the lean needs.
              tickangle: -45,
              automargin: true,
              tickfont: { ...CHART_FONT, size: 11, color: CHROME.textSecondary },
              ticks: '',
              showgrid: false,
              zeroline: false,
            },
            yaxis: {
              type: 'category',
              // Stated rather than inferred from the trace: a category axis keeps the
              // order it was first drawn with across updates, which would pin the rows
              // to whatever sort was active when the chart first rendered.
              categoryorder: 'array',
              categoryarray: heatRows.map((e) => rowLabelOf.get(e.configName)),
              // Plotly draws categories bottom-up; the board reads best-first.
              autorange: 'reversed',
              tickfont: { ...CHART_FONT, size: 11, color: CHROME.textSecondary },
              ticks: '',
              showgrid: false,
              zeroline: false,
            },
            margin: { t: 20, r: 20, b: 20, l: 290 },
            font: CHART_FONT,
            plot_bgcolor: 'rgba(0,0,0,0)',
            paper_bgcolor: 'rgba(0,0,0,0)',
            hovermode: 'closest',
          }}
          config={PLOT_CONFIG}
          style={{ width: '100%', height: `${heatmapHeight}px` }}
          useResizeHandler={true}
        />
      </Panel>

      {/* Raw data — the wide matrix, on request. The charts above replace it as the
          default view; they don't replace the need to read the actual numbers. */}
      <section className="mb-6 sm:mb-8">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <h2 className="text-xl sm:text-2xl font-bold text-gray-800">Raw Data</h2>
          <div className="flex gap-2">
            <button
              onClick={() => setShowRaw(!showRaw)}
              className="px-3 py-1.5 text-sm font-medium border border-gray-300 rounded text-gray-700 hover:bg-gray-50"
              aria-expanded={showRaw}
            >
              {showRaw ? 'Hide table' : 'Show table'}
            </button>
            <button
              onClick={() => downloadCsv(`sd-ai-${mode}-leaderboard.csv`, csvRows)}
              className="px-3 py-1.5 text-sm font-medium border border-gray-300 rounded text-gray-700 hover:bg-gray-50"
            >
              ⤓ Download CSV
            </button>
          </div>
        </div>
        <p className="text-sm text-gray-600 mb-3">
          Every score behind the charts, {ranked.length} engines × {categories.length}{' '}
          categories. This is the wide view — it scrolls sideways, with the engine column
          pinned so the name stays with the number.
        </p>

        {showRaw && (
          <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
            <table className="text-sm border-collapse w-full">
              <thead>
                <tr className="bg-gray-50">
                  <th className="sticky left-0 z-20 bg-gray-50 text-left font-semibold text-gray-700 px-3 py-2 border-b border-r border-gray-300 min-w-[240px]">
                    Engine
                  </th>
                  <th className="text-right font-semibold text-gray-700 px-3 py-2 border-b border-gray-300 whitespace-nowrap">
                    Score
                  </th>
                  <th className="text-right font-semibold text-gray-700 px-3 py-2 border-b border-gray-300 whitespace-nowrap">
                    Cost / Test
                  </th>
                  <th className="text-right font-semibold text-gray-700 px-3 py-2 border-b border-r border-gray-300 whitespace-nowrap">
                    Time / Test
                  </th>
                  {categories.map((category) => (
                    <th
                      key={category}
                      className="text-center font-semibold text-gray-700 px-3 py-2 border-b border-gray-300 align-bottom"
                    >
                      <span className="block max-w-[110px] mx-auto leading-tight text-xs">
                        {camelCaseToWords(category)}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ranked.map((engine) => (
                  <tr key={engine.configName} className="hover:bg-gray-50">
                    <th
                      scope="row"
                      className="sticky left-0 z-10 bg-white text-left font-normal px-3 py-2 border-b border-r border-gray-200"
                    >
                      <span className="text-gray-400 mr-1">{rankOf.get(engine.configName)}.</span>
                      <Link
                        to={`/engines/${engine.engineName}`}
                        className="text-blue-600 hover:text-blue-800 no-underline font-medium"
                      >
                        {engine.configName}
                      </Link>
                      <span className="block text-xs text-gray-500">
                        {(engine.llmModels ?? []).length ? engine.llmModels.join(' + ') : 'no LLM'}
                      </span>
                    </th>
                    <td className="text-right px-3 py-2 border-b border-gray-200 font-medium whitespace-nowrap">
                      {(engine.score * 100).toFixed(1)}%
                    </td>
                    <td className="text-right px-3 py-2 border-b border-gray-200 whitespace-nowrap">
                      {engine.costPerTest == null ? (
                        <span className="text-gray-400">—</span>
                      ) : (
                        `$${engine.costPerTest.toFixed(4)}`
                      )}
                    </td>
                    <td className="text-right px-3 py-2 border-b border-r border-gray-200 whitespace-nowrap">
                      {engine.speed.toFixed(1)}s
                    </td>
                    {categories.map((category) => {
                      const value = engine[category];
                      if (value == null) {
                        return (
                          <td
                            key={category}
                            className="text-center px-3 py-2 border-b border-gray-200 text-gray-300"
                            title="Not run for this engine"
                          >
                            —
                          </td>
                        );
                      }
                      const { bg, fg } = rampStep(value);
                      return (
                        <td
                          key={category}
                          className="text-center px-3 py-2 border-b border-gray-200 whitespace-nowrap"
                          style={{ backgroundColor: bg, color: fg }}
                        >
                          {(value * 100).toFixed(0)}%
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Cost */}
      <Panel
        title="Cost vs. Performance"
        subtitle="Spend per test against overall score, on the same x axis as the speed chart below. Down and to the right is better: more accuracy for less money."
      >
        {priced.length === 0 ? (
          <div className="p-6 text-center text-gray-500 text-sm">
            No cost data on this board yet. Cost is recorded from the {' '}
            <span className="font-medium">v2</span> generation onward, so this chart fills in
            once a v2 run has been merged here.
          </div>
        ) : (
          <>
            <Plot
              data={costTraces}
              layout={{
                autosize: true,
                xaxis: {
                  // Identical to the speed chart's x axis so the two stack and compare.
                  title: { text: 'Score (% correct)', standoff: 20 },
                  range: [0, 1.13],
                  tickformat: '.0%',
                  showgrid: true,
                  gridcolor: CHROME.gridline,
                  zeroline: false,
                  linecolor: CHROME.axis,
                  tickfont: { ...CHART_FONT, color: CHROME.muted },
                },
                yaxis: {
                  title: { text: 'Avg cost per test (USD)', standoff: 20 },
                  type: 'log',
                  tickprefix: '$',
                  showgrid: true,
                  gridcolor: CHROME.gridline,
                  zeroline: false,
                  linecolor: CHROME.axis,
                  tickfont: { ...CHART_FONT, color: CHROME.muted },
                },
                margin: { t: 20, r: 30, b: 60, l: 80 },
                font: CHART_FONT,
                showlegend: costTraces.length > 1,
                legend: { orientation: 'h', y: -0.18, font: { ...CHART_FONT, size: 11 } },
                hovermode: 'closest',
                plot_bgcolor: 'rgba(0,0,0,0)',
                paper_bgcolor: 'rgba(0,0,0,0)',
              }}
              config={PLOT_CONFIG}
              style={{ width: '100%', height: '520px' }}
              useResizeHandler={true}
            />
            {unpricedNote > 0 && (
              <p className="text-xs text-gray-500 mt-2">
                {unpricedNote} of {ranked.length} engines are not plotted — their results
                predate cost tracking. They still appear in the standings above with an em
                dash for cost.
              </p>
            )}
          </>
        )}
      </Panel>

      {/* Speed */}
      <Panel
        title="Performance vs. Speed"
        subtitle="Overall score against average wall-clock time per test."
      >
        <Plot
          data={speedTraces}
          layout={{
            autosize: true,
            xaxis: {
              title: { text: 'Score (% correct)', standoff: 20 },
              range: [0, 1.13],
              tickformat: '.0%',
              showgrid: true,
              gridcolor: CHROME.gridline,
              zeroline: false,
              linecolor: CHROME.axis,
              tickfont: { ...CHART_FONT, color: CHROME.muted },
            },
            yaxis: {
              title: { text: 'Avg time per test (seconds)', standoff: 20 },
              type: 'log',
              showgrid: true,
              gridcolor: CHROME.gridline,
              zeroline: false,
              linecolor: CHROME.axis,
              tickfont: { ...CHART_FONT, color: CHROME.muted },
            },
            margin: { t: 10, r: 30, b: 60, l: 80 },
            font: CHART_FONT,
            showlegend: speedTraces.length > 1,
            legend: { orientation: 'h', y: -0.12, font: { ...CHART_FONT, size: 11 } },
            hovermode: 'closest',
            plot_bgcolor: 'rgba(0,0,0,0)',
            paper_bgcolor: 'rgba(0,0,0,0)',
          }}
          config={PLOT_CONFIG}
          style={{ width: '100%', height: '760px' }}
          useResizeHandler={true}
        />
        {hasHollow && (
          <p className="text-xs text-gray-500 mt-2">
            Hollow markers are engines still carrying results from an earlier generation of
            the benchmark; see the caveat above.
          </p>
        )}
      </Panel>
    </div>
  );
}

export default Leaderboard;
