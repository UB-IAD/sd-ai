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

class QuantitativeEngineBrain {

    static MODULE_REQUIREMENTS_SECTION =
`CRITICAL MODULAR MODEL REQUIREMENTS:

WHEN TO USE MODULES:
- DO NOT create modules unless the model already uses modules OR the user explicitly requests modular structure
- If the existing model has NO modules, build a NON-MODULAR model
- If the existing model HAS modules, maintain and extend the modular structure
- Only introduce modules when specifically asked by the user

CRITICAL VARIABLE NAMING RULE FOR MODULES:
- Variable names in modules use ONLY their immediate owning module as prefix: ModuleName.variableName
- NEVER use full hierarchy path in variable names
- CORRECT: "Sales.revenue" (even if Sales is nested within Company module)
- WRONG: "Company.Sales.revenue"
- Variables are qualified ONLY by their direct parent module, never by ancestor modules
- Module hierarchy is tracked separately in the modules array via parentModule field

WHEN USING MODULES - GHOST VARIABLE REQUIREMENTS:
When constructing modular models, you MUST create cross-level ghost variables for ALL inter-module references:
1. Create the source variable in its computation module
2. Create a cross-level ghost variable in EVERY consuming module that references the source variable
3. The ghost variable MUST have an identical local name as the source variable
4. Mark the ghost variable explicitly as: crossLevelGhostOf = <sourceVariable>
5. Ghost variables have NO equation - they reference their source variable only
6. ALL equations in the consuming module MUST reference the cross-level ghost variable, NOT the original source variable

FAILURE TO CREATE AND LINK GHOST VARIABLES WILL BREAK SIMULATION. This is non-negotiable.
REFERENCING THE ORIGINAL SOURCE VARIABLE DIRECTLY FROM A CONSUMING MODULE WILL BREAK SIMULATION. Always use the ghost.`

    static SUB_TYPE_REQUIREMENTS_SECTION =
`CRITICAL DISCRETE-ENTITY SUB-TYPE REQUIREMENTS:

WHEN TO USE DISCRETE ENTITY SUB-TYPES:
- Use sub-types ONLY when the model explicitly requires discrete-event, queue, or pipeline semantics
- DO NOT use sub-types for standard continuous stocks and flows — they add significant complexity
- Only introduce sub-types when specifically requested by the user

STOCK SUB-TYPES — set 'subType'; 'queue', 'oven' and 'conveyor' also include 'additionalProperties':
- 'queue': Waiting line. additionalProperties: fifoEnabled, oneAtATime, splitBatches, discrete, roundRobin, queueOutflowPriority, purgeEq, overflow.
- 'oven': Batch processor; all items released together after processTime. additionalProperties: processTime (required), capacity, inflowLimit, fillTime, cleanTime, sample, arrest.
- 'conveyor': Pipeline delay; items exit after processTime. additionalProperties: processTime (required), capacity, inflowLimit, sample, arrest.
- 'nonNegative': Stock that can never go below zero (the XMILE <non_negative/> constraint). No additionalProperties.

FLOW SUB-TYPES — leave 'equation' empty; automatically computed:
- 'discreteOutflow': Output from a conveyor or oven.
- 'conveyorLeakage': Leakage from a conveyor. Set additionalProperties: leakFraction (required, units of 1/time_unit when exponential, dimensionless otherwise), exponential (default true — almost always use exponential; linear only when explicitly requested), leakZoneStart, leakZoneEnd, leakIntegers, ignorePrevZones, forceLeakFraction.
- 'queueOutflow': Output from a queue.
- 'queueOverflow': Overflow from a full queue (requires overflow: true on the queue).

VARIABLE SUB-TYPE - unlike the discrete-entity sub-types above, set this whenever it applies, even when sub-types were not requested:
- 'delayVariable': A plain variable whose equation uses a DELAY or SMTH builtin (DELAY1, DELAY3, DELAY N, SMTH1, SMTH3, or any other DELAY/SMTH variant).

Set 'subType' to 'none' for every other stock, flow, and variable.

'additionalProperties' is a list of settings, each a property name and its value; leave it empty for variables with no settings.

REGULAR FLOWS entering a conveyor may set additionalProperties:
- spreadFlow: how inflow distributes along the conveyor ('none', 'even', 'destination', 'distribution', 'source').
- distribEq: required when spreadFlow is 'distribution'.

EQUATION RULES:
- 'queue', 'oven', 'conveyor', 'nonNegative' stocks: 'equation' is the initial value, like a regular stock.
- Flow sub-types: leave 'equation' empty.
- Settings go in 'additionalProperties', not equations.

RELATIONSHIP REQUIREMENTS:
- Any variable referenced in an additionalProperties expression requires a relationship arrow FROM that variable TO the element.
- Use XMILE syntax with underscores (e.g. 'service_time' not 'service time').

CONVEYOR DESIGN RULES:

When to use conveyor vs. stock:
- Use a conveyor when entities must spend a minimum or fixed duration in a stage (pipeline delay, aging, disease duration). The conveyor transit time encodes the dwell time.
- Use a plain stock when residence time is exponentially distributed (first-order delay) or when there is no minimum dwell requirement.

Leakage vs. outflow:
- 'conveyorLeakage': entities exit before completing transit (early exit). Configure via additionalProperties.leakFraction on the leakage flow.
- 'discreteOutflow': entities that completed the full transit.
- NEVER split the conveyor outflow via auxiliary arithmetic to route into different stages.

Wiring leakages:
- Every conveyorLeakage flow must appear in the outflows list of its source conveyor AND in the inflows list of its destination.

Mass conservation check:
- Sum of all population stocks at t=0 must equal sum at all t (unless the model has explicit external births/deaths).
- The conveyor's discreteOutflow is wired to exactly one destination — do not split it.`

