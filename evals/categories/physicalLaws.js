/**
 * Physical Laws Evaluation
 *
 * This evaluation tests the LLM's ability to build System Dynamics models that accurately
 * represent physical systems governed by fundamental physics laws. It includes tests for:
 *
 * 1. Pendulums - Newton's laws of motion, energy conservation, rotational dynamics
 * 2. Spring-Mass Systems - Hooke's law, simple harmonic motion, energy conservation
 * 3. Gas Laws - Ideal gas law (PV = nRT), thermodynamic relationships
 *
 * The evaluation uses PySDSimulator to convert the LLM's sd-json response to XMILE format,
 * simulate it, and then validates the physical behavior against known physical laws.
 *
 * @module categories/physicalLaws
 */

import PySDSimulator from '../utilities/simulator/PySDSimulator.js';
import { validateEvaluationResult } from '../evaluationSchema.js';
import SDJsonToXMILE from '../../utilities/SDJsonToXMILE.js';

/**
 * Returns the description for this category
 * @returns {string} The description describing this category
 */
export const description = () => {
    return `The physical laws evaluation assesses an LLM's ability to build System Dynamics models that
accurately represent physical systems governed by fundamental physics laws including Newton's laws of motion,
Hooke's law, and the ideal gas law. It tests whether models exhibit correct energy conservation, proper
force-acceleration relationships, thermodynamic behavior, and physically realistic dynamics.`;
};

const MIN_OSCILLATOR_FIT_R_SQUARED = 0.90;
const MAX_VELOCITY_COEFFICIENT_NOISE = 1e-4;

const solveTwoPredictorLeastSquares = (feature1, feature2, target) => {
    let s11 = 0;
    let s12 = 0;
    let s22 = 0;
    let b1 = 0;
    let b2 = 0;

    for (let i = 0; i < target.length; i++) {
        s11 += feature1[i] * feature1[i];
        s12 += feature1[i] * feature2[i];
        s22 += feature2[i] * feature2[i];
        b1 += feature1[i] * target[i];
        b2 += feature2[i] * target[i];
    }

    const determinant = s11 * s22 - s12 * s12;
    if (Math.abs(determinant) < 1e-12) {
        return null;
    }

    const coefficient1 = (b1 * s22 - b2 * s12) / determinant;
    const coefficient2 = (s11 * b2 - s12 * b1) / determinant;
    const meanTarget = target.reduce((sum, value) => sum + value, 0) / target.length;

    let sumSquaredResiduals = 0;
    let sumSquaredTotal = 0;
    for (let i = 0; i < target.length; i++) {
        const prediction = coefficient1 * feature1[i] + coefficient2 * feature2[i];
        sumSquaredResiduals += Math.pow(target[i] - prediction, 2);
        sumSquaredTotal += Math.pow(target[i] - meanTarget, 2);
    }

    const rSquared = sumSquaredTotal > 1e-12
        ? 1 - (sumSquaredResiduals / sumSquaredTotal)
        : (sumSquaredResiduals <= 1e-12 ? 1 : 0);

    return {
        coefficient1,
        coefficient2,
        rSquared
    };
};

const findSignChangeIndices = (series) => {
    const indices = [];
    let previousSign = Math.sign(series[0]);
    let previousIndex = 0;

    for (let i = 1; i < series.length; i++) {
        const currentSign = Math.sign(series[i]);
        if (currentSign === 0) {
            continue;
        }

        if (previousSign !== 0 && currentSign !== previousSign) {
            indices.push(Math.abs(series[previousIndex]) <= Math.abs(series[i]) ? previousIndex : i);
        }

        previousSign = currentSign;
        previousIndex = i;
    }

    return indices;
};

