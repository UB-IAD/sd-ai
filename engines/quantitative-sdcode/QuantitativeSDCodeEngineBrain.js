import projectUtils from '../../utilities/utils.js'
import { LLMWrapper } from '../../utilities/LLMWrapper.js'
import { marked } from 'marked';
import logger from '../../utilities/logger.js';

class ResponseFormatError extends Error {
    constructor(message) {
        super(message);
        this.name = "ResponseFormatError";
    }
}

class SDCodeError extends Error {
    constructor(message, lineNum) {
        super(`Error on line ${lineNum} - ${message}`);
        this.name = "SDCodeError";
    }
}

class QuantitativeSDCodeEngineBrain {
    static SDCODE_INTRO=
`
To construct SFD models, you will output a program written in a language called SDCode. 
SDCode uses a syntax similar to that of the programming language Python.
Please output your SDCode program in a markdown code block using triple backticks at the start and end;
you will receive an error message if you do not do so as the program cannot be parsed otherwise.

Below is a sample program that highlights all of the syntax rules of SDCode.
`
    static SDCODE_SYNTAX_BASIC=
`
### WRITING COMMENTS: Comments work the exact same they do in Python.
# IMPORTANT: When using comments to explain the reasoning for a created variable/relationship, append the comment directly to the end of the code line, to ensure it is recognized correctly.
# Comments never directly affect how a simulation runs. However, please add a comment after every declaration of a component in order to document the reason behind its creation.
# Make sure to explain what role the component serves in a simulation; do not merely repeat that the component is being created.

### STRINGS
# Strings should always be delimited by double quotation marks "like this".
# You CANNOT use double quotation marks inside strings, even with backslashing;
# if you need to for whatever reason, use a single quotation mark instead " 'like this' ".

### SIMULATION SETUP
# The setup command listed below sets up the parameters that define how the model simulation should run.
# All SDCode programs must include this command exactly once.
# setup takes five required arguments. In order, they are:
# timeUnits - A string indicating the unit of time for this model. This should match with the equations that you generate.
# startTime - A number indicating the time at which this model starts calculating. It is measured in the units of "timeUnits".
# stopTime - A number indicating the time at which this model stops calculating. It is measured in the units of "timeUnits". 
# timeStep - A number indicating the time step for the model, how often is it calculated. The most common dt is 0.25. It is measured in the units of "timeUnits".
# integrationMethod - Either the string "Euler" or "RK4", indicating the method used to solve this model. "Euler" is the default, Use "RK4" for systems with oscillations.
setup("year", 0, 10.0, 0.25, "Euler")

### NAMING COMPONENTS
# Model components are identified by a unique name.
# This name is allowed to comprise only of alphabetical characters, spaces, and the "_" character.
# Unlike python, when defining and referencing these components, the name must be wrapped in [square brackets].

### COMPONENT TYPES
# There are three main component types - stocks, flows, and variables. 
# A stock is an accumulation of its flows, it is an integral. A stock can only change because of its flows. 
# A flow is the derivative of a stock. 
# A plain variable is used for algebraic expressions.

### CREATING VARIABLES
# The single argument taken is a string describing the unit.
[varA] = Variable("units") # reasoning for creating [varA]
[variable b] = Variable("units") # reasoning for creating [variable b]
[variable_c] = Variable("units") # reasoning for creating [variable_c]

### DEFINING EQUATIONS
# Set the XMILE equation for a component with the .setEquation method. This takes one argument, the XMILE equation as a string.
# Every component must have exactly one XMILE equation defined for it somewhere in the simulation (although it does not need to be immediately after declaration).
# This equation can be a number, or an algebraic expression of other variables.
# Refer to other variables with their name, without brackets; if the name of a variable contains spaces, replace them with underscores in the equation.
# NEVER use IF THEN ELSE or conditional functions inside of equations. 
# If you want to check for division by zero use the operator //
# STOCKS ONLY: The .setEquation method sets the **initial value** of the stock. The equations for flows are automatically applied; you do not need to manually make any INTEG calls.
[varA].setEquation("10") # [varA] is set to the numeric value of 10
[variable b].setEquation("5*varA") # [variable b] is set to be 5 times [varA]
[variable_c].setEquation("varA + variable_b") # [variable_c] is set to be the sum of [varA] and [variable b]. Note the underscore replacement in the equation

### CREATING STOCKS
# The single argument taken is a string describing the unit.
[stockA] = Stock("units")
[stockA].setEquation("100") # [stockA] has an initial value of 100
[stockB] = Stock("units")
[stockB].setEquation("0") # [stockB] has an initial value of 0

### CREATING FLOWS
# The single argument taken is a string describing the unit.
[flowA] = Flow("units")
[flowB] = Flow("units")
[flowA].setEquation("variable_b")
[flowB].setEquation("variable_c*stockA")

### UNIFLOW FLOWS
# By default, all flows are bi-directional.
# Use the .setUniflow method on flows to prevent them from going negative.
# A uniflow flow represents a one-directional process that can only add to or subtract from a stock in one direction.
# If set to uniflow, the flow will be constrained to be non-negative during simulation - if the equation would produce a negative value, it will be set to zero instead.
# Common examples of uniflow flows: births, deaths, purchases, production. 
# Common examples of non-uniflow flows: net migration, balance adjustments, corrections.
[flowA].setUniflow()

### SETTING FLOWS
# Use the .addInflow and .addOutflow methods on a stock to attach flows.
# CRITICAL: A flow can never be both an inflow and outflow of the same stock.
# (However, it is ok for a flow to be the inflow of one stock and the outflow of a different stock.)
[stockA].addInflow([flowA])
[stockA].addOutflow([flowB])
[stockB].addInflow([flowB])

### SPECIFYING RELATIONSHIPS
# You should specify "cause-effect" relationships between every pair of components in the model.
# To do so, use the .connect method, which is available on all components.
# Call the .connect method on the "causal" component.
# The .connect method takes two arguments; the first argument is the "effect" component and is REQUIRED, and the second is an number that indicates the polarity of the relationship.
# Set this to 1 if the relationship has positive polarity, and 0 if the relationship has negative polarity.
# You can call the .connect method at any point in the model's program, provided both components have been previously defined.
[varA].connect([variable b], 1) # the reasoning for this relationship
[varA].connect([variable_c], 1)
[variable b].connect([variable_c], 1)
[variable b].connect([flowA], 1)
[variable_c].connect([flowB], 1)
[stockA].connect([flowB], 1)
[flowA].connect([stockA], 1)
[flowB].connect([stockA], 0)
[flowB].connect([stockB], 1)
`

