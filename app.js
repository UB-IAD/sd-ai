import express from 'express'
import config from './config.js'
import cors from 'cors'
import logger from './utilities/logger.js'

import v1Initialize from './routes/v1/initialize.js'
import v1Engines from './routes/v1/engines.js'
import v1EngineParameters from './routes/v1/engineParameters.js'
import v1EngineGenerate from './routes/v1/engineGenerate.js'
import v1EvalsList from './routes/v1/evalsList.js'
import v1EvalsTestDetails from './routes/v1/evalsTestDetails.js'
import v1Leaderboard from './routes/v1/leaderboard.js'

const app = express()

app.use(cors())
app.use(express.json({limit: '50mb'}));
app.use(express.urlencoded({limit: '50mb', extended: true }));

if (app.get('env') === 'production') {
  app.set('trust proxy', 1) // trust first proxy
}

app.use("/api/v1/initialize", v1Initialize);
app.use("/api/v1/engines", v1Engines);
app.use("/api/v1/engines/", v1EngineParameters); //:engine/parameters
app.use("/api/v1/engines/", v1EngineGenerate); //:engine/generate
app.use("/api/v1/evals", v1EvalsList);
app.use("/api/v1/evals", v1EvalsTestDetails);
app.use("/api/v1/leaderboard", v1Leaderboard);

app.listen(config.port, () => {
  logger.log(`ai-proxy-service listening on port ${config.port}`);
});
