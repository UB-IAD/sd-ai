import { describe, test, expect } from '@jest/globals';
import { detectOscillationFallback } from '../../../evals/categories/behavioralPattern.js';

/**
 * Generate Van der Pol oscillator output using Euler integration.
 * position' = velocity
 * velocity' = mu * (1 - position^2) * velocity - position
 */
function generateVanDerPol(mu = 1, posInit = 0.1, velInit = 0, dt = 0.03125, stopTime = 100, saveStep = 0.25) {
    let pos = posInit;
    let vel = velInit;
    const saveEvery = Math.round(saveStep / dt);
    const totalSteps = Math.round(stopTime / dt);

    const results = [pos];
    for (let i = 1; i <= totalSteps; i++) {
        const dPos = vel;
        const dVel = mu * (1 - pos * pos) * vel - pos;
        pos += dPos * dt;
        vel += dVel * dt;
        if (i % saveEvery === 0) {
            results.push(pos);
        }
    }
    return results;
}

describe('detectOscillationFallback', () => {

    test('should detect a pure sinusoidal oscillation', () => {
        const data = Array.from({ length: 400 }, (_, i) =>
            2.0 * Math.sin(2 * Math.PI * i / 50)
        );
        const result = detectOscillationFallback(data);
        expect(result.isOscillating).toBe(true);
        expect(result.zeroCrossings).toBeGreaterThanOrEqual(4);
    });

    test('should detect Van der Pol relaxation oscillation', () => {
        const data = generateVanDerPol();
        expect(data.length).toBe(401);

        const result = detectOscillationFallback(data);
        expect(result.isOscillating).toBe(true);
        expect(result.zeroCrossings).toBeGreaterThanOrEqual(4);
        expect(result.sustainedInBothHalves).toBe(true);
    });

    test('should NOT detect a flat/constant time series as oscillating', () => {
        const data = Array.from({ length: 400 }, () => 5.0);
        const result = detectOscillationFallback(data);
        expect(result.isOscillating).toBe(false);
    });

    test('should NOT detect exponential growth as oscillating', () => {
        const data = Array.from({ length: 400 }, (_, i) =>
            Math.exp(0.01 * i)
        );
        const result = detectOscillationFallback(data);
        expect(result.isOscillating).toBe(false);
    });

    test('should NOT detect linear growth as oscillating', () => {
        const data = Array.from({ length: 400 }, (_, i) => 3 * i + 10);
        const result = detectOscillationFallback(data);
        expect(result.isOscillating).toBe(false);
    });

    test('should NOT detect exponential decay as oscillating', () => {
        const data = Array.from({ length: 400 }, (_, i) =>
            100 * Math.exp(-0.02 * i)
        );
        const result = detectOscillationFallback(data);
        expect(result.isOscillating).toBe(false);
    });

    test('should NOT detect s-curve/logistic growth as oscillating', () => {
        const data = Array.from({ length: 400 }, (_, i) =>
            100 / (1 + Math.exp(-0.05 * (i - 200)))
        );
        const result = detectOscillationFallback(data);
        expect(result.isOscillating).toBe(false);
    });

    test('should detect dampened oscillation', () => {
        const data = Array.from({ length: 400 }, (_, i) =>
            5.0 * Math.exp(-0.005 * i) * Math.sin(2 * Math.PI * i / 40)
        );
        const result = detectOscillationFallback(data);
        expect(result.isOscillating).toBe(true);
        expect(result.sustainedInBothHalves).toBe(true);
    });

    test('should NOT detect a tiny oscillation with negligible amplitude', () => {
        // Oscillation with amplitude 0.001 around mean of 100 -- amplitude is
        // less than 10% of |mean|
        const data = Array.from({ length: 400 }, (_, i) =>
            100 + 0.001 * Math.sin(2 * Math.PI * i / 50)
        );
        const result = detectOscillationFallback(data);
        expect(result.isOscillating).toBe(false);
    });

    test('should handle oscillation around a non-zero mean by detrending', () => {
        // Oscillation centered at 50 with amplitude 10
        const data = Array.from({ length: 400 }, (_, i) =>
            50 + 10 * Math.sin(2 * Math.PI * i / 50)
        );
        const result = detectOscillationFallback(data);
        expect(result.isOscillating).toBe(true);
    });

    test('should handle short time series with few points', () => {
        const data = [1, -1, 1, -1, 1];
        const result = detectOscillationFallback(data);
        // 4 zero crossings, has amplitude, but series is very short
        expect(result.isOscillating).toBe(true);
    });

    test('should NOT detect a step function as oscillating', () => {
        const data = Array.from({ length: 400 }, (_, i) =>
            i < 200 ? 0 : 10
        );
        const result = detectOscillationFallback(data);
        expect(result.isOscillating).toBe(false);
    });

    test('should NOT detect noise around zero with too few crossings as oscillating', () => {
        // Just 2 sign changes -- not enough
        const data = Array.from({ length: 400 }, (_, i) => {
            if (i < 100) return 1;
            if (i < 200) return -1;
            if (i < 300) return 0.5;
            return 0.5;
        });
        const result = detectOscillationFallback(data);
        expect(result.zeroCrossings).toBeLessThan(4);
        expect(result.isOscillating).toBe(false);
    });

    test('should NOT detect slow exponential growth with noise as oscillating', () => {
        // A slow exponential with additive noise can produce zero crossings
        // after detrending, but those crossings are irregularly spaced.
        const seed = 12345;
        let rng = seed;
        function pseudoRandom() {
            rng = (rng * 16807 + 0) % 2147483647;
            return (rng / 2147483647) - 0.5;
        }
        const data = Array.from({ length: 400 }, (_, i) =>
            Math.exp(0.005 * i) + 0.5 * pseudoRandom()
        );
        const result = detectOscillationFallback(data);
        expect(result.isOscillating).toBe(false);
    });

    test('should NOT detect noisy non-oscillating data with irregular zero crossings', () => {
        // Random-walk-like data centered near zero produces many zero
        // crossings, but they are irregularly spaced.
        const seed = 67890;
        let rng = seed;
        function pseudoRandom() {
            rng = (rng * 16807 + 0) % 2147483647;
            return (rng / 2147483647) - 0.5;
        }
        const data = [0];
        for (let i = 1; i < 400; i++) {
            data.push(data[i - 1] + pseudoRandom());
        }
        const result = detectOscillationFallback(data);
        expect(result.isOscillating).toBe(false);
    });
});