    static SDCODE_SYNTAX_MODULES=
`
### MODULES
# You can group related components in a model into a module.
# Modules have the same naming rules as other components. The constructor takes no arguments.
[module A] = Module()
[module B] = Module()

# To create a component inside a module, use the following syntax:
[module A.population] = Stock("units")
[module A.population].setEquation("1000")
[module A.birth rate] = Variable("unitless")
[module A.birth rate].setEquation("0.1")
[module B.population] = Stock("units")
[module B.population].setEquation("500")

# You can also create submodules as so:
[module A.module C] = Module()
[module C.placeholder] = Stock("units") # Note: NOT module A.module C.placeholder

# Note the usage of a period in the component name; these ALWAYS indicate modular components and are not permitted otherwise.
# If the module has not been defined previously in the program, you will get an error.
# Additionally, note that variable names only have to be unique within their respective module.
# Consider the base model (with no module prefix) to be its own "module" for scope purposes (i.e. naming).

# Components in a module can only be connected to other components in the same module.
# To reference components in other modules, create a "ghost" component to access its value.
# Ghost components are effectively read-only.
[module A.B population] = Ghost([module B.population]) # constructor takes a single argument - the referenced component

[module A.births] = Flow("units")

# To reference modular components in equations, use the following syntax:
[module A.births].setEquation("(population + B_population) * birth_rate")
# Key takeaway: because names are unique within a module, and components in a module are scoped,
# it is not necessary to specify the parent module name in the equation. This is why the ghost component is necessary.

# Connect the flow to the stock in module A
[module A.births].setUniflow()
[module A.population].addInflow([module A.births])
[module A.population].connect([module A.births], 1)
`

    static SDCODE_SYNTAX_ARRAYS=
`
`

    static SDCODE_EXAMPLES_INTRO=
`
Here are some example models to demonstrate the usage of SDCode. These models contain minimal commenting for brevity; when generating a real model, please comment all components declarations and .connect()s appropriately.
`

    static SDCODE_EXAMPLES_BASIC=
`
Basic Water Tank Simulation:
\`\`\`
# This model simulates a water tank that receives a constant supply of rain and drains at a rate proportional to its capacity.
setup("minute", 0, 60.0, 0.25, "Euler")

[water tank capacity] = Stock("liters")
[water tank capacity].setEquation("0")

[rain rate] = Variable("liters/minute")
[rain rate].setEquation("5")
[incoming rain] = Flow("liters")
[incoming rain].setEquation("rain_rate")
[incoming rain].setUniflow()
[rain rate].connect([incoming rain], 1)
[water tank capacity].addInflow([incoming rain])
[incoming rain].connect([water tank capacity], 1) # more incoming rain causes an increase in the water tank capacity

[drain rate] = Variable("1/minute")
[drain rate].setEquation("0.1")
[draining water] = Flow("liters")
[draining water].setEquation("drain_rate")
[draining water].setUniflow()
[drain rate].connect([draining water], 1)
[water tank capacity].addOutflow([draining water])
[draining water].connect([water tank capacity], 0) # more draining water causes a decrease in the water tank capacity
\`\`\`
`

    static SDCODE_EXAMPLES_MODULES=
`
Modular Fox-Rabbit Ecosystem Simulation:
\`\`\`
# This model uses modules to simulate two animal populations (foxes and hares) in a basic ecosystem.
setup("day", 0, 365.0, 1.0, "Euler")

[foxes] = Module()
[foxes.population] = Stock("foxes")
[foxes.population].setEquation("100")

[hares] = Module()
[hares.population] = Stock("hares")
[hares.population].setEquation("1000")

# hare reproduction
[hares.birth rate] = Variable("unitless")
[hares.birth rate].setEquation("0.05")
[hares.births] = Flow("hares")
[hares.births].setEquation("population * birth_rate")
[hares.births].setUniflow()
[hares.population].addInflow([hares.births])
[hares.population].connect([hares.births], 1) # more hares = more births from reproduction
[hares.births].connect([hares.population], 1) # more hare births = more hares

# fox reproduction
[foxes.birth rate] = Variable("unitless")
[foxes.birth rate].setEquation("0.01")
[foxes.births] = Flow("foxes")
[foxes.births].setEquation("population * birth_rate")
[foxes.births].setUniflow()
[foxes.population].addInflow([foxes.births])
[foxes.population].connect([foxes.births], 1) # more foxes = more births from reproduction
[foxes.births].connect([foxes.population], 1) # more fox births = more foxes

# fox predation
[foxes.consumption] = Variable("hares/fox")
[foxes.consumption].setEquation("2")
[hares.fox population] = Ghost([foxes.population])
[hares.fox consumption] = Ghost([foxes.consumption])
[hares.deaths] = Flow("hares")
[hares.deaths].setEquation("fox_population * fox_consumption")
[hares.deaths].setUniflow()
[hares.population].addOutflow([hares.deaths])
[hares.fox population].connect([hares.deaths], 1) # more foxes = more hare deaths from predation
[hares.deaths].connect([hares.population], 0) # more deaths = less hares
\`\`\`
`

    static SDCODE_EXAMPLES_ARRAYS=
`
`