const validateOscillatorEquation = ({
    displacement,
    velocity,
    acceleration,
    restoringFeature,
    forceViolationType,
    forceViolationDetails,
    accelerationDescriptor
}) => {
    const fails = [];

    const n = acceleration.length;
    const meanRestoring = restoringFeature.reduce((s, v) => s + v, 0) / n;
    const meanVelocity = velocity.reduce((s, v) => s + v, 0) / n;
    const meanAcceleration = acceleration.reduce((s, v) => s + v, 0) / n;

    const centeredRestoring = restoringFeature.map(v => v - meanRestoring);
    const centeredVelocity = velocity.map(v => v - meanVelocity);
    const centeredAcceleration = acceleration.map(v => v - meanAcceleration);

    const fit = solveTwoPredictorLeastSquares(centeredRestoring, centeredVelocity, centeredAcceleration);
    if (!fit) {
        fails.push({
            type: "Equation of motion violation",
            details: `Could not fit ${accelerationDescriptor} to a restoring-force-plus-damping model.`
        });
        return fails;
    }

    if (fit.coefficient1 >= 0) {
        fails.push({
            type: forceViolationType,
            details: forceViolationDetails(fit)
        });
    }

    if (fit.rSquared < MIN_OSCILLATOR_FIT_R_SQUARED) {
        fails.push({
            type: "Equation of motion violation",
            details: `${accelerationDescriptor} should be well explained by a restoring-force-plus-damping model. ` +
                    `Best-fit R²: ${fit.rSquared.toFixed(3)} (expected >= ${MIN_OSCILLATOR_FIT_R_SQUARED.toFixed(2)})`
        });
    }

    if (fit.coefficient2 > MAX_VELOCITY_COEFFICIENT_NOISE) {
        fails.push({
            type: "Energy conservation violation",
            details: `${accelerationDescriptor} should not include a positive feedback term that adds energy. ` +
                    `Best-fit velocity coefficient: ${fit.coefficient2.toFixed(6)} (expected <= 0)`
        });
    }

    return fails;
};

/**
 * Validates that a pendulum model obeys Newton's laws of motion
 * @param {Object} simulationResults - Results from simulation containing time, angle, angular_velocity, angular_acceleration
 * @param {Object} model - The model object containing variables
 * @returns {Array<Object>} A list of failures with type and details
 */
export const validateNewtonsLaws = (simulationResults, model) => {
    const fails = [];

    // Extract time series data
    const time = simulationResults.time;
    const angle = simulationResults.angle;
    const angularVelocity = simulationResults.angular_velocity;
    const angularAcceleration = simulationResults.angular_acceleration;

    if (!time || !angle || !angularVelocity || !angularAcceleration) {
        fails.push({
            type: "Missing required variables",
            details: "Simulation must produce 'angle', 'angular_velocity', and 'angular_acceleration' time series"
        });
        return fails;
    }

    // Validate data lengths match
    if (angle.length !== angularVelocity.length || angle.length !== angularAcceleration.length) {
        fails.push({
            type: "Inconsistent time series lengths",
            details: "All time series must have the same length"
        });
        return fails;
    }

    // Check for physically realistic oscillation
    // A pendulum should oscillate around zero (or some equilibrium)
    const angleMin = Math.min(...angle);
    const angleMax = Math.max(...angle);
    const angleRange = angleMax - angleMin;

    if (angleRange < 0.01) {
        fails.push({
            type: "No oscillation detected",
            details: `Angle range is too small (${angleRange.toFixed(6)}). Pendulum should oscillate.`
        });
    }

    // Check for sign changes in angle (crosses equilibrium)
    const signChanges = findSignChangeIndices(angle).length;

    if (signChanges < 2) {
        fails.push({
            type: "Insufficient oscillations",
            details: `Expected multiple oscillations but only detected ${signChanges} zero crossings`
        });
    }

    fails.push(...validateOscillatorEquation({
        displacement: angle,
        velocity: angularVelocity,
        acceleration: angularAcceleration,
        restoringFeature: angle.map(Math.sin),
        forceViolationType: "Newton's second law violation",
        forceViolationDetails: (fit) =>
            `Angular acceleration should point back toward equilibrium. ` +
            `Best-fit sin(angle) coefficient: ${fit.coefficient1.toFixed(3)} (expected < 0)`,
        accelerationDescriptor: "Angular acceleration"
    }));

    // Check that angular velocity is the derivative of angle
    // For discrete time: velocity[i] ≈ (angle[i+1] - angle[i]) / dt
    if (time.length >= 3) {
        const dt = time[1] - time[0];
        let derivativeError = 0;
        let validDerivatives = 0;

        for (let i = 1; i < angle.length - 1; i++) {
            const numericalDerivative = (angle[i + 1] - angle[i - 1]) / (2 * dt);
            const modelVelocity = angularVelocity[i];

            // Calculate relative error
            if (Math.abs(modelVelocity) > 0.001) {
                const error = Math.abs(numericalDerivative - modelVelocity) / Math.abs(modelVelocity);
                derivativeError += error;
                validDerivatives++;
            }
        }

        if (validDerivatives > 0) {
            const avgDerivativeError = derivativeError / validDerivatives;

            // Average error should be less than 20%
            if (avgDerivativeError > 0.2) {
                fails.push({
                    type: "Kinematic consistency violation",
                    details: `Angular velocity should be the derivative of angle. ` +
                            `Average relative error: ${(avgDerivativeError * 100).toFixed(1)}% (expected < 20%)`
                });
            }
        }
    }

    // Check for unbounded growth (non-physical)
    const firstHalfMax = Math.max(...angle.slice(0, Math.floor(angle.length / 2)).map(Math.abs));
    const secondHalfMax = Math.max(...angle.slice(Math.floor(angle.length / 2)).map(Math.abs));

    // Allow some damping but not exponential growth
    if (secondHalfMax > 2 * firstHalfMax) {
        fails.push({
            type: "Unbounded growth",
            details: `Pendulum angle should not grow unbounded. ` +
                    `First half max: ${firstHalfMax.toFixed(3)}, ` +
                    `Second half max: ${secondHalfMax.toFixed(3)}`
        });
    }

    return fails;
};

