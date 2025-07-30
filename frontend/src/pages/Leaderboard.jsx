import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import Plot from 'react-plotly.js';
import DataTable from 'react-data-table-component';
import api from '../services/api';

const leaderboardConfig = {
  'cld': {
    title: 'Causal Loop Diagrams',
    description: 'The leaderboard showcases engines\' performance across three tests: causal-translation, which evaluates an engine\'s ability to convert plain English into structured causal graphs by identifying links and loops within synthetic gibberish-based ground truths, conformance, which assesses how well the engine follows user instructions by generating models with the correct variables and specified feedback loops in open-ended real-world contexts, and qualitative causal reasoning which checks how wee an engine can identify causal struture within real world situations. Each engine\'s results display its individual scores on all three tests, an overall combined score reflecting total performance, and a speed ranking to highlight how efficiently it completed the evaluations. The qualitative-zero "engine" attempts to measure how a default "non-prompt engineered" LLM performs on these same tasks.'
  },
  'sfd': {
    title: 'Stock & Flow Diagrams',
    description: 'The leaderboard showcases engines\' performance across two tests: quantitative-causal-translation, which tests the engine\'s ability to translate quantitative stock-and-flow model descriptions with gibberish variables into simulating models by identifying causal relationships involving fixed, proportional, and interdependent flows; and quantitative-causal-reasoning, which measures the engine\'s capacity to generate simulating stock and flow models in complex contexts by evaluating its outputs against key expert-specified concepts. Each engine\'s results display its individual scores on all four tests, an overall combined score reflecting total performance, and a speed ranking that highlights how efficiently it completed the evaluations. This comprehensive leaderboard enables direct comparison of accuracy, reasoning, and execution speed to drive improvements in modeling capability and efficiency.'
  }
};

