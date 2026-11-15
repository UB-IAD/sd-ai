import express from 'express'
import config from './config.js'
import cors from 'cors'
import logger from './utilities/logger.js'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'

import v1Initialize from './routes/v1/initialize.js'
import v1Engines, { warmEngineCache } from './routes/v1/engines.js'
import v1EngineParameters from './routes/v1/engineParameters.js'
import v1EngineGenerate from './routes/v1/engineGenerate.js'
import v1EvalsList from './routes/v1/evalsList.js'
import v1EvalsTestDetails from './routes/v1/evalsTestDetails.js'
import v1Leaderboard from './routes/v1/leaderboard.js'
import v1AcpManifest from './routes/v1/acpManifest.js'
import { start as startAcpManifest } from './acp/manifestStore.js'

import { createHealthRouter } from './routes/health.js';
import versionRouter from './routes/version.js';

import { SessionManager } from './agent/utilities/SessionManager.js'
import { WebSocketHandler } from './agent/WebSocket.js'

const app = express()

app.use(cors())
app.use(express.json({limit: '50mb'}));
app.use(express.urlencoded({limit: '50mb', extended: true }));

if (app.get('env') === 'production') {
  app.set('trust proxy', 1) // trust first proxy
}

// Initialize Session Manager (before routes)
const sessionManager = new SessionManager();

app.use('/', createHealthRouter(sessionManager));
app.use('/', versionRouter);


const apiRouter = express.Router();
apiRouter.use("/initialize", v1Initialize);
apiRouter.use("/engines", v1Engines);
apiRouter.use("/engines/", v1EngineParameters); //:engine/parameters
apiRouter.use("/engines/", v1EngineGenerate); //:engine/generate
apiRouter.use("/evals", v1EvalsList);
apiRouter.use("/evals", v1EvalsTestDetails);
apiRouter.use("/leaderboard", v1Leaderboard);
apiRouter.use("/acp", v1AcpManifest); // ACP manifest for client applications

app.use("/api/v1", apiRouter);

// Rebuilt from this deployment's own agent configs on every start (see acp/manifestStore.js).
startAcpManifest();

// Create HTTP server for REST API
const server = createServer(app);

// Determine if WebSocket should run on same or separate port
const useSamePort = config.port === config.websocketPort;

// Create WebSocket server (either on same server or separate server)
let wsHttpServer;
let wss;

if (useSamePort) {
  // WebSocket on the same HTTP server as REST API
  wss = new WebSocketServer({
    server: server,
    path: '/api/v1',
    maxPayload: config.websocketMaxPayloadBytes
  });
} else {
  // WebSocket on a separate HTTP server and port
  wsHttpServer = createServer();
  wss = new WebSocketServer({
    server: wsHttpServer,
    path: '/api/v1',
    maxPayload: config.websocketMaxPayloadBytes
  });
}

wss.on('connection', (ws) => {
  new WebSocketHandler(ws, sessionManager);
});

function shutdown(signal) {
  logger.log(`${signal} received, shutting down gracefully...`);
  // Kill all worker child processes first — ws.close() is async and process.exit()
  // fires before #onClose can run #killWorker, so workers would otherwise be orphaned.
  WebSocketHandler.killAll();
  wss.clients.forEach(ws => ws.close(1000, 'Server shutting down'));
  sessionManager.shutdown();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Probe each engine's supportedModes() (some spawn python/docker) before taking traffic
const warmStart = Date.now();
await warmEngineCache();
logger.log(`engine list warmed in ${Date.now() - warmStart} ms`);

// Start HTTP server
server.listen(config.port, () => {
  logger.log(`ai-proxy-service listening on port ${config.port}`);
  if (useSamePort) {
    logger.log(`WebSocket server available at ws://localhost:${config.port}/api/v1`);
  }
});

// Start WebSocket server on separate port if needed
if (!useSamePort) {
  wsHttpServer.listen(config.websocketPort, () => {
    logger.log(`WebSocket server listening on port ${config.websocketPort}`);
    logger.log(`WebSocket server available at ws://localhost:${config.websocketPort}/api/v1`);
  });
}
