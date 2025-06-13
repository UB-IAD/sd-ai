import express from 'express'
import config from './config.js'
import cors from 'cors'

import v1Initialize from './routes/v1/initialize.js'
import v1Engines from './routes/v1/engines.js'
import v1EngineParameters from './routes/v1/engineParameters.js'
import v1EngineGenerate from './routes/v1/engineGenerate.js'

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

app.listen(config.port, () => {
  console.log(`ai-proxy-service listening on port ${config.port}`);
});