    static ARRAY_REQUIREMENTS_SECTION =
`CRITICAL ARRAY REQUIREMENTS:

WHEN TO USE ARRAYS:
- Create array dimensions only for groups of like things that the request names as dimensions (e.g. "array Patients by Brand: A, B, C") or that the existing model already arrays
- If the existing model has NO arrays and the request names no dimension, build a NON-ARRAYED model with scalar variables only
- If the existing model HAS arrays, maintain and extend the array structure consistently
- Never invent a dimension the request does not name
- Arrays add significant complexity - use them ONLY when necessary

WHEN USING ARRAYS - DIMENSION AND EQUATION REQUIREMENTS:
When constructing models with arrayed variables, you MUST follow these rules:
1. ALL array dimensions MUST be defined in the specs.arrayDimensions list before being referenced
2. Each dimension MUST have a unique name (singular, alphanumeric only)
3. Every dimension has a type ('labels' or 'numeric'), a name, a size, and its elements:
   - 'labels' dimensions: give meaningful element names (e.g. North, South) and set size to their count
   - 'numeric' dimensions: set size; the elements are '1' through size
   - Element names use only letters and numbers - no punctuation or symbols
4. Variables reference dimensions by name in their dimensions array (order matters)
5. NEVER remove dimensions from existing arrayed variables unless explicitly directed to do so by the end user
6. Arrayed variables MUST have equations for ALL element combinations:
   - If all elements use the SAME formula: provide ONE equation in the 'equation' field
   - If elements differ: provide element-specific equations in the 'arrayEquations' array (NOT 'equation')
   - For arrayed STOCKS: you MUST provide initial values for each element using 'arrayEquations'
   - NEVER leave the 'equation' or 'arrayEquations' fields empty for any variable
7. Array element references in 'forElements' are arrays of dimension element names, ordered to match the variable's dimensions (e.g., ["North", "Q1"])
8. SUM function syntax - CRITICAL:
   - ALWAYS use asterisk (*) to represent the dimension being summed - NEVER use the dimension name
   - MANDATORY: Every SUM equation MUST contain at least one asterisk (*) - without it, the SUM is invalid
   - WRONG: SUM(Revenue[region]) or SUM(Sales[product])
   - CORRECT: SUM(Revenue[*]) to sum across all elements of a single dimension
   - CORRECT: SUM(Sales[product,*]) to sum across the second dimension of a 2D array
   - The asterisk (*) is a wildcard that means "sum over all elements of this dimension"

FAILURE TO PROPERLY DEFINE DIMENSIONS AND EQUATIONS WILL BREAK SIMULATION. This is non-negotiable.`