/**
 * Evaluates pendulum models
 * @param {Object} generatedResponse The response from the engine containing the model
 * @param {Object} requirements The test requirements
 * @returns {Array<Object>} A list of failures with type and details
 */
const evaluatePendulum = async function(generatedResponse, requirements) {
    const fails = [];

    try {
        // Check if model exists
        if (!generatedResponse.model) {
            fails.push({
                type: "Missing model",
                details: "The response does not contain a model"
            });
            return validateEvaluationResult(fails);
        }

        const model = generatedResponse.model;

        // Check if required variables exist
        const requiredVars = ['angle', 'angular_velocity', 'angular_acceleration'];
        const missingVars = [];

        for (const varName of requiredVars) {
            const variable = model.variables?.find(v =>
                v.name.toLowerCase().replace(/[_\s]/g, '') === varName.replace(/[_\s]/g, '')
            );
            if (!variable) {
                missingVars.push(varName);
            }
        }

        if (missingVars.length > 0) {
            fails.push({
                type: "Missing required variables",
                details: `The model must contain variables: ${missingVars.join(', ')}`
            });
            return validateEvaluationResult(fails);
        }

        // Convert model to XMILE
        let xmileContent;
        try {
            xmileContent = SDJsonToXMILE(generatedResponse, {
                modelName: model.name || 'Pendulum Model',
                vendor: 'SD-AI Evaluation',
                product: 'sd-ai-evals',
                version: '1.0'
            });
        } catch (error) {
            fails.push({
                type: "XMILE conversion error",
                details: `Failed to convert model to XMILE: ${error.message}`
            });
            return validateEvaluationResult(fails);
        }

        // Simulate the model
        let simulationResults;
        try {
            const simulator = new PySDSimulator(xmileContent);
            // Note: 'time' is automatically included in results, don't request it as a variable
            simulationResults = await simulator.simulate(['angle', 'angular_velocity', 'angular_acceleration']);
        } catch (error) {
            fails.push({
                type: "Simulation error",
                details: `Failed to simulate the model: ${error.message}`
            });
            return validateEvaluationResult(fails);
        }

        // Validate Newton's laws
        const physicsViolations = validateNewtonsLaws(simulationResults, model);
        fails.push(...physicsViolations);

    } catch (error) {
        fails.push({
            type: "Unexpected evaluation error",
            details: error.message
        });
    }

    return validateEvaluationResult(fails);
};

/**
 * Main evaluation function that routes to specific evaluators
 * @param {Object} generatedResponse The response from the engine containing the model
 * @param {Object} requirements The test requirements
 * @returns {Array<Object>} A list of failures with type and details
 */