    static SDCODE_MODELING_TIPS =
`
Below are some additional tips to remember when creating models using SDCode.

SDCode allows for flexible line ordering; take advantage to create readable models! For example, the below generally lead to cleaner code:
- Avoid clumping all variable declarations at the top of the complex models
- Group logically related components in nearby lines
- Connect components and define equations near the relevant declarations, rather than all at the end of the model

These are good conventions to follow when naming components:
- Use names that are descriptive of the scenario; ideally, someone looking at the model with no context should be able to guess what the model is simulating.
    - For example, names like "apple_inventory" or "rabbit_population" are better than "inventory" and "population".
    - Do this even if the unit of the component already describes it; redundancy is OK!
        - [inventory] = Stock("apples") # bad
        - [apples] = Stock("apples") # good
        - [apple_inventory] = Stock("apples") # good
- Concise is better; avoid compound names longer than five words
- Try not to create excessive variables, especially if unnecessary
- Use neutral terminology; do not assign positive/negative connotations to components if possible

When identifying causal relationships in a provided scenario, assign a positive or negative polarity where appropriate.
- Positive polarity: Variables move together (both increase OR both decrease)
  Example 1: Decrease in cause -> decrease in effect = POSITIVE
  Example 2: Increase in cause -> increase in effect = POSITIVE
- Negative polarity: Variables move opposite (anticorrelated)
  Example 1: Decrease in cause -> increase in effect = NEGATIVE
  Example 2: Increase in cause -> decrease in effect = NEGATIVE

IMPORTANT: When modifying user-generated models, try to make as few changes to existing components as possible.
- Do not rename existing components or change their equations/units unless the user explicitly and clearly tells you to do so
- Do not delete components unless explicitly instructed to do so.
In general, ALWAYS prefer adding new components and connections rather than modifying existing ones, UNLESS the user explicitly says otherwise.
If you do make any modifications, take care when modifying existing code lines and document all changes made to them.

Double-check validity as you go: make sure the model you are creating truly represents the described scenario!
`

    static FORMULATION_ERROR_SECTION =
`
Finally, note that models given to you by the user may not be perfect or error-free. If you think that
there are errors in the model given to you by the user, please detect and correct them, and clearly indicate that you have done so.

In particular, watch out for these common errors in SFD models:
- Component Type Errors:
   - Simple sums that do not accumulate (i.e. total population calculated by adding two stocks) MUST be variables, NOT stocks
   - Remember, stocks represent accumulations via flows, while sums are algebraic calculations
- Averaging Function Errors (in XMILE equations):
   - Use the SMOOTH function for moving averages
   - Do not use DELAY1 or DELAY3 for averaging (delays only shift time, they don't average)
`

    static MENTOR_ADDITIONAL_CONCERNS =
`
Additionally, as a mentor, critically assess model completeness and guide users through questioning:
- Are all relevant variables included?
- Are there missing connections between variables that should exist?
- Work with the user to help them understand where the model might fall short
- Ensure all suggestions follow MECE principle (Mutually Exclusive, Collectively Exhaustive)
- NEVER suggest additions that duplicate existing model elements

For each stock, help the user consider if there are any missing flows which could drive important dynamics relative to their problem statement.
`

    static MENTOR_MODE_INTRO =
`You are a System Dynamics Mentor and Teacher. Generate stock and flow models from user-provided text while teaching users to understand and improve their work through Socratic questioning and constructive critique.

PEDAGOGICAL APPROACH:
Your role is to facilitate learning, NOT to provide praise. Execute these teaching principles:
- Ask probing questions that guide users to discover what could be improved in the model
- Think critically about the model and their questions to determine the right questions to ask
- Be a constant source of constructive critique
- Explain problems you identify AND ask questions to help users learn to critique models themselves
- Explicitly state when you lack confidence in your model
- Help users learn System Dynamics principles through dialogue
- Add smaller, logically connected pieces of structure incrementally to the model

CRITICAL TEACHING RESTRICTION:
NEVER identify feedback loops for the user in explanatory text. Let users discover loops themselves through your questioning.`

    static PROFESSIONAL_MODE_INTRO =
`You are a professional Systems Dynamics modeler.
Please generate stock-and-flow models (SFDs) from user-provided queries to the best of your ability.`

    static generateSystemPrompt(mentorMode, supportsArrays, supportsModules, supportsSubTypes) {
        let prompt = "";

        // Add intro based on mode
        if (mentorMode) prompt += QuantitativeSDCodeEngineBrain.MENTOR_MODE_INTRO + "\n\n";
        else            prompt += QuantitativeSDCodeEngineBrain.PROFESSIONAL_MODE_INTRO + "\n\n";

        prompt += QuantitativeSDCodeEngineBrain.SDCODE_INTRO;
        prompt += "\n```\n";

        prompt += QuantitativeSDCodeEngineBrain.SDCODE_SYNTAX_BASIC + "\n\n";
        if (supportsArrays) prompt += QuantitativeSDCodeEngineBrain.SDCODE_SYNTAX_ARRAYS;
        if (supportsModules) prompt += QuantitativeSDCodeEngineBrain.SDCODE_SYNTAX_MODULES;

        prompt += "\n```\n\n" + QuantitativeSDCodeEngineBrain.SDCODE_EXAMPLES_INTRO + "\n\n";

        prompt += QuantitativeSDCodeEngineBrain.SDCODE_EXAMPLES_BASIC;
        if (supportsArrays) prompt += "\n\n" + QuantitativeSDCodeEngineBrain.SDCODE_EXAMPLES_ARRAYS;
        if (supportsModules) prompt += "\n\n" + QuantitativeSDCodeEngineBrain.SDCODE_EXAMPLES_MODULES;

        prompt += QuantitativeSDCodeEngineBrain.SDCODE_MODELING_TIPS + "\n\n";

        if (mentorMode) prompt += QuantitativeSDCodeEngineBrain.MENTOR_ADDITIONAL_CONCERNS + "\n\n";
        prompt += QuantitativeSDCodeEngineBrain.FORMULATION_ERROR_SECTION;
        
        return prompt;
    }

    static MENTOR_SYSTEM_PROMPT = QuantitativeSDCodeEngineBrain.generateSystemPrompt(true, true, true)

    static DEFAULT_SYSTEM_PROMPT = QuantitativeSDCodeEngineBrain.generateSystemPrompt(false, true, true)

    static DEFAULT_ASSISTANT_PROMPT = 
`I want your response to consider the model which you have already so helpfully given to us. You should never change the name of any variable you've already given us. Your response should add new variables wherever you have evidence to support the existence of the relationships needed to close feedback loops.  Sometimes closing a feedback loop will require you to add multiple relationships.`

    static DEFAULT_BACKGROUND_PROMPT =
`Please be sure to consider the following critically important background information when you give your answer.

{backgroundKnowledge}`