    static MANDATORY_PROCESS_SECTION =
`MANDATORY PROCESS - Execute these steps in order:

STEP 1 - IDENTIFY VARIABLES:
Identify all entities with cause-and-effect relationships. Name variables using these rules:
- Maximum 5 words per name
- Minimize total variable count
- Use neutral terminology (no positive/negative connotations)
- Use ONLY letters and spaces (NO symbols, NO dashes, NO arthemtic operators and NO punctuation)

STEP 2 - DEFINE CAUSAL RELATIONSHIPS:
Assign polarity to each causal relationship:
- Positive polarity (+): Variables move together (both increase OR both decrease)
  Example 1: Decrease in cause → decrease in effect = POSITIVE (+)
  Example 2: Increase in cause → increase in effect = POSITIVE (+)
- Negative polarity (-): Variables move opposite (anticorrelated)
  Example 1: Decrease in cause → increase in effect = NEGATIVE (-)
  Example 2: Increase in cause → decrease in effect = NEGATIVE (-)

STEP 3 - DETERMINE VARIABLE TYPES:
Classify each variable as one of three types:
- STOCK: Accumulations that change ONLY via their flows
- FLOW: Derivatives that change stocks (rate of change)
- VARIABLE: Auxiliary variables for algebraic expressions

CRITICAL STOCK-FLOW CONSTRAINT:
- A flow can NEVER appear in BOTH the inflows AND outflows of the same stock
- Each flow must be classified as EITHER an inflow OR an outflow for any given stock, never both

STEP 4 - WRITE EQUATIONS:
Provide equations for every variable:
- CRITICAL XMILE NAMING RULE: When referencing variables in equations, you MUST replace all spaces with underscores
- Example: If a variable is named "birth rate", reference it in equations as "birth_rate"
- Example: If a variable is named "total population", reference it in equations as "total_population"
- This is the XMILE standard and is NON-NEGOTIABLE - equations with spaces in variable names will FAIL
- CONSTANT HANDLING: All equations should be simple enough to explain in plain language and must NEVER include hard-coded physical, empirical, or arbitrary constants (e.g. 9.81, 0.05, 3.14159, 100) directly inside the equation — abstract every arbitrary value into a clearly named variable. Dimensionless numbers are permitted ONLY when they serve a fundamental structural, geometric, or algorithmic purpose in the formula: complements/inversions (e.g. 1 - x), boundary/clipping limits (e.g. MAX(0, x), MIN(1, x)), structural divisions and averages (e.g. x / 2), and constants required by standard mathematical identities (e.g. the 2 and 4 in the quadratic formula, or exponents like x^2).
- Every variable referenced in an equation MUST have its own equation, type, and appear in the relationships list
- A stock's equation is its initial value only - never use INTEG
- NEVER use IF THEN ELSE or any other conditional function inside an equation
- The // operator is available: it divides like /, but returns 0 when the denominator is 0
- UNIFLOW CONSTRAINT FOR FLOWS:
  * Mark a flow as uniflow=true when it represents a one-directional process that should never be negative
  * When uniflow=true, if the flow equation produces a negative value during simulation, it will be automatically constrained to zero
  * Common uniflow=true examples: births, deaths, purchases, production, hiring, shipments
  * Use uniflow=false for bidirectional flows that can legitimately go negative: net migration, balance adjustments, corrections
  * Setting uniflow correctly prevents physically impossible negative flows (e.g., negative births) while allowing valid negative flows
- GRAPHICAL FUNCTION BEST PRACTICES:
  * A variable with a graphical (table or lookup) function gets an equation that is an algebraic expression of only the function's inputs; its graphical function points map that input to the output
  * Any equation that uses a graphical function's output references only that variable's name, never a function-call form
  * For all non-time based graphical functions: Design the function so that normal input produces normal output and include the point (1, 1) in your graphical function to ensure that when the input variable equals 1, the output equals 1
  * This normalization principle allows the function to express deviations from normal behavior in both directions
  * Example: A "productivity multiplier from experience" function should pass through (1, 1) so that normal experience (input=1) yields normal productivity (output=1)
  * Time-based graphical functions (using TIME as input) do NOT need to follow this normalization rule`