export const evaluate = async function(generatedResponse, requirements) {
    // Route to the appropriate evaluation function based on requirements
    const evaluationType = requirements?.evaluationType || 'pendulum';

    switch (evaluationType) {
        case 'pendulum':
            return await evaluatePendulum(generatedResponse, requirements);
        case 'springMass':
            return await evaluateSpringMass(generatedResponse, requirements);
        case 'gasLaws':
            return await evaluateGasLaws(generatedResponse, requirements);
        default:
            return validateEvaluationResult([{
                type: "Unknown evaluation type",
                details: `Evaluation type '${evaluationType}' is not supported`
            }]);
    }
};

/**
 * Generate a pendulum test
 * @param {string} name - Test name
 * @param {string} description - Description of the specific pendulum scenario
 * @param {string} backgroundKnowledge - Background information about the physics
 * @returns {Object} Test configuration object
 */
const generatePendulumTest = function(name, description, backgroundKnowledge) {
    return {
        name: name,
        prompt: `Create a System Dynamics model of ${description}. The model must include variables named 'angle' (angular position in radians), 'angular_velocity' (angular velocity in radians/second), and 'angular_acceleration' (angular acceleration in radians/second²). The model should obey Newton's laws of motion.`,
        additionalParameters: {
            problemStatement: `I need a pendulum model that accurately represents ${description} and follows Newton's laws.`,
            backgroundKnowledge: backgroundKnowledge
        },
        expectations: {
            evaluationType: 'pendulum'
        }
    };
};

/**
 * Test cases for pendulum models
 */
const pendulumTests = [
    generatePendulumTest(
        "Simple Pendulum",
        "a simple pendulum with a small initial displacement",
        "A simple pendulum consists of a mass suspended from a fixed point by a massless string. " +
        "For small angles, the motion approximates simple harmonic motion. " +
        "Newton's second law for rotational motion states: τ = I*α, where τ is torque, I is moment of inertia, and α is angular acceleration. " +
        "For a simple pendulum: α = -(g/L)*sin(θ), where g is gravitational acceleration (9.8 m/s²), L is length, and θ is angle. " +
        "For small angles, sin(θ) ≈ θ, giving α ≈ -(g/L)*θ. " +
        "The angular velocity ω = dθ/dt, and angular acceleration α = dω/dt. " +
        "Energy is conserved: E = (1/2)*I*ω² + mgh, where potential energy depends on height h = L*(1-cos(θ))."
    ),
    generatePendulumTest(
        "Damped Pendulum",
        "a damped pendulum with friction",
        "A damped pendulum experiences a resistive force proportional to velocity. " +
        "The equation of motion becomes: α = -(g/L)*sin(θ) - (b/I)*ω, where b is the damping coefficient. " +
        "Newton's second law still applies: τ_total = τ_gravity + τ_damping = I*α. " +
        "The system loses energy over time due to friction, causing oscillation amplitude to decrease exponentially. " +
        "Angular acceleration must still be the derivative of angular velocity, and angular velocity the derivative of angle."
    ),
    generatePendulumTest(
        "Pendulum with Moderate Initial Angle",
        "a simple pendulum with a moderate initial displacement (30 degrees)",
        "For larger angles, the small-angle approximation breaks down and we must use the full equation: α = -(g/L)*sin(θ). " +
        "This introduces non-linearity, making the period slightly longer than predicted by the small-angle approximation. " +
        "Newton's laws still govern the motion: the restoring torque is τ = -m*g*L*sin(θ), and τ = I*α. " +
        "Energy conservation still holds (in the absence of damping): KE + PE = constant, where PE = m*g*L*(1-cos(θ)). " +
        "The motion is still periodic but not exactly sinusoidal due to the nonlinear restoring force."
    )
];

/**
 * Validates that a spring-mass system obeys Hooke's law and conservation of energy
 * @param {Object} simulationResults - Results containing time, position, velocity, acceleration
 * @param {Object} model - The model object containing variables
 * @returns {Array<Object>} A list of failures with type and details
 */
