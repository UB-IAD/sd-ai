import { lazy, Suspense } from 'react';
import { HashRouter as Router, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';

// Lazy-load pages so heavy dependencies (Plotly on the leaderboard) and the
// large generated eval data only download when their route is visited.
const Home = lazy(() => import('./pages/Home'));
const EnginesList = lazy(() => import('./pages/EnginesList'));
const EngineDetail = lazy(() => import('./pages/EngineDetail'));
const Agents = lazy(() => import('./pages/Agents'));
const AgentDetail = lazy(() => import('./pages/AgentDetail'));
const EvalsList = lazy(() => import('./pages/EvalsList'));
const EvalDetail = lazy(() => import('./pages/EvalDetail'));
const AgentEvalsGuide = lazy(() => import('./pages/AgentEvalsGuide'));
const Leaderboard = lazy(() => import('./pages/Leaderboard'));
const LeaderboardsList = lazy(() => import('./pages/LeaderboardsList'));
const GetInvolved = lazy(() => import('./pages/GetInvolved'));

function App() {
  return (
    <Router basename="/">
      <Layout>
        <Suspense
          fallback={<div className="p-8 text-center text-gray-500">Loading…</div>}
        >
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/engines" element={<EnginesList />} />
            <Route path="/engines/:engineName" element={<EngineDetail />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/agents/:agentId" element={<AgentDetail />} />
            <Route path="/evals" element={<EvalsList />} />
            <Route path="/evals/agents" element={<AgentEvalsGuide />} />
            <Route path="/evals/:category/:group/:testname" element={<EvalDetail />} />
            <Route path="/leaderboards" element={<LeaderboardsList />} />
            <Route path="/leaderboard/:mode" element={<Leaderboard />} />
            <Route path="/get-involved" element={<GetInvolved />} />
          </Routes>
        </Suspense>
      </Layout>
    </Router>
  );
}

export default App;