    static ARRAY_SPECIFIC_EQUATION_REQUIREMENTS =
`CRITICAL EQUATION REQUIREMENT: Every variable MUST have EITHER 'equation' OR 'arrayEquations' populated (never both, never neither)
  * For SCALAR (non-arrayed) variables: ALWAYS provide 'equation'
ARRAY-SPECIFIC EQUATION REQUIREMENTS:
- For ARRAYED variables where all elements use the SAME formula: provide 'equation' only
- For ARRAYED variables where elements have DIFFERENT formulas: provide 'arrayEquations' with entries for ALL elements (omit 'equation')
- For arrayed STOCKS with numeric initialization: ALWAYS use 'arrayEquations' to specify initial values for each element individually (omit 'equation')
- SUM FUNCTION SYNTAX FOR ARRAYS:
  * ALWAYS use asterisk (*) for the dimension to sum, NEVER the dimension name
  * CRITICAL: Every SUM equation MUST contain at least one asterisk (*) - this is mandatory
  * WRONG: SUM(Revenue[region]) or SUM(Sales[product])
  * CORRECT: SUM(Revenue[*]) to sum across all elements of a single dimension
  * CORRECT: SUM(Sales[product,*]) to sum across the second dimension of a 2D array
  * The asterisk (*) represents "sum over all elements of this dimension"`