    static DEFAULT_PROBLEM_STATEMENT_PROMPT = 
`The user has stated that they are conducting this modeling exercise to understand the following problem better.

{problemStatement}`

    #data = {
        backgroundKnowledge: null,
        problemStatement: null,
        openAIKey: null,
        googleKey: null,
        mentorMode: false,
        underlyingModel: LLMWrapper.BUILD_DEFAULT_MODEL,
        systemPrompt: null, // Will be generated in constructor based on mentorMode and supportsArrays
        assistantPrompt: QuantitativeSDCodeEngineBrain.DEFAULT_ASSISTANT_PROMPT,
        backgroundPrompt: QuantitativeSDCodeEngineBrain.DEFAULT_BACKGROUND_PROMPT,
        problemStatementPrompt: QuantitativeSDCodeEngineBrain.DEFAULT_PROBLEM_STATEMENT_PROMPT,
        supportsArrays: false,
        supportsModules: false,
        supportsSubTypes: false
    };

    #llmWrapper;

    constructor(params) {
        Object.assign(this.#data, params);

        // Generate system prompt based on mentor mode, array support, module support, and sub-type support if not explicitly provided
        if (!this.#data.systemPrompt) {
            this.#data.systemPrompt = QuantitativeSDCodeEngineBrain.generateSystemPrompt(
                this.#data.mentorMode,
                this.#data.supportsArrays,
                this.#data.supportsModules,
                this.#data.supportsSubTypes
            );
        }

        if (!this.#data.problemStatementPrompt.includes('{problemStatement')) {
            this.#data.problemStatementPrompt = this.#data.problemStatementPrompt.trim() + "\n\n{problemStatement}";
        }

        if (!this.#data.backgroundPrompt.includes('{backgroundKnowledge')) {
            this.#data.backgroundPrompt = this.#data.backgroundPrompt.trim() + "\n\n{backgroundKnowledge}";
        }

        this.#llmWrapper = new LLMWrapper(this.#data);
    }

    /* Sourced from quantitative engine */

    #filterInvalidRelationships(response, variablesByFoldedName) {
        const origRelationships = response.relationships || [];
        const seenPairs = new Set();
        const validRelationships = [];

        for (const relationship of origRelationships) {
            const from = relationship.from.trim();
            const to = relationship.to.trim();
            const foldedFrom = projectUtils.caseFold(from);
            const foldedTo = projectUtils.caseFold(to);

            if (foldedFrom === foldedTo) continue;

            const toVar = variablesByFoldedName.get(foldedTo);
            if (!toVar || !variablesByFoldedName.has(foldedFrom)) continue;

            if (toVar.crossLevelGhostOf && toVar.crossLevelGhostOf.length > 0) continue;

            if (from.includes('[') || to.includes('[')) continue;

            const pairKey = foldedFrom + '\x00' + foldedTo;
            if (seenPairs.has(pairKey)) continue;
            seenPairs.add(pairKey);

            const cleaned = Object.assign({}, relationship);
            cleaned.from = from;
            cleaned.to = to;
            validRelationships.push(cleaned);
        }

        response.relationships = validRelationships;
    }

    #cleanStockFlowsAndCollectUsage(stocks, variablesByFoldedName, usedFlowNames) {
        const cleanList = (list) => {
            const result = [];
            for (const flowName of list) {
                const cleaned = flowName.replace(/\[.*?\]/g, '').trim();
                if (cleaned.length === 0) continue;
                const folded = projectUtils.caseFold(cleaned);
                if (!variablesByFoldedName.has(folded)) continue;
                result.push(cleaned);
                usedFlowNames.add(folded);
            }
            return result;
        };

        for (const v of stocks) {
            if (Array.isArray(v.inflows)) v.inflows = cleanList(v.inflows);
            if (Array.isArray(v.outflows)) v.outflows = cleanList(v.outflows);
        }
    }

    #inferStockFlowsFromRelationships(response, variablesByFoldedName, usedFlowNames) {
        // LLMs like gemini-3-flash-preview don't reliably emit inflow/outflow lists for stocks,
        // so derive them from flow→stock relationships (polarity decides in vs out).
        const flowSetsByStock = new Map();

        const ensureSets = (stockVar) => {
            let sets = flowSetsByStock.get(stockVar);
            if (sets) return sets;
            if (!stockVar.inflows) stockVar.inflows = [];
            if (!stockVar.outflows) stockVar.outflows = [];
            sets = {
                inflows: new Set(stockVar.inflows.map(f => projectUtils.caseFold(f))),
                outflows: new Set(stockVar.outflows.map(f => projectUtils.caseFold(f)))
            };
            flowSetsByStock.set(stockVar, sets);
            return sets;
        };

        for (const relationship of response.relationships) {
            const toVariable = variablesByFoldedName.get(projectUtils.caseFold(relationship.to));
            if (!toVariable || toVariable.type !== 'stock') continue;
            const fromVariable = variablesByFoldedName.get(projectUtils.caseFold(relationship.from));
            if (!fromVariable || fromVariable.type !== 'flow') continue;

            const sets = ensureSets(toVariable);
            const foldedFromName = projectUtils.caseFold(fromVariable.name);
            if (sets.inflows.has(foldedFromName) || sets.outflows.has(foldedFromName)) continue;

            if (relationship.polarity === '-') {
                toVariable.outflows.push(fromVariable.name);
                sets.outflows.add(foldedFromName);
            } else {
                toVariable.inflows.push(fromVariable.name);
                sets.inflows.add(foldedFromName);
            }
            usedFlowNames.add(foldedFromName);
        }
    }

    #fixVariablesAndConvertEquations(response, usedFlowNames, variableNameMap, namesToConvert) {
        // Compile the XMILE replacement regex ONCE (skip entirely if nothing to convert).
        let combinedRegex = null;
        let replaceFn = null;
        if (namesToConvert.length > 0) {
            // Longest-first so the alternation prefers longer matches at each position.
            namesToConvert.sort((a, b) => b.length - a.length);
            const escaped = namesToConvert.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
            combinedRegex = new RegExp(
                '(?<=[\\s\\(\\[,+\\-*/^=<>]|^)(' + escaped.join('|') + ')(?=[\\s\\)\\],+\\-*/^=<>]|$)',
                'g'
            );
            replaceFn = (match) => variableNameMap.get(match) || match;
        }

        // Single pass per variable handles: orphan-flow demotion, DT→TIME, forElements
        // normalization, and XMILE replacement across equation, arrayEquations, and
        // additionalProperties.
        for (const v of response.variables) {
            if (v.type === 'flow' && !usedFlowNames.has(projectUtils.caseFold(v.name))) {
                v.type = 'variable';
            } else if (v?.graphicalFunction?.points?.length > 0 && v.equation) {
                if (v.equation.trim().toLowerCase() === 'dt') {
                    v.equation = 'TIME';
                }
            }

            if (Array.isArray(v.arrayEquations)) {
                for (const eq of v.arrayEquations) {
                    if (!Array.isArray(eq.forElements)) {
                        eq.forElements = typeof eq.forElements === 'string'
                            ? eq.forElements.split(',').map(s => s.trim())
                            : [];
                    }
                }
            }

            if (!combinedRegex) continue;

            if (typeof v.equation === 'string' && v.equation) {
                const original = v.equation;
                v.equation = original.replace(combinedRegex, replaceFn);
                if (original !== v.equation) {
                    logger.debug(`[XMILE Conversion] Variable "${v.name}": "${original}" → "${v.equation}"`);
                }
            }

            if (Array.isArray(v.arrayEquations)) {
                for (const eq of v.arrayEquations) {
                    if (typeof eq.equation === 'string' && eq.equation) {
                        const original = eq.equation;
                        eq.equation = original.replace(combinedRegex, replaceFn);
                        if (original !== eq.equation) {
                            logger.debug(`[XMILE Conversion] Variable "${v.name}"[${eq.forElements.join(',')}]: "${original}" → "${eq.equation}"`);
                        }
                    }
                }
            }

            if (v.subType && v.additionalProperties && typeof v.additionalProperties === 'object') {
                for (const key of Object.keys(v.additionalProperties)) {
                    const val = v.additionalProperties[key];
                    if (typeof val !== 'string') continue;
                    const replaced = val.replace(combinedRegex, replaceFn);
                    if (replaced !== val) {
                        v.additionalProperties[key] = replaced;
                        logger.debug(`[XMILE Conversion] Variable "${v.name}" additionalProperties.${key}: "${val}" → "${replaced}"`);
                    }
                }
            }
        }
    }
    
    #mergeModules(response, usedModules, moduleNameMapping) {
        if (!response.modules) response.modules = [];

        // Single pass: build existing-modules lookup AND honor parentModule chains
        // (a module referenced only as someone's parent is still in use).
        const existingModulesMap = new Map();
        for (const m of response.modules) {
            if (m.name) {
                const normalized = projectUtils.caseFold(m.name);
                if (!existingModulesMap.has(normalized)) {
                    existingModulesMap.set(normalized, m);
                }
            }
            if (m.parentModule && m.parentModule.trim().length > 0) {
                const normalizedParent = projectUtils.caseFold(m.parentModule);
                usedModules.add(normalizedParent);
                if (!moduleNameMapping.has(normalizedParent)) {
                    moduleNameMapping.set(normalizedParent, m.parentModule);
                }
            }
        }

        const newModules = [];
        for (const normalized of usedModules) {
            const existing = existingModulesMap.get(normalized);
            if (existing) {
                newModules.push(existing);
            } else {
                newModules.push({
                    name: moduleNameMapping.get(normalized),
                    parentModule: ""
                });
            }
        }

        response.modules = newModules;
    }

    #cleanSDJsonModel(originalResponse) {
        originalResponse.variables = originalResponse.variables || [];
        
        // Pass 1: ONE walk over variables that builds every lookup structure the
        // downstream helpers need — fold-name map, XMILE rename table, module
        // usage, and a stocks-only list to avoid filtering again in pass 2.
        const variablesByFoldedName = new Map();
        const variableNameMap = new Map();   // raw name → xmile name (spaces → underscores)
        const namesToConvert = [];           // raw names needing XMILE conversion
        const usedModules = new Set();       // fold(moduleName) for any module referenced by a variable
        const moduleNameMapping = new Map(); // fold(moduleName) → canonical capitalization
        const stocks = [];

        for (const v of originalResponse.variables) {
            if (!v.name) continue;

            variablesByFoldedName.set(projectUtils.caseFold(v.name), v);

            if (v.type === 'stock') stocks.push(v);

            if (v.name.includes(' ')) {
                variableNameMap.set(v.name, projectUtils.xmileName(v.name));
                namesToConvert.push(v.name);
            }

            if (v.name.includes('.')) {
                const parts = v.name.split('.');
                for (let i = 0; i < parts.length - 1; i++) {
                    const normalized = projectUtils.caseFold(parts[i]);
                    usedModules.add(normalized);
                    if (!moduleNameMapping.has(normalized)) {
                        moduleNameMapping.set(normalized, parts[i]);
                    }
                }
            }
        }

        this.#filterInvalidRelationships(originalResponse, variablesByFoldedName);

        // Pass 2: walk stocks only — clean inflow/outflow refs and seed the
        // used-flow set. #inferStockFlowsFromRelationships then adds any
        // additional flows it derives from relationships.
        const usedFlowNames = new Set();
        this.#cleanStockFlowsAndCollectUsage(stocks, variablesByFoldedName, usedFlowNames);
        this.#inferStockFlowsFromRelationships(originalResponse, variablesByFoldedName, usedFlowNames);

        // Pass 3: combined per-variable mutation pass — flow-type fixup,
        // DT→TIME, forElements normalization, and XMILE rewriting.
        this.#fixVariablesAndConvertEquations(originalResponse, usedFlowNames, variableNameMap, namesToConvert);

        // No variable loop needed — module usage was already collected in pass 1.
        this.#mergeModules(originalResponse, usedModules, moduleNameMapping);

        return originalResponse;
    }

    /* SDCode-specific helpers */

    #splitArgsByComma(str) {
        const args = [];
        let cur = "";
        let depth = 0;
        let quoteChar = null;

        for (let i = 0; i < str.length; i++) {
            const char = str[i];

            if (quoteChar) {
                cur += char;
                if (char === "\\") {
                    cur += str[++i];
                    continue;
                }
                if (char === quoteChar) quoteChar = null;
                continue;
            }

            if (char === '"' || char === "'" || char === "`") {
                quoteChar = char;
                cur += char;
                continue;
            }
            if (char === "(" || char === "[" || char === "{") {
                depth++;
                cur += char;
                continue;
            }

            if (char === ")" || char === "]" || char === "}") {
                depth--;
                cur += char;
                continue;
            }

            if (char === "," && depth === 0) {
                args.push(cur.trim());
                cur = "";
                continue;
            }

            cur += char;
        }

        args.push(cur.trim());
        return args;
    }

    #extractMethodArguments(methodCall, lineNum) {
        // given a method call as a string such as "setEquation("...") # reasoning",
        // extract the method name, arguments, and attached comment (if any).
        const trimmed = methodCall.trim();
        let idx = 0;
        
        const res = {
            method: "",
            args: [],
            comment: ""
        }
        
        // extract method name
        while (idx < trimmed.length && trimmed[idx] !== "(") {
            res.method += trimmed[idx];
            idx++;
        }
        if (idx >= trimmed.length) throw new SDCodeError("syntax error (missing parentheses?)", lineNum);

        // extract method args
        idx++;
        let leftIdx = idx;
        let inString = false;
        while (idx < trimmed.length && (inString || trimmed[idx] !== ")")) {
            if (trimmed[idx] === "\"") inString = !inString;
            idx++;
        }
        if (idx >= trimmed.length) throw new SDCodeError("syntax error (missing parentheses?)", lineNum);
        const argsRaw = this.#splitArgsByComma(trimmed.slice(leftIdx, idx)).map(s => s.trim());
        for (const arg of argsRaw) {
            if (arg.length === 0 || arg === "") continue; // blank argument
            else if (arg[0] === "[") res.args.push(arg);
            else if (arg[0] === "\"") {
                if (arg.length > 1 && arg[arg.length-1] === "\"") res.args.push(arg.slice(1, arg.length - 1));
                else throw new SDCodeError("syntax error (missing quotation mark?)", lineNum);
            } else {
                const parsedArg = parseFloat(arg);
                if (isNaN(parsedArg)) {
                    throw new SDCodeError(`syntax error (argument ${arg} is neither a number, component name, or string)`, lineNum);
                }
                res.args.push(parsedArg);
            }
        }

        // extract comment
        const remainder = trimmed.slice(idx);
        if (remainder !== "") {
            const hashtagIdx = remainder.indexOf("#");
            if (hashtagIdx !== -1) {
                res.comment = remainder.slice(hashtagIdx+1).trim();
            }
        }

        return this.#cleanSDJsonModel(res);
    }

    #verifyArgumentTypes(args, types, lineNum) {
        if (args.length !== types.length) {
            throw new SDCodeError(`expected ${types.length} arguments but got ${args.length}`, lineNum);
        }
        for (const idx in args) {
            const a = args[idx];
            const b = types[idx];
            if (Array.isArray(b)) {
                if (!b.includes(a)) throw new SDCodeError(`argument ${idx+1} must be one of [${b.join(",")}], but got ${a}`, lineNum);
            } else {
                if (typeof(a) != typeof(b)) throw new SDCodeError(`argument ${idx+1} should be ${typeof(b)}, but got ${a}`, lineNum);
            }
        }
    }

    #cleanComponentName(name, lineNum) {
        if (name.length <= 2) throw new SDCodeError(`invalid component name ${name} (missing brackets + too short?)`, lineNum);
        if (name[0] !== "[" || name[name.length-1] !== "]") {
            throw new SDCodeError(`invalid component name ${name} (should be contained in [square brackets])`, lineNum);
        }
        const splicedName = name.slice(1, name.length-1);
        if (!/^[a-zA-Z0-9_ .]+$/.test(splicedName)) {
            throw new SDCodeError(`invalid component name ${name} (only alphanumeric chars, _, periods, and spaces allowed`, lineNum);
        }
        return splicedName;
    }

    async processResponse(originalResponse) {
        const program = originalResponse.program.split(/\r?\n|\r|\\r?\\n|\\r/).map(s => s.trim());
        const explanation = await marked.parse(originalResponse.explanation);

        logger.debug("===  OUTPUT MODEL ===");
        for (const line of program) {
            logger.debug(line);
        }

        const simSpecs = {
            startTime: null,
            stopTime: null,
            dt: null,
            timeUnits: null,
            integrationMethod: null,
            arrayDimensions: [] // TODO: Unimplemented
        }
        const mdl = {
            variables: [],
            relationships: [],
            explanation: explanation,
            title: originalResponse.title,
            specs: simSpecs,
            modules: []
        }

        let lineNum = 0;
        for (const line of program) {
            lineNum++;
            if (line.indexOf("(") === -1) continue; // no method call; ignore
            if (line[0] === "#") continue; // full comment line, ignore
            
            // shorthand for lineParsed
            const lp = this.#extractMethodArguments((line.startsWith("```") ? line.slice(3) : line), lineNum);
            // debug
            // console.log(lp);

            if (lp.method === "setup") {
                if (simSpecs.startTime !== null) {
                    throw new SDCodeError("duplicate setup command is not allowed", lineNum);
                }
                this.#verifyArgumentTypes(lp.args, ["", 0, 0, 0, ["Euler", "RK4"]], lineNum);
                simSpecs.timeUnits = lp.args[0];
                simSpecs.startTime = lp.args[1];
                simSpecs.stopTime = lp.args[2];
                simSpecs.dt = lp.args[3];
                simSpecs.integrationMethod = lp.args[4];
            } else if (lp.method.indexOf("=") !== -1) {
                const eqIndex = lp.method.indexOf("=")
                const compName = this.#cleanComponentName(lp.method.slice(0, eqIndex).trim(), lineNum);
                const compType = lp.method.slice(eqIndex+1).trim();
                
                if (compType === "Module") {
                    // no arguments
                } else if (compType !== "Stock" && compType !== "Flow" && compType !== "Variable" && compType !== "Ghost") {
                    throw new SDCodeError(`unrecognized component type ${compType}`, lineNum);
                } else {
                    this.#verifyArgumentTypes(lp.args, [""], lineNum);
                }

                if (compType.toLowerCase() === "module") {
                    mdl.modules.push(compName);
                } else {
                    mdl.variables.push({
                        name: compName,
                        documentation: lp.comment,
                        ...(compType.toLowerCase() !== "ghost" &&
                            { 
                                units: lp.args[0], 
                                type: compType.toLowerCase(), 
                                equation: ""
                            }
                        ),
                        ...(compType.toLowerCase() === "stock" && 
                            { inflows: [], outflows: [] }
                        ),
                        ...(compType.toLowerCase() === "flow" &&
                            { uniflow: false } // default false, set to true later if .setUniflow() is called
                        ),
                        ...(compType.toLowerCase() === "ghost" &&
                            {
                                crossLevelGhostOf: this.#cleanComponentName(lp.args[0], lineNum), 
                                type: "variable",
                                equation: ""
                            } 
                            
                        )
                    });
                }
            } else if (lp.method.lastIndexOf(".") !== -1) {
                const pdIndex = lp.method.lastIndexOf(".");
                const compName = this.#cleanComponentName(lp.method.slice(0, pdIndex).trim(), lineNum);
                const compMethod = lp.method.slice(pdIndex+1).trim();
                
                // This is O(N) lookup, optimize later if necessary
                let compObj = null;
                for (const comp of mdl.variables) {
                    if (comp.name === compName) {
                        compObj = comp;
                        break;
                    }
                }
                if (compObj === null) throw new SDCodeError(`component ${compName} is not defined`, lineNum);
                // ---

                if (compMethod === "setEquation") {
                    this.#verifyArgumentTypes(lp.args, [""], lineNum);
                    compObj.equation = lp.args[0];
                } else if (compMethod === "setUniflow") {
                    if (compObj.type !== "flow") throw new SDCodeError(`component ${compName} is not flow`, lineNum);
                    compObj.uniflow = true;
                } else if (compMethod === "addInflow" || compMethod === "addOutflow") {
                    if (compObj.type !== "stock") throw new SDCodeError(`component ${compName} is not stock`, lineNum);
                    this.#verifyArgumentTypes(lp.args, [""], lineNum);
                    const secondComp = this.#cleanComponentName(lp.args[0], lineNum);
                    if (compMethod === "addInflow") compObj.inflows.push(secondComp);
                    else compObj.outflows.push(secondComp);
                } else if (compMethod === "connect") {
                    this.#verifyArgumentTypes(lp.args, ["", [-1, 0, 1]], lineNum);
                    mdl.relationships.push({
                        from: compName,
                        to: this.#cleanComponentName(lp.args[0], lineNum),
                        ...(lp.args[1] !== -1 && { polarity: lp.args[1] === 1 ? "+" : "-" }),
                        reasoning: lp.comment
                    })
                } else {
                    throw new SDCodeError(`couldn't recognize this method call ${lp.method}`, lineNum);
                }
            } else {
                throw new SDCodeError(`couldn't recognize this method call ${lp.method}`, lineNum);
            }
        }

        return mdl;
    }

    mentor() {
        this.#data.mentorMode = true;
        this.#data.systemPrompt = QuantitativeSDCodeEngineBrain.generateSystemPrompt(
            this.#data.mentorMode,
            this.#data.supportsArrays,
            this.#data.supportsModules,
            this.#data.supportsSubTypes
        );
    }

    #orderStatementsByDependency(dependencies) {
        //console.log(dependencies);
        const n = dependencies.length;
        const remaining = dependencies.map((deps) => deps.size);
        const dependents = Array.from({ length: n }, () => []); // transpose of dependencies
        for (let i = 0; i < n; i++) {
            for (const dep of dependencies[i]) {
                dependents[dep].push(i);
            }
        }

        const added = new Array(n).fill(false);
        const order = [];

        const addStatement = (i) => {
            if (added[i]) return;
            added[i] = true;
            order.push(i);

            // cascade down
            for (const dependent of dependents[i]) {
                remaining[dependent]--;
                if (remaining[dependent] === 0) {
                    addStatement(dependent);
                }
            }
        };

        // add 0-dependency statements in order, cascading after each one
        for (let i = 0; i < n; i++) {
            if (remaining[i] === 0) {
                addStatement(i);
            }
        }

        // fallback: force-add all unadded statements that may be part of a dependency cycle
        for (let i = 0; i < n; i++) {
            if (!added[i]) {
                addStatement(i);
            }
        }

        //console.log(order);

        return order;
    }

    #convertToSDCode(model) {
        let cnt = -1;
        const statements = [];
        const componentDeclarations = new Map();
        const componentEquations = new Map();
        const dependencies = [];
        const dependents = [];
        
        if (Array.isArray(model.modules)) {
            for (const module of model.modules) {
                // todo: this currently doesn't work with nested modules
                cnt++;
                statements.push(`[${module.name}] = new Module()`);
                dependencies.push(new Set());
            }
        }

        // add non-ghost component declarations
        const ghostComps = [];
        for (const varObj of model.variables) {
            if (varObj.crossLevelGhostOf != null && varObj.crossLevelGhostOf.trim() !== "") {
                ghostComps.push(varObj);
                continue;
            }

            cnt++;
            statements.push(`[${varObj.name}] = ${varObj.type[0].toUpperCase() + varObj.type.slice(1)}("${varObj.units ?? "units"}")${varObj.documentation != null && varObj.documentation.trim() !== "" ? ` # ${varObj.documentation.trim()}` : ""}`)
            dependencies.push(new Set());
            componentDeclarations.set(varObj.name, cnt);
        }

        for (const varObj of ghostComps) {
            cnt++;
            statements.push(`[${varObj.name}] = Ghost([${varObj.crossLevelGhostOf.trim()}])`);
            dependencies.push(new Set());
            dependencies[cnt].add(componentDeclarations.get(varObj.crossLevelGhostOf.trim()));
            componentDeclarations.set(varObj.name, cnt);
        }

        const flowStatements = [];
        for (const varObj of model.variables) {
            cnt++;
            statements.push(`[${varObj.name}].setEquation("${varObj.equation}")`);
            dependencies.push(new Set());
            dependencies[cnt].add(componentDeclarations.get(varObj.name));
            componentEquations.set(varObj.name, cnt);

            if (varObj.type === "flow" && varObj.uniflow) {
                cnt++;
                statements.push(`[${varObj.name}].setUniflow()`);
                dependencies.push(new Set());
                dependencies[cnt].add(componentDeclarations.get(varObj.name));
            }
            if (varObj.type === "stock") {
                if (varObj.inflows !== undefined) {
                    for (const inflow of varObj.inflows) {
                        flowStatements.push([`[${varObj.name}].addInflow([${inflow}])`, varObj.name, inflow]);
                    }
                }
                if (varObj.outflows !== undefined) {
                    for (const outflow of varObj.outflows) {
                        flowStatements.push([`[${varObj.name}].addOutflow([${outflow}])`, varObj.name, outflow]);
                    }
                }
            }
        }

        for (const flst of flowStatements) {
            cnt++;
            statements.push(flst[0]);
            dependencies.push(new Set());
            dependencies[cnt].add(componentEquations.get(flst[1]));
            dependencies[cnt].add(componentEquations.get(flst[2]));
        }

        for (const rel of model.relationships) {
            cnt++;
            statements.push(`[${rel.from}].connect([${rel.to}], ${rel.polarity === "+" || rel.polarity === undefined || rel.polarity === null ? 1 : 0})${rel.reasoning != null && rel.reasoning.trim() !== "" ? ` # ${rel.reasoning.trim()}` : ""}`)
            dependencies.push(new Set());
            dependencies[cnt].add(componentDeclarations.get(rel.from));
            dependencies[cnt].add(componentDeclarations.get(rel.to));
            if (componentEquations.get(rel.from) != null) dependencies[cnt].add(componentEquations.get(rel.from));
            if (componentEquations.get(rel.to) != null) {
                dependencies[cnt].add(componentEquations.get(rel.to));
                dependencies[componentEquations.get(rel.to)].add(componentDeclarations.get(rel.from));
            }
        }

        // fallback to remove invalid dependencies
        for (let i = 0; i < dependencies.length; i++) {
            dependencies[i].delete(undefined);
            dependencies[i].delete(i);
        }

        const setupLine = `setup("${model.specs.timeUnits ?? "day"}", ${model.specs.startTime ?? 0}, ${model.specs.stopTime ?? 10.0}, ${model.specs.dt ?? 0.25}, "${model.specs.integrationMethod ?? "Euler"}")`;
        const orderedIndices = this.#orderStatementsByDependency(dependencies);
        const program = [setupLine, ...orderedIndices.map((i) => statements[i])];

        logger.debug("=== USER-PROVIDED MODEL (CONVERTED TO SDCODE) ===");
        for (const line of program) {
            logger.debug(line);
        }
        return "```\n" + program.join("\n") + "```"; 
    }
    
    setupLLMParameters(userPrompt, lastModel) {
        // build system prompt
        const { underlyingModel, systemRole, temperature, reasoningEffort } = this.#llmWrapper.getLLMParameters();
        let systemPrompt = this.#data.systemPrompt;
        let responseFormat = this.#llmWrapper.generateQuantitativeSDCodeResponseSchema(this.#data.mentorMode);

        if (!this.#llmWrapper.model.hasStructuredOutput) {
            throw new Error("Unsupported LLM " + this.#data.underlyingModel + " it does support structured outputs which are required.");
        }

        let messages = [{
            role: systemRole,
            content: systemPrompt
        }];

        if (this.#data.backgroundKnowledge) {
            messages.push({
                role: "user",
                content:  this.#data.backgroundPrompt.replaceAll("{backgroundKnowledge}", this.#data.backgroundKnowledge),
            });
        }
        if (this.#data.problemStatement) {
            messages.push({
                role: systemRole,
                content: this.#data.problemStatementPrompt.replaceAll("{problemStatement}", this.#data.problemStatement),
            });
        }

        // Check if lastModel has actual content (variables or relationships)
        if (lastModel && (lastModel.variables?.length > 0 || lastModel.relationships?.length > 0)) {
            messages.push({ 
                role: "assistant", 
                content: JSON.stringify({ 
                    program: this.#convertToSDCode(this.#cleanSDJsonModel(lastModel)),
                    explanation: ""
                }, null, 2)
            });

            if (this.#data.assistantPrompt) messages.push({ role: "user", content: this.#data.assistantPrompt });
        }

        // Give it the user prompt
        messages.push({ role: "user", content: userPrompt });

        return {
            messages,
            model: underlyingModel,
            responseFormat: responseFormat,
            temperature: temperature,
            reasoningEffort: reasoningEffort
        };
    }

    async generateModel(userPrompt, lastModel) {
        // Ensure lastModel is always defined as an empty model structure if undefined or null
        if (!lastModel || typeof lastModel !== 'object') {
            lastModel = { variables: [], relationships: [] };
        } else {
            // Ensure required arrays exist
            lastModel.variables = lastModel.variables || [];
            lastModel.relationships = lastModel.relationships || [];
        }

        logger.debug("=== USER PROMPT ===");
        logger.debug(userPrompt);

        const llmParams = this.setupLLMParameters(userPrompt, lastModel);
        const originalResponse = await this.#llmWrapper.createChatCompletion(
            llmParams.messages,
            llmParams.model,
            llmParams.responseFormat,
            llmParams.temperature,
            llmParams.reasoningEffort
        );

        // debug
        // console.log(originalResponse);

        if (originalResponse.refusal) {
            throw new ResponseFormatError(originalResponse.refusal);
        } else if (originalResponse.parsed) {
            return this.processResponse(originalResponse.parsed);
        } else if (originalResponse.content) {
            let parsedObj = { program: "", explanation: "" };
            try {
                parsedObj = JSON.parse(originalResponse.content);
            } catch (err) {
                logger.log('Bad JSON from LLM:', originalResponse);
                throw new ResponseFormatError("Bad JSON returned by underlying LLM");
            }
            return this.processResponse(parsedObj);
        } else {
            throw new ResponseFormatError("LLM response did not contain any recognized format (no refusal, parsed, or content fields)");
        }
    }
}

export default QuantitativeSDCodeEngineBrain;