export const validateSpringMassLaws = (simulationResults, model) => {
    const fails = [];

    // Extract time series data
    const time = simulationResults.time;
    const position = simulationResults.position;
    const velocity = simulationResults.velocity;
    const acceleration = simulationResults.acceleration;

    if (!time || !position || !velocity || !acceleration) {
        fails.push({
            type: "Missing required variables",
            details: "Simulation must produce 'position', 'velocity', and 'acceleration' time series"
        });
        return fails;
    }

    // Validate data lengths match
    if (position.length !== velocity.length || position.length !== acceleration.length) {
        fails.push({
            type: "Inconsistent time series lengths",
            details: "All time series must have the same length"
        });
        return fails;
    }

    // Check for physically realistic oscillation
    const posMin = Math.min(...position);
    const posMax = Math.max(...position);
    const posRange = posMax - posMin;

    if (posRange < 0.001) {
        fails.push({
            type: "No oscillation detected",
            details: `Position range is too small (${posRange.toFixed(6)}). Spring-mass system should oscillate.`
        });
    }

    // Check for sign changes in position (crosses equilibrium)
    const signChanges = findSignChangeIndices(position).length;

    if (signChanges < 2) {
        fails.push({
            type: "Insufficient oscillations",
            details: `Expected multiple oscillations but only detected ${signChanges} zero crossings`
        });
    }

    fails.push(...validateOscillatorEquation({
        displacement: position,
        velocity,
        acceleration,
        restoringFeature: position,
        forceViolationType: "Hooke's law violation",
        forceViolationDetails: (fit) =>
            `Acceleration should point back toward equilibrium. ` +
            `Best-fit position coefficient: ${fit.coefficient1.toFixed(3)} (expected < 0)`,
        accelerationDescriptor: "Acceleration"
    }));

    // Check that velocity is the derivative of position
    if (time.length >= 3) {
        const dt = time[1] - time[0];
        let derivativeError = 0;
        let validDerivatives = 0;

        for (let i = 1; i < position.length - 1; i++) {
            const numericalDerivative = (position[i + 1] - position[i - 1]) / (2 * dt);
            const modelVelocity = velocity[i];

            if (Math.abs(modelVelocity) > 0.001) {
                const error = Math.abs(numericalDerivative - modelVelocity) / Math.abs(modelVelocity);
                derivativeError += error;
                validDerivatives++;
            }
        }

        if (validDerivatives > 0) {
            const avgDerivativeError = derivativeError / validDerivatives;

            if (avgDerivativeError > 0.2) {
                fails.push({
                    type: "Kinematic consistency violation",
                    details: `Velocity should be the derivative of position. ` +
                            `Average relative error: ${(avgDerivativeError * 100).toFixed(1)}% (expected < 20%)`
                });
            }
        }
    }

    // Check for unbounded growth (non-physical)
    const firstHalfMax = Math.max(...position.slice(0, Math.floor(position.length / 2)).map(Math.abs));
    const secondHalfMax = Math.max(...position.slice(Math.floor(position.length / 2)).map(Math.abs));

    if (secondHalfMax > 2 * firstHalfMax) {
        fails.push({
            type: "Unbounded growth",
            details: `Spring-mass position should not grow unbounded. ` +
                    `First half max: ${firstHalfMax.toFixed(3)}, ` +
                    `Second half max: ${secondHalfMax.toFixed(3)}`
        });
    }

    return fails;
};

/**
 * Validates that a gas system obeys the ideal gas law (PV = nRT)
 * @param {Object} simulationResults - Results containing time and relevant gas variables
 * @param {Object} model - The model object containing variables
 * @returns {Array<Object>} A list of failures with type and details
 */