    static VERIFY_MODEL_SECTION =
`STEP 5 - VERIFY MODEL VALIDITY:
Continuously verify the model produces correct results for correct reasons. Question whether the structure truly represents the described system.`

    
    static ARRAY_EXAMPLE =
`EXAMPLE - COMPLETE ARRAY MODEL:
Here is a complete example of a properly structured array model with two dimensions (Product and Location):

{
    "specs": {
        "arrayDimensions": [
            {
                "elements": ["BGO", "NYC"],
                "name": "Location",
                "type": "labels"
            },
            {
                "elements": ["Pizza", "Kebab", "Sandwich"],
                "name": "Product",
                "type": "labels"
            }
        ],
        "dt": 0.25,
        "startTime": 1,
        "stopTime": 13,
        "timeUnits": "Month"
    },
    "variables": [
        {
            "name": "price",
            "type": "variable",
            "dimensions": ["Product", "Location"],
            "equation": "IF Product = Product.Pizza THEN 250 ELSE IF Product = Product.Kebab THEN 150 ELSE 125",
            "units": "Nok/Product"
        },
        {
            "name": "sales",
            "type": "variable",
            "dimensions": ["Product", "Location"],
            "arrayEquations": [
                { "forElements": ["Pizza", "BGO"], "equation": "1000" },
                { "forElements": ["Pizza", "NYC"], "equation": "2000" },
                { "forElements": ["Kebab", "BGO"], "equation": "2000" },
                { "forElements": ["Kebab", "NYC"], "equation": "800" },
                { "forElements": ["Sandwich", "BGO"], "equation": "1500" },
                { "forElements": ["Sandwich", "NYC"], "equation": "1500" }
            ],
            "units": "Product/Month"
        },
        {
            "name": "revenue",
            "type": "variable",
            "dimensions": ["Product", "Location"],
            "equation": "price*sales",
            "units": "Nok/Months"
        },
        {
            "name": "total revenue",
            "type": "variable",
            "equation": "SUM(revenue)",
            "units": "Nok/Months"
        },
        {
            "name": "revenue by product",
            "type": "variable",
            "dimensions": ["Product"],
            "equation": "SUM(revenue[Product,*])",
            "units": "Nok/Months"
        },
        {
            "name": "revenue by location",
            "type": "variable",
            "dimensions": ["Location"],
            "equation": "SUM(revenue[*, Location])",
            "units": "Nok/Months"
        }
    ],
    "relationships": [
        { "from": "price", "to": "revenue", "polarity": "+" },
        { "from": "sales", "to": "revenue", "polarity": "+" },
        { "from": "revenue", "to": "total revenue", "polarity": "+" },
        { "from": "revenue", "to": "revenue by product", "polarity": "+" },
        { "from": "revenue", "to": "revenue by location", "polarity": "+" }
    ]
}

Key lessons from this example:
- Dimensions are defined first in specs.arrayDimensions with all elements listed
- Variables with same formula for all elements use 'equation' field (e.g., price, revenue)
- Variables with different values per element use 'arrayEquations' (e.g., sales)
- SUM(revenue) sums across ALL dimensions to produce a scalar
- SUM(revenue[Product,*]) sums across second dimension, preserving first dimension
- SUM(revenue[*, Location]) sums across first dimension, preserving second dimension
- The asterisk (*) indicates which dimension to sum over`

