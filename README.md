# SD-AI
Open source repository for the [SD-AI Project](https://ub-iad.github.io/sd-ai/). 

Contains the engines used by [Stella](https://www.iseesystems.com/store/products/stella-architect.aspx) & [CoModel](https://comodel.io), evaluations used to test those engines and a frontend used to explore those evaluations and engines.

# Architecture and Data Structures 
- sd-ai is a NodeJS Express app with simple JSON-encoded HTTP API
- all AI functionality in sd-ai is implemented as an "engine"
- an engine is a javascript class that can implement ai functionality using any libraries/apis supported by javascript
    - `/engines` folder contains examples including the simplest possible engine: `predprey` and engines like `qualitative`, `quantitative`, and `seldon`
- sd-ai wraps engines to provides endpoints to:
    - list all engines
    - list parameters required/supported by each specific engine
    - generating a model using a specific engine
- all engines can be automatically tested for quality using `evals`

## Engine
- an engine only needs to do 2 things:
    - provide a function to generate a model based on a prompt
    - tell us what additional parameters users can pass to it

### Additional Parameters
- defined via `additionalParameters()` function on each engine class
- format specifically crafted to allow your engine to be automatically incorporated into the Stella GUI and the sd-ai website

#### API Example
- `GET` `/api/v1/engines/:engine/parameters`
- Returns 
```
{ 
    success: <bool>, 
    parameters:[{
        name: <string, unique name for the parmater that is passed to generate call>,
        type: <string, string|number|boolean>,
        required: <boolean, whether or not this parameter must be passed to the generate call>,
        uiElement: <string, type of UI element the client should use so that the user can enter this value.  Valid values are textarea|lineedit|password|combobox|hidden|checkbox>,
        label: <string, name to put next to the UI element in the client>,
        description: <string, description of what this parameter does, used as a tooltip or placeholder text in the client>,
        defaultValue: <string, default value for this parameter if there is one, otherwise skipped>,
        options: <array, of objects with two attributes 'label' and 'value' only used if 'uiElement' is combobox>,
        saveForUser: <string, whether or not this field should be saved for the user by the client, valid values are local|global leave unspecified if not saved>,
        minHeight: <int, NOT REQUIRED, default 100 only relevant if 'uiElement' is textarea -- this is the minimum height of that text area>,
        maxHeight: <int, NOT REQUIRED, default intmax, only relevant if 'uiElement' is textarea -- this is the maximum height of that text area>
    }] 
}
```

### Generate
- does the job of diagram generation, it's the workhorse of the engine
- defined via `generate(prompt, currentModel, parameters)` function on each engine class
- a complete diagram should be returned by each request, even if that just means returning an empty diagram or the same diagram the user passed in via `currentModel`
  
#### API Example
- `POST` `/api/v1/:engine/generate`
- JSON data
```
{
    "prompt": "", # Requested model or changes to model to be provided to the AI
    "currentModel": { "relationships": [], "variables": []} # Optional sd-json representation of the current model
    ....
    # additionalParameters given by `/api/v1/:engine/parameters`
}
```
- Returns
```
{
    success: <bool>,
    model: {variables: [], relationships: [], specs?: {} },
    supportingInfo?: {} # only provided if supported by engine
}
```

## SD-JSON
```
{
    variables: [{
        name: <string>,
        type: <string>, # stock|flow|variable
        equation?: <string>,
        documentation?: <string>,
        units?: <string>,
        inflows?: Array<string>,
        outflows?: Array<string>,
        dimensions?: Array<string>, # Array of dimension names for arrayed variables
        arrayEquations?: [{ # Used for arrayed variables with element-specific equations
            equation: <string>,
            forElements: Array<string> # Array element names matching dimensions
        }],
        crossLevelGhostOf?: <string>, # For modular models: references source variable
        graphicalFunction?: {
            points: [
                {x: <number>, y: <number>}
                ...
            ]
        }
    }],
    relationships: [{
        reasoning?: <string>, # Explanation for why this relationship is here
        from: <string>, # The variable the connection starts with
        to: <string>, # The variable the connection ends with
        polarity: <string>, # "+" or "-" or ""
        polarityReasoning?: <string> # Explanation for why this polarity was chosen
    }],
    modules?: [{ # Module definitions for hierarchical model organization
        name: <string>, # Simple module name (alphanumeric + underscores only)
        parentModule: <string> # Parent module name (empty string if top-level)
    }],
    specs?: {
        startTime: <number>,
        stopTime: <number>,
        dt?: <number>,
        timeUnits?: <string>,
        arrayDimensions?: [{ # Array dimension definitions
            name: <string>, # Singular, alphanumeric dimension name
            type: <string>, # "labels" or "numeric"
            size: <number>, # Number of elements in dimension
            elements: Array<string> # Element names for this dimension
        }]
    }
}
```
? denotes an optional attribute

### Arrays in SD-JSON
Variables can be arrayed over one or more dimensions to create multi-dimensional arrays:
- **Dimensions**: Defined in `specs.arrayDimensions` with name, type (labels/numeric), size, and elements
- **Arrayed Variables**: Reference dimensions by name in their `dimensions` array (order matters)
- **Array Equations**:
  - If all elements use the SAME formula: uses `equation` field only
  - If elements have DIFFERENT formulas: uses `arrayEquations` array with element-specific equations

### Modules in SD-JSON
Models can be organized into modules for better structure and encapsulation:
- **Module Definition**: Modules are defined in the top-level `modules` array:
  - `name`: Simple module name (alphanumeric + underscores, no spaces, never module-qualified)
  - `parentModule`: Name of containing module (empty string for top-level modules)
  - Modules can be nested to create hierarchical structures
- **Module Naming in Variables**: Use dot notation: `ModuleName.variableName` (e.g., `Hares.population`, `Lynx.births`)
- **Ghost Variables**: For inter-module references, create cross-level ghost variables:
  - Set `crossLevelGhostOf` to the fully qualified source variable name
  - Leave `equation` field empty (empty string)
  - Ghost variable has same local name as source but exists in consuming module
  - All equations in consuming module reference the ghost, not the original source

## Discussion Engine JSON response
```
{
    output: {
        textContent: <string, the response to the query from the user>
    }
}
```  

## Discussion Engine Feedback JSON input
```
{
    feedbackLoops: [{
        identifier: <string>,
        name: <string>,
        links: [
            { from: <string>, to: <string>, polarity: <string - +|-|? > }
            ...
        ],
        polarity: <string +|-|?>,
        loopset?: <number> 
        “Percent of Model Behavior Explained By Loop”?: [
            { time: <number>, value: <number> }
            ...
        ]
    }],
    dominantLoopsByPeriod?: [{
        dominantLoops: Array<string>,
        startTime: <number>,
        endTime: <number>
    }]   
}
```

# Setup
1. fork this repo and git clone your fork locally
2. create an `.env` file at the top level which has the following keys:
```
OPENAI_API_KEY="sk-asdjkshd" # if you're doing work with engines that use the LLMWrapper class in utils.js (quantitative, qualitative, seldon, etc.)
GOOGLE_API_KEY="asdjkshd" # if you're doing work with engines using Gemini models (causal-chains, seldon, quantitative, qualitative)
AUTHENTICATION_KEY="my_secret_key" # only needed for securing publically accessible deployments. Requires client pass an Authentication header matching this value. e.g. `curl -H "Authentication: my_super_secret_value_in_env_file"` to the engine generate request only
REPORTER_URL="https://your-metrics-server.com/api/metrics" # optional URL to POST engine usage metrics to. If not set, metrics reporting is disabled.
```
3. npm install 
4. npm start
5. (optional) npm run evals -- -e evals/experiments/careful.json
6. (optional) npm test
7. (optional) npm test:coverage

We recommend VSCode using a launch.json for the Node type applications (you get a debugger, and hot-reloading)

If you wish to run using the causal-chains engine you'll need to install the [Go toolchain](https://go.dev/doc/install) onto your PATH.

## Metrics Reporting
SD-AI includes optional metrics reporting via the `GenerateMetricsReporter` class. When enabled, it automatically tracks and reports usage data for every engine generation request.

### Configuration
Set the `REPORTER_URL` environment variable in your `.env` file to enable metrics reporting:
```
REPORTER_URL="https://your-metrics-server.com/api/metrics"
```

If `REPORTER_URL` is not set or is empty, metrics reporting is disabled and no HTTP requests are made.

### Reported Metrics
For each call to `/api/v1/:engine/generate`, the following JSON data is posted to the configured URL:
```json
{
  "engine": "quantitative",
  "underlyingModel": "gpt-4o-mini",
  "duration": 1234,
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

**Fields:**
- `engine` (string): The name of the engine used (e.g., "quantitative", "qualitative", "seldon")
- `underlyingModel` (string|null): The underlying LLM model specified in the request body, or null if not provided
- `duration` (number): Time in milliseconds for the generate call to complete
- `timestamp` (string): ISO 8601 timestamp of when the report was generated

The reporter sends metrics asynchronously and will not block or affect the engine response, even if the reporting endpoint is unavailable.

## Testing
### Unit Tests
Unit tests are provided for:
- **HTTP API routes** in `/routes/v1` folder:
  - `engineParameters.test.js` - Validates that all engines return correct parameters
  - `engineGenerate.test.js` - Tests model generation endpoints with authentication, parameter validation, and response structure
  - `engines.test.js` - Tests engine listing and metadata endpoints
- **Engine implementations** in `/engines` folder:
  - `QuantitativeEngineBrain.test.js` - Tests quantitative model generation and LLM setup
  - `QualitativeEngineBrain.test.js` - Tests qualitative diagram generation
  - `SeldonBrain.test.js` - Tests discussion engine functionality
- **Evaluation methods** in `/evals/categories` - Tests cover causal relationship evaluation, conformance validation, and quantitative model assessment
- **Model output evaluation** in `/evals/model_output_evaluation` - Standalone tools for classifying System Dynamics model output (time series) into behavioral patterns like exponential growth, oscillation, or S-shaped growth

Run tests with:
```bash
npm test
```

Generate code coverage report with:
```bash
npm run test:coverage
```

Tests are built using Jest and Supertest, and use the actual engine implementations (no mocking) to ensure real-world functionality.

## Evals
- checkout the [Evals README](evals/README.md)
- for model output behavior classification, see [Model Output Evaluation](evals/model_output_evaluation/behavioral_evaluation_using_ists/README.md)

  
# Inspiration and Related Work
- https://github.com/bear96/System-Dynamics-Bot served as departure point for engine prompt development
- [CoModel](https://comodel.io) created by the team at [Skip Designed](https://skipdesigned.com/) to use Generative AI in their CBSD work