const validateGasLaws = (simulationResults, model) => {
    const fails = [];

    // Extract time series data
    const time = simulationResults.time;
    const pressure = simulationResults.pressure;
    const volume = simulationResults.volume;
    const temperature = simulationResults.temperature;

    if (!time || !pressure || !volume || !temperature) {
        fails.push({
            type: "Missing required variables",
            details: "Simulation must produce 'pressure', 'volume', and 'temperature' time series"
        });
        return fails;
    }

    // Validate data lengths match
    if (pressure.length !== volume.length || pressure.length !== temperature.length) {
        fails.push({
            type: "Inconsistent time series lengths",
            details: "All time series must have the same length"
        });
        return fails;
    }

    // For an ideal gas: PV/T should be constant (PV = nRT, with n and R constant)
    const pvOverT = [];
    for (let i = 0; i < pressure.length; i++) {
        if (temperature[i] > 0 && pressure[i] > 0 && volume[i] > 0) {
            pvOverT.push((pressure[i] * volume[i]) / temperature[i]);
        }
    }

    if (pvOverT.length === 0) {
        fails.push({
            type: "Invalid gas state",
            details: "Pressure, volume, and temperature must all be positive"
        });
        return fails;
    }

    // Calculate mean and standard deviation of PV/T
    const mean = pvOverT.reduce((a, b) => a + b, 0) / pvOverT.length;
    const variance = pvOverT.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / pvOverT.length;
    const stdDev = Math.sqrt(variance);
    const coefficientOfVariation = stdDev / mean;

    // Ideal gas law: PV/T should remain constant (low coefficient of variation)
    if (coefficientOfVariation > 0.15) {
        fails.push({
            type: "Ideal gas law violation",
            details: `PV/T should be constant for an ideal gas. ` +
                    `Mean: ${mean.toFixed(3)}, Std Dev: ${stdDev.toFixed(3)}, ` +
                    `Coefficient of variation: ${coefficientOfVariation.toFixed(3)} (expected < 0.15)`
        });
    }

    // Check for physically realistic values (no negative pressure, volume, or temperature)
    const minPressure = Math.min(...pressure);
    const minVolume = Math.min(...volume);
    const minTemperature = Math.min(...temperature);

    if (minPressure < 0) {
        fails.push({
            type: "Non-physical pressure",
            details: `Pressure cannot be negative. Minimum pressure: ${minPressure.toFixed(3)}`
        });
    }

    if (minVolume < 0) {
        fails.push({
            type: "Non-physical volume",
            details: `Volume cannot be negative. Minimum volume: ${minVolume.toFixed(3)}`
        });
    }

    if (minTemperature < 0) {
        fails.push({
            type: "Non-physical temperature",
            details: `Absolute temperature cannot be negative. Minimum temperature: ${minTemperature.toFixed(3)} K`
        });
    }

    // Check for unbounded growth
    const pressureRatio = Math.max(...pressure) / Math.min(...pressure.filter(p => p > 0));
    const volumeRatio = Math.max(...volume) / Math.min(...volume.filter(v => v > 0));
    const temperatureRatio = Math.max(...temperature) / Math.min(...temperature.filter(t => t > 0));

    if (pressureRatio > 1000 || volumeRatio > 1000 || temperatureRatio > 1000) {
        fails.push({
            type: "Unbounded growth",
            details: `Gas variables should not grow unbounded. ` +
                    `Pressure ratio: ${pressureRatio.toFixed(1)}, ` +
                    `Volume ratio: ${volumeRatio.toFixed(1)}, ` +
                    `Temperature ratio: ${temperatureRatio.toFixed(1)}`
        });
    }

    return fails;
};

/**
 * Evaluates spring-mass system models
 * @param {Object} generatedResponse The response from the engine containing the model
 * @param {Object} requirements The test requirements
 * @returns {Array<Object>} A list of failures with type and details
 */
export const evaluateSpringMass = async function(generatedResponse, requirements) {
    const fails = [];

    try {
        if (!generatedResponse.model) {
            fails.push({
                type: "Missing model",
                details: "The response does not contain a model"
            });
            return validateEvaluationResult(fails);
        }

        const model = generatedResponse.model;

        // Check if required variables exist
        const requiredVars = ['position', 'velocity', 'acceleration'];
        const missingVars = [];

        for (const varName of requiredVars) {
            const variable = model.variables?.find(v =>
                v.name.toLowerCase().replace(/[_\s]/g, '') === varName.replace(/[_\s]/g, '')
            );
            if (!variable) {
                missingVars.push(varName);
            }
        }

        if (missingVars.length > 0) {
            fails.push({
                type: "Missing required variables",
                details: `The model must contain variables: ${missingVars.join(', ')}`
            });
            return validateEvaluationResult(fails);
        }

        // Convert model to XMILE
        let xmileContent;
        try {
            xmileContent = SDJsonToXMILE(generatedResponse, {
                modelName: model.name || 'Spring-Mass Model',
                vendor: 'SD-AI Evaluation',
                product: 'sd-ai-evals',
                version: '1.0'
            });
        } catch (error) {
            fails.push({
                type: "XMILE conversion error",
                details: `Failed to convert model to XMILE: ${error.message}`
            });
            return validateEvaluationResult(fails);
        }

        // Simulate the model
        let simulationResults;
        try {
            const simulator = new PySDSimulator(xmileContent);
            simulationResults = await simulator.simulate(['position', 'velocity', 'acceleration']);
        } catch (error) {
            fails.push({
                type: "Simulation error",
                details: `Failed to simulate the model: ${error.message}`
            });
            return validateEvaluationResult(fails);
        }

        // Validate spring-mass laws
        const physicsViolations = validateSpringMassLaws(simulationResults, model);
        fails.push(...physicsViolations);

    } catch (error) {
        fails.push({
            type: "Unexpected evaluation error",
            details: error.message
        });
    }

    return validateEvaluationResult(fails);
};