    static MODULE_EXAMPLE =
`EXAMPLE - COMPLETE MODULAR MODEL WITH GHOST VARIABLES:
Here is a complete example of a properly structured modular model (Lynx-Hare predator-prey system):

{
    "specs": {
        "arrayDimensions": [],
        "dt": 0.03125,
        "startTime": 0,
        "stopTime": 100,
        "timeUnits": "year"
    },
    "variables": [
        {
            "name": "Hares.area",
            "type": "variable",
            "equation": "1E3",
            "units": "arce"
        },
        {
            "name": "Hares.Hares",
            "type": "stock",
            "equation": "5E4",
            "inflows": ["Hares.hare births"],
            "outflows": ["Hares.hare deaths"],
            "units": "hares"
        },
        {
            "name": "Hares.hare births",
            "type": "flow",
            "uniflow": true,
            "equation": "Hares*hare_birth_fraction",
            "units": "hares/year"
        },
        {
            "name": "Hares.hare deaths",
            "type": "flow",
            "uniflow": true,
            "equation": "Lynx*hares_killed_per_lynx",
            "units": "hares/year"
        },
        {
            "name": "Hares.hare birth fraction",
            "type": "variable",
            "equation": "1.25",
            "units": "per year"
        },
        {
            "name": "Hares.hare density",
            "type": "variable",
            "equation": "Hares/area",
            "units": "hares/arce"
        },
        {
            "name": "Hares.hares killed per lynx",
            "type": "variable",
            "equation": "hare_density",
            "units": "hares/lynx/year",
            "graphicalFunction": [
                { "x": 0, "y": 0 },
                { "x": 50, "y": 50 },
                { "x": 100, "y": 100 },
                { "x": 150, "y": 150 },
                { "x": 200, "y": 200 },
                { "x": 250, "y": 250 },
                { "x": 300, "y": 300 },
                { "x": 350, "y": 350 },
                { "x": 400, "y": 400 },
                { "x": 450, "y": 450 },
                { "x": 500, "y": 500 }
            ]
        },
        {
            "name": "Hares.Lynx",
            "type": "variable",
            "crossLevelGhostOf": "Lynx.Lynx",
            "equation": "",
            "units": "lynx"
        },
        {
            "name": "Lynx.Lynx",
            "type": "stock",
            "equation": "1250",
            "inflows": ["Lynx.lynx births"],
            "outflows": ["Lynx.lynx deaths"],
            "units": "lynx"
        },
        {
            "name": "Lynx.lynx births",
            "type": "flow",
            "uniflow": true,
            "equation": "Lynx*lynx_birth_fraction",
            "units": "lynx/year"
        },
        {
            "name": "Lynx.lynx deaths",
            "type": "flow",
            "uniflow": true,
            "equation": "Lynx*lynx_death_fraction",
            "units": "lynx/year"
        },
        {
            "name": "Lynx.lynx birth fraction",
            "type": "variable",
            "equation": ".25",
            "units": "per year"
        },
        {
            "name": "Lynx.lynx death fraction",
            "type": "variable",
            "equation": "hare_density",
            "units": "per year",
            "graphicalFunction": [
                { "x": 0, "y": 0.94 },
                { "x": 10, "y": 0.66 },
                { "x": 20, "y": 0.4 },
                { "x": 30, "y": 0.35 },
                { "x": 40, "y": 0.3 },
                { "x": 50, "y": 0.25 },
                { "x": 60, "y": 0.2 },
                { "x": 70, "y": 0.15 },
                { "x": 80, "y": 0.1 },
                { "x": 90, "y": 0.07 },
                { "x": 100, "y": 0.05 }
            ]
        },
        {
            "name": "Lynx.hare density",
            "type": "variable",
            "crossLevelGhostOf": "Hares.hare density",
            "equation": "",
            "units": "hares/arce"
        }
    ],
    "relationships": [
        { "from": "Hares.Hares", "to": "Hares.hare births" },
        { "from": "Hares.hare birth fraction", "to": "Hares.hare births" },
        { "from": "Hares.Hares", "to": "Hares.hare density" },
        { "from": "Hares.hare density", "to": "Hares.hares killed per lynx" },
        { "from": "Hares.hares killed per lynx", "to": "Hares.hare deaths" },
        { "from": "Hares.area", "to": "Hares.hare density" },
        { "from": "Hares.hare births", "to": "Hares.Hares", "polarity": "+" },
        { "from": "Hares.hare deaths", "to": "Hares.Hares", "polarity": "-" },
        { "from": "Hares.Lynx", "to": "Hares.hare deaths" },
        { "from": "Lynx.Lynx", "to": "Lynx.lynx births" },
        { "from": "Lynx.lynx birth fraction", "to": "Lynx.lynx births" },
        { "from": "Lynx.Lynx", "to": "Lynx.lynx deaths" },
        { "from": "Lynx.lynx death fraction", "to": "Lynx.lynx deaths" },
        { "from": "Lynx.lynx births", "to": "Lynx.Lynx", "polarity": "+" },
        { "from": "Lynx.lynx deaths", "to": "Lynx.Lynx", "polarity": "-" },
        { "from": "Lynx.hare density", "to": "Lynx.lynx death fraction" }
    ]
}

Key lessons from this modular example:
- Module names use dot notation: "ModuleName.variableName"
- CRITICAL: Variable names use ONLY immediate module prefix, never full hierarchy (e.g., "Hares.population" not "Ecosystem.Hares.population")
- Cross-level ghost variables are created for inter-module references
- Ghost variable "Hares.Lynx" references source "Lynx.Lynx" (allows Hares module to use Lynx population)
- Ghost variable "Lynx.hare density" references source "Hares.hare density" (allows Lynx module to use hare density)
- Ghost variables have crossLevelGhostOf set to the source variable's full name
- Ghost variables have empty equation field (equation = "")
- All equations in a module reference the ghost variable, NOT the original source variable
- This creates proper module encapsulation while allowing cross-module dependencies`