function Leaderboard() {
  const { mode } = useParams();
  const navigate = useNavigate();
  const [leaderboardData, setLeaderboardData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchLeaderboardData = async () => {
      try {
        setLoading(true);
        setError(null);

        // Fetch leaderboard data from API
        const response = await api.get(`/leaderboard/${mode}`);
        const data = response.data.success ? response.data.data : response.data;
        setLeaderboardData(processLeaderboardData(data));
        
      } catch (err) {
        setError(err.response?.data?.message || err.message || 'Failed to fetch leaderboard data');
        console.error('Error fetching leaderboard data:', err);
      } finally {
        setLoading(false);
      }
    };

    if (mode) {
      fetchLeaderboardData();
    }
  }, [mode]);

  const camelCaseToWords = (s) => {
    const result = s.replace(/([A-Z])/g, ' $1');
    return result.charAt(0).toUpperCase() + result.slice(1);
  };

  const processLeaderboardData = (data) => {
    const engineStats = {};
    const categories = new Set();
    const categoryFirstTests = {};

    data.results.forEach(test => {
      const engineConfigName = test.engineConfigName;
      const engineName = test.engineConfig.engine;
      const llmModel = test.engineConfig.additionalParameters?.underlyingModel || 'N/A';
      
      // Store the first test for each category to use for linking
      if (!categoryFirstTests[test.category]) {
        categoryFirstTests[test.category] = {
          category: test.category,
          group: test.group,
          testName: test.testParams.name
        };
      }
      
      if (!engineStats[engineConfigName]) {
        engineStats[engineConfigName] = {
          speeds: [],
          engineName: engineName,
          llmModel: llmModel
        };
      }

      if (!(test.category in engineStats[engineConfigName])) {
        categories.add(test.category);
        engineStats[engineConfigName][test.category] = {
          passes: 0,
          count: 0
        };
      }

      engineStats[engineConfigName][test.category].passes += test.pass ? 1 : 0;
      engineStats[engineConfigName][test.category].count += 1;
      engineStats[engineConfigName].speeds.push(test.duration);
    });

    // Compute average score and median speed
    const engineArray = Object.entries(engineStats).map(([configName, stats]) => {
      let totalPasses = 0;
      let totalCount = 0;
      const scores = Object.fromEntries(
        Object.keys(stats)
          .filter(e => !["speeds", "engineName", "llmModel"].includes(e))
          .map(category => {
            totalPasses += stats[category].passes;
            totalCount += stats[category].count;
            return [category, stats[category].passes / stats[category].count];
          })
      );

      const score = totalPasses / totalCount;
      const speed = stats.speeds.reduce((partialSum, a) => partialSum + a, 0) / 1000;
      
      return {
        configName,
        engineName: stats.engineName,
        llmModel: stats.llmModel,
        speed,
        score,
        ...scores,
      };
    });

    // Sort engines by average score descending
    engineArray.sort((a, b) => b.score - a.score);

    return {
      engines: engineArray,
      categories: Array.from(categories),
      categoryFirstTests: categoryFirstTests
    };
  };

  const config = leaderboardConfig[mode];

  if (loading) {
    return (
      <div className="leaderboard-page py-3 sm:py-5">
        <div className="mb-4">
          <Link 
            to="/engines"
            className="text-blue-600 hover:text-blue-800 no-underline"
          >
            ← Back to Engines
          </Link>
        </div>
        <div className="p-5 text-center text-gray-600">
          Loading leaderboard data...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="leaderboard-page py-3 sm:py-5">
        <div className="mb-4">
          <Link 
            to="/engines"
            className="text-blue-600 hover:text-blue-800 no-underline"
          >
            ← Back to Engines
          </Link>
        </div>
        <div className="p-4 bg-red-50 border border-red-200 rounded text-red-700 mb-4">
          <strong>Error:</strong> {error}
        </div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="leaderboard-page py-3 sm:py-5">
        <div className="mb-4">
          <Link 
            to="/engines"
            className="text-blue-600 hover:text-blue-800 no-underline"
          >
            ← Back to Engines
          </Link>
        </div>
        <div className="p-4 bg-red-50 border border-red-200 rounded text-red-700 mb-4">
          <strong>Error:</strong> Invalid leaderboard mode: {mode}
        </div>
      </div>
    );
  }

  return (
    <div className="leaderboard-page py-3 sm:py-5">
      {/* Breadcrumb */}
      <div className="mb-4">
        <Link 
          to="/engines"
          className="text-blue-600 hover:text-blue-800 no-underline"
        >
          ← Back to Engines
        </Link>
      </div>

      {/* Header */}
      <div className="mb-6 sm:mb-8">
        <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold mb-2 sm:mb-3 text-gray-800">
          {config.title} Leaderboard
        </h1>
        <p className="text-base text-gray-600 mb-4">
          {config.description}
        </p>
      </div>

      {leaderboardData && (
        <div>
          {/* Leaderboard Table */}
          <div className="mb-6 sm:mb-8">
            <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
              <DataTable
                columns={[
                  {
                    name: 'Rank',
                    selector: (row) => {
                      // Find the rank based on the original sorted order (by score)
                      const sortedEngines = [...leaderboardData.engines].sort((a, b) => b.score - a.score);
                      return sortedEngines.findIndex(engine => engine.configName === row.configName) + 1;
                    },
                    sortable: true,
                    width: '80px',
                    wrap: true,
                  },
                  {
                    name: 'Engine',
                    selector: row => row.engineName,
                    sortable: true,
                    grow: 2,
                    wrap: false,
                    minWidth: '250px',
                    cell: (row) => (
                      <div className="flex items-center gap-2 flex-nowrap">
                        <Link 
                          to={`/engines/${row.engineName}`}
                          className="text-blue-600 hover:text-blue-800 no-underline font-medium whitespace-nowrap"
                        >
                          {row.engineName}
                        </Link>
                        <span className="inline-block px-2 py-1 text-xs font-medium bg-gray-100 text-gray-600 rounded whitespace-nowrap flex-shrink-0">
                          {row.llmModel}
                        </span>
                      </div>
                    ),
                  },
                  {
                    name: 'Overall Score',
                    selector: row => row.score,
                    sortable: true,
                    format: row => row.score.toFixed(3),
                    width: '140px',
                    wrap: true,
                  },
                  ...leaderboardData.categories.map(category => ({
                    name: (
                      <div className="flex items-center justify-between gap-1 w-full">
                        <span className="truncate">{camelCaseToWords(category)}</span>
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate(`/evals/${encodeURIComponent(leaderboardData.categoryFirstTests[category].category)}/${encodeURIComponent(leaderboardData.categoryFirstTests[category].group)}/${encodeURIComponent(leaderboardData.categoryFirstTests[category].testName)}`);
                          }}
                          className="px-1.5 py-0.5 text-xs bg-blue-100 text-blue-600 hover:bg-blue-200 hover:text-blue-800 rounded whitespace-nowrap flex-shrink-0"
                          title="View test details"
                        >
                          View
                        </button>
                      </div>
                    ),
                    selector: row => row[category] || 0,
                    sortable: true,
                    format: row => row[category].toFixed(3),
                    minWidth: '200px',
                    wrap: true,
                  })),
                  {
                    name: 'Speed (Total Seconds)',
                    selector: row => row.speed,
                    sortable: true,
                    format: row => Math.round(row.speed),
                    width: '180px',
                    wrap: true,
                  },
                ]}
                data={leaderboardData.engines}
                defaultSortFieldId={3} // Default sort by Overall Score
                defaultSortAsc={false}
                pagination={false}
                highlightOnHover
                striped
                responsive
                customStyles={{
                  table: {
                    style: {
                      minWidth: '100%',
                      border: 'none',
                    },
                  },
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
                      borderRight: '1px solid #e5e7eb',
                      whiteSpace: 'nowrap',
                      overflow: 'visible',
                      '@media (max-width: 768px)': {
                        padding: '6px 8px',
                        fontSize: '12px',
                      },
                    },
                  },
                  cells: {
                    style: {
                      padding: '10px 12px',
                      fontSize: '14px',
                      color: '#374151',
                      borderRight: '1px solid #e5e7eb',
                      borderBottom: '1px solid #e5e7eb',
                      whiteSpace: 'nowrap',
                      overflow: 'visible',
                      '@media (max-width: 768px)': {
                        padding: '8px 8px',
                        fontSize: '12px',
                      },
                    },
                  },
                  rows: {
                    style: {
                      minHeight: '48px',
                      '&:hover': {
                        backgroundColor: '#f3f4f6',
                      },
                    },
                  },
                }}
              />
            </div>
          </div>

          {/* Performance vs Speed Chart */}
          <div className="mb-6 sm:mb-8">
            <h2 className="text-xl sm:text-2xl font-bold mb-3 sm:mb-4 text-gray-800">Performance vs. Speed Curve</h2>
            <div className="bg-white p-2 sm:p-4 border border-gray-200 rounded-lg overflow-hidden">
              <div className="w-full" style={{ minHeight: '500px' }}>
                <Plot
                  data={[
                    {
                      x: leaderboardData.engines.map(e => e.score),
                      y: leaderboardData.engines.map(e => e.speed),
                      text: leaderboardData.engines.map(e => e.engineName === 'qualitative-zero' ? `${e.llmModel}` : `${e.engineName} (${e.llmModel})`),
                      mode: 'markers+text',
                      type: 'scatter',
                      textposition: 'right center',
                      marker: { 
                        size: 12,
                        opacity: 0.7,
                        color: leaderboardData.engines.map(e => e.engineName === 'qualitative-zero' ? 'rgba(102, 102, 102, 0.8)' : 'rgba(186, 72, 72, 0.82)'),
                        line: {
                          width: 0,
                        }
                      },
                      textfont: {
                        size: 10,
                      }
                    }
                  ]}
                  layout={{
                    autosize: true,
                    xaxis: { 
                      title: { 
                        text: 'Score (% correct)',
                        standoff: 20
                      }, 
                      range: [0, 1.13],
                      showgrid: true,
                      gridcolor: 'rgba(0,0,0,0.1)'
                    },
                    yaxis: { 
                      title: { 
                        text: 'Speed (total seconds)',
                        standoff: 20
                      },
                      type: 'log',
                      showgrid: true,
                      gridcolor: 'rgba(0,0,0,0.1)'
                    },
                    margin: { 
                      t: 10,
                      r: 30, 
                      b: 40, 
                      l: 80 
                    },
                    font: {
                      family: "system-ui, -apple-system, sans-serif",
                      size: 12
                    },
                    responsive: true,
                    showlegend: false,
                    hovermode: 'closest',
                    plot_bgcolor: 'rgba(0,0,0,0)',
                    paper_bgcolor: 'rgba(0,0,0,0)'
                  }}
                  config={{ 
                    displayModeBar: false,
                    responsive: true,
                    displaylogo: false,
                    modeBarButtonsToRemove: ['pan2d', 'lasso2d', 'select2d', 'resetScale2d']
                  }}
                  style={{ width: '100%', height: '800px' }}
                  useResizeHandler={true}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Leaderboard;
