import express from 'express'
import utils from './../../utils.js'

const router = express.Router()

router.post("/:engine/generate", async (req, res) => {
    const authenticationKey = process.env.AUTHENTICATION_KEY;
    if (!req.body.openAIKey && authenticationKey) {
        if (!req.header('Authentication') || req.header('Authentication') !== authenticationKey) {
          return res.status(403).send({ "success": false, err: 'Unauthorized, please pass valid Authentication header.' });
        }
    }

    const engine = await import(`./../../engines/${req.params.engine}/engine.js`);
    const instance = new engine.default();

    const prompt = req.body.prompt;
    let format = req.body.format;
  
    const engineSpecificParameters = Object.fromEntries(Object.entries(req.body).filter(([k, v]) => {
       return ["prompt", "currentModel", "format"].indexOf(k) == -1
    }));

    instance.additionalParameters().forEach((param) => {
      let uncastedValue = engineSpecificParameters[param.name];
      let castedValue = uncastedValue;
      if (uncastedValue) { //if the uncasted value is not defined skip it... only cast defined values to the proper type
        switch (param.type) {
          case "number":
            castedValue = Number(uncastedValue);
            break;

          case "boolean":
            castedValue = Boolean(uncastedValue);
            break;

          case "string":
            castedValue = uncastedValue.toString();
            break;
        }

        engineSpecificParameters[param.name] = castedValue;
      }
    });

    let currentModel = {variables: [], relationships: []};
    if ('currentModel' in req.body) {
      currentModel = req.body.currentModel
    }
  
    let generateResponse = await instance.generate(prompt, currentModel, engineSpecificParameters);
  
    if (generateResponse.err) {
      return res.send({
        success: false,
        message: "Failed to generate a diagram: " + generateResponse.err
      })
    }
  
    let model = generateResponse.model
    if (format == "xmile") {
      model = utils.convertToXMILE(model)
    } else {
      format = "sd-json";
    }
    
    let response = {
      success: true,
      format: format,
      model: model,
    }

    if ('supportingInfo' in generateResponse) {
      response.supportingInfo = generateResponse.supportingInfo
    }
  
    return res.send(response)
})

export default router;