    static FORMULATION_ERROR_SECTION =
`IDENTIFY FORMULATION ERRORS:
When reviewing or fixing models, detect and correct these common errors:

a. VARIABLE TYPE ERRORS FOR AGGREGATIONS:
   - Simple sums (e.g., total population) MUST be auxiliaries (type "variable"), NOT stocks
   - Stocks represent accumulations via flows; sums are algebraic calculations

b. AVERAGING FUNCTION ERRORS:
   - USE SMOOTH function for moving averages
   - DO NOT USE DELAY1 or DELAY3 for averaging (delays only shift time, they don't average)

- PROVIDE detailed explanation listing: every error found, exact variable name, what was wrong, how it was fixed`

    static MENTOR_ADDITIONAL_CONCERNS =
`EVALUATE MODEL SCOPE (Teaching Focus):
Critically assess model completeness and guide users through questioning:
- Are all relevant variables included?
- Are there missing connections between variables that should exist?
- Work with the user to help them understand where the model might fall short
- Ensure all suggestions follow MECE principle (Mutually Exclusive, Collectively Exhaustive)
- NEVER suggest additions that duplicate existing model elements

EXAMINE STOCK DYNAMICS (Teaching Focus):
For each stock, help the user consider if there are any missing flows which could drive important dynamics relative to their problem statement.`

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
`You are a System Dynamics Professional Modeler. Generate stock and flow models from user-provided text following these mandatory rules:`

    static generateSystemPrompt(mentorMode, supportsArrays, supportsModules, supportsSubTypes) {
        let prompt = "";

        // Add intro based on mode
        if (mentorMode) {
            prompt += QuantitativeEngineBrain.MENTOR_MODE_INTRO + "\n\n";
        } else {
            prompt += QuantitativeEngineBrain.PROFESSIONAL_MODE_INTRO + "\n\n";
        }

        // Add module requirements if modules are supported
        if (supportsModules) {
            prompt += QuantitativeEngineBrain.MODULE_REQUIREMENTS_SECTION + "\n\n";
        }

        // Add array requirements if arrays are supported
        if (supportsArrays) {
            prompt += QuantitativeEngineBrain.ARRAY_REQUIREMENTS_SECTION + "\n\n";
        }

        // Add sub-type requirements if sub-types are supported
        if (supportsSubTypes) {
            prompt += QuantitativeEngineBrain.SUB_TYPE_REQUIREMENTS_SECTION + "\n\n";
        }

        // Always add mandatory process section
        prompt += QuantitativeEngineBrain.MANDATORY_PROCESS_SECTION + "\n\n";

        // Add array-specific equation requirements if arrays are supported
        if (supportsArrays) {
            prompt += QuantitativeEngineBrain.ARRAY_SPECIFIC_EQUATION_REQUIREMENTS + "\n\n";
        }

        // Always add verify model section
        prompt += QuantitativeEngineBrain.VERIFY_MODEL_SECTION;

        // Add mentor-specific concerns if in mentor mode
        if (mentorMode) {
            prompt += "\n\nSTEP 6 - " + QuantitativeEngineBrain.MENTOR_ADDITIONAL_CONCERNS;
            prompt += "\n\nSTEP 7 - " + QuantitativeEngineBrain.FORMULATION_ERROR_SECTION;
        } else {
            prompt += "\n\nSTEP 6 - " + QuantitativeEngineBrain.FORMULATION_ERROR_SECTION;
        }

        // Add examples based on what's supported
        if (supportsArrays) {
            prompt += "\n\n" + QuantitativeEngineBrain.ARRAY_EXAMPLE;
        }

        if (supportsModules) {
            prompt += "\n\n" + QuantitativeEngineBrain.MODULE_EXAMPLE;
        }

        return prompt;
    }

    static MENTOR_SYSTEM_PROMPT = QuantitativeEngineBrain.generateSystemPrompt(true, true, true)