/**
 * Evaluates gas law models
 * @param {Object} generatedResponse The response from the engine containing the model
 * @param {Object} requirements The test requirements
 * @returns {Array<Object>} A list of failures with type and details
 */
export const evaluateGasLaws = async function(generatedResponse, requirements) {
    const fails = [];

    try {
        if (!generatedResponse.model) {
            fails.push({
                type: "Missing model",
                details: "The response does not contain a model"
            });
            return validateEvaluationResult(fails);
        }

        const model = generatedResponse.model;

        // Check if required variables exist
        const requiredVars = ['pressure', 'volume', 'temperature'];
        const missingVars = [];

        for (const varName of requiredVars) {
            const variable = model.variables?.find(v =>
                v.name.toLowerCase().replace(/[_\s]/g, '') === varName.replace(/[_\s]/g, '')
            );
            if (!variable) {
                missingVars.push(varName);
            }
        }

        if (missingVars.length > 0) {
            fails.push({
                type: "Missing required variables",
                details: `The model must contain variables: ${missingVars.join(', ')}`
            });
            return validateEvaluationResult(fails);
        }

        // Convert model to XMILE
        let xmileContent;
        try {
            xmileContent = SDJsonToXMILE(generatedResponse, {
                modelName: model.name || 'Gas Law Model',
                vendor: 'SD-AI Evaluation',
                product: 'sd-ai-evals',
                version: '1.0'
            });
        } catch (error) {
            fails.push({
                type: "XMILE conversion error",
                details: `Failed to convert model to XMILE: ${error.message}`
            });
            return validateEvaluationResult(fails);
        }

        // Simulate the model
        let simulationResults;
        try {
            const simulator = new PySDSimulator(xmileContent);
            simulationResults = await simulator.simulate(['pressure', 'volume', 'temperature']);
        } catch (error) {
            fails.push({
                type: "Simulation error",
                details: `Failed to simulate the model: ${error.message}`
            });
            return validateEvaluationResult(fails);
        }

        // Validate gas laws
        const physicsViolations = validateGasLaws(simulationResults, model);
        fails.push(...physicsViolations);

    } catch (error) {
        fails.push({
            type: "Unexpected evaluation error",
            details: error.message
        });
    }

    return validateEvaluationResult(fails);
};

/**
 * Generate a spring-mass test
 * @param {string} name - Test name
 * @param {string} description - Description of the specific scenario
 * @param {string} backgroundKnowledge - Background information about the physics
 * @returns {Object} Test configuration object
 */
const generateSpringMassTest = function(name, description, backgroundKnowledge) {
    return {
        name: name,
        prompt: `Create a System Dynamics model of ${description}. The model must include variables named 'position' (displacement from equilibrium in meters), 'velocity' (velocity in meters/second), and 'acceleration' (acceleration in meters/second²). The model should obey Hooke's law and Newton's second law.`,
        additionalParameters: {
            problemStatement: `I need a spring-mass system model that accurately represents ${description} and follows physical laws.`,
            backgroundKnowledge: backgroundKnowledge
        },
        expectations: {
            evaluationType: 'springMass'
        }
    };
};

/**
 * Generate a gas law test
 * @param {string} name - Test name
 * @param {string} description - Description of the specific scenario
 * @param {string} backgroundKnowledge - Background information about the physics
 * @returns {Object} Test configuration object
 */
const generateGasLawTest = function(name, description, backgroundKnowledge) {
    return {
        name: name,
        prompt: `Create a System Dynamics model of ${description}. The model must include variables named 'pressure' (pressure in Pascals), 'volume' (volume in cubic meters), and 'temperature' (absolute temperature in Kelvin). The model should obey the ideal gas law (PV = nRT).`,
        additionalParameters: {
            problemStatement: `I need a gas system model that accurately represents ${description} and follows the ideal gas law.`,
            backgroundKnowledge: backgroundKnowledge
        },
        expectations: {
            evaluationType: 'gasLaws'
        }
    };
};