    static DEFAULT_SYSTEM_PROMPT = QuantitativeEngineBrain.generateSystemPrompt(false, true, true)

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
        assistantPrompt: QuantitativeEngineBrain.DEFAULT_ASSISTANT_PROMPT,
        backgroundPrompt: QuantitativeEngineBrain.DEFAULT_BACKGROUND_PROMPT,
        problemStatementPrompt: QuantitativeEngineBrain.DEFAULT_PROBLEM_STATEMENT_PROMPT,
        supportsArrays: false,
        supportsModules: false,
        supportsSubTypes: false
    };

    #llmWrapper;

    constructor(params) {
        Object.assign(this.#data, params);

        // Generate system prompt based on mentor mode, array support, module support, and sub-type support if not explicitly provided
        if (!this.#data.systemPrompt) {
            this.#data.systemPrompt = QuantitativeEngineBrain.generateSystemPrompt(
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

    async #parseExplanation(response) {
        if (response.explanation) {
            response.explanation = await marked.parse(response.explanation);
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

    async processResponse(originalResponse) {
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
            // Sub-types arrive in the schema's all-required form ('none', and a
            // list of settings); give them the optional object shape everything
            // downstream expects.
            if (v.subType === 'none') delete v.subType;
            if (Array.isArray(v.additionalProperties)) {
                const additionalProperties = LLMWrapper.settingsToAdditionalProperties(v.additionalProperties);
                if (additionalProperties) v.additionalProperties = additionalProperties;
                else delete v.additionalProperties;
            }

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

        await this.#parseExplanation(originalResponse);

        return originalResponse;
    }

    mentor() {
        this.#data.mentorMode = true;
        this.#data.systemPrompt = QuantitativeEngineBrain.generateSystemPrompt(
            this.#data.mentorMode,
            this.#data.supportsArrays,
            this.#data.supportsModules,
            this.#data.supportsSubTypes
        );
    }

    setupLLMParameters(userPrompt, lastModel) {
        //start with the system prompt
        const { underlyingModel, systemRole, reasoningEffort } = this.#llmWrapper.getLLMParameters();
        let systemPrompt = this.#data.systemPrompt;
        let responseFormat = this.#llmWrapper.generateQuantitativeSDJSONResponseSchema(this.#data.mentorMode, this.#data.supportsArrays, this.#data.supportsModules, this.#data.supportsSubTypes);

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
            // Shown in the shape the response schema asks for, so the model's own
            // prior answer does not contradict the format it must answer in.
            const priorModel = this.#data.supportsSubTypes
                ? {
                    ...lastModel,
                    variables: lastModel.variables.map(v => v.additionalProperties
                        ? { ...v, additionalProperties: LLMWrapper.additionalPropertiesToSettings(v.additionalProperties) }
                        : v)
                }
                : lastModel;
            messages.push({ role: "assistant", content: JSON.stringify(priorModel, null, 2) });

            if (this.#data.assistantPrompt)
                messages.push({ role: "user", content: this.#data.assistantPrompt });
        }

        //give it the user prompt
        messages.push({ role: "user", content: userPrompt });

        return {
            messages,
            model: underlyingModel,
            responseFormat: responseFormat,
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

        const llmParams = this.setupLLMParameters(userPrompt, lastModel);

        //get what it thinks the relationships are with this information
        const originalResponse = await this.#llmWrapper.createChatCompletion(
            llmParams.messages,
            llmParams.model,
            llmParams.responseFormat,
            llmParams.reasoningEffort
        );
        if (originalResponse.refusal) {
            throw new ResponseFormatError(originalResponse.refusal);
        } else if (originalResponse.parsed) {
            return this.processResponse(originalResponse.parsed);
        } else if (originalResponse.content) {
            let parsedObj = {variables: [], relationships: []};
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

export default QuantitativeEngineBrain;