/**
 * Test cases for spring-mass systems
 */
const springMassTests = [
    generateSpringMassTest(
        "Simple Spring-Mass System",
        "a simple spring-mass system with a small initial displacement",
        "A spring-mass system consists of a mass attached to a spring. " +
        "Hooke's law states that the force exerted by a spring is F = -kx, where k is the spring constant and x is displacement. " +
        "Newton's second law: F = ma, so ma = -kx, giving a = -(k/m)*x. " +
        "This produces simple harmonic motion with angular frequency ω = sqrt(k/m). " +
        "The velocity v = dx/dt, and acceleration a = dv/dt. " +
        "Energy is conserved: E = (1/2)*m*v² + (1/2)*k*x², where kinetic energy KE = (1/2)*m*v² and potential energy PE = (1/2)*k*x²."
    ),
    generateSpringMassTest(
        "Damped Spring-Mass System",
        "a spring-mass system with damping (friction)",
        "A damped spring-mass system experiences both spring force and damping force. " +
        "The total force is F = -kx - bv, where k is spring constant, b is damping coefficient, and v is velocity. " +
        "Newton's second law gives: ma = -kx - bv, or a = -(k/m)*x - (b/m)*v. " +
        "The system loses energy over time due to damping, causing oscillation amplitude to decrease exponentially. " +
        "Acceleration must still be the derivative of velocity, and velocity the derivative of position."
    ),
    generateSpringMassTest(
        "Spring-Mass System with Large Displacement",
        "a spring-mass system with a large initial displacement",
        "For larger displacements, Hooke's law F = -kx still applies (assuming the spring remains in the linear regime). " +
        "Newton's second law: F = ma = -kx, so a = -(k/m)*x. " +
        "The system exhibits simple harmonic motion regardless of amplitude (unlike a pendulum where nonlinearity appears). " +
        "Energy conservation: total energy E = (1/2)*m*v² + (1/2)*k*x² remains constant. " +
        "Maximum velocity occurs at equilibrium (x=0), and maximum displacement occurs when v=0."
    )
];

/**
 * Test cases for gas laws
 */
const gasLawTests = [
    generateGasLawTest(
        "Isothermal Gas Process",
        "an isothermal process where gas temperature remains constant while volume changes",
        "For an ideal gas, PV = nRT, where P is pressure, V is volume, n is moles, R is gas constant, and T is temperature. " +
        "In an isothermal process, temperature T is constant, so PV = constant. " +
        "If volume increases, pressure must decrease proportionally to maintain PV = nRT. " +
        "If volume decreases, pressure increases. The relationship is P = nRT/V, showing inverse proportionality. " +
        "All variables (P, V, T) must remain positive throughout the process."
    ),
    generateGasLawTest(
        "Isobaric Gas Process",
        "an isobaric process where gas pressure remains constant while temperature changes",
        "For an ideal gas at constant pressure, V/T = nR/P = constant (Charles's Law). " +
        "If temperature increases, volume must increase proportionally to maintain the ideal gas law PV = nRT. " +
        "If temperature decreases, volume decreases. The relationship is V = (nR/P)*T. " +
        "Pressure remains constant while volume and temperature vary together. " +
        "Temperature must be measured in absolute scale (Kelvin) and cannot be negative."
    ),
    generateGasLawTest(
        "Isochoric Gas Process",
        "an isochoric process where gas volume remains constant while temperature changes",
        "For an ideal gas at constant volume, P/T = nR/V = constant (Gay-Lussac's Law). " +
        "If temperature increases, pressure must increase proportionally to maintain PV = nRT. " +
        "If temperature decreases, pressure decreases. The relationship is P = (nR/V)*T. " +
        "Volume remains constant while pressure and temperature vary together. " +
        "This represents heating or cooling a gas in a rigid container."
    )
];

/**
 * The groups of tests to be evaluated as a part of this category
 */
export const groups = {
    pendulumPhysics: pendulumTests,
    springMassPhysics: springMassTests,
    gasLaws: gasLawTests
};
