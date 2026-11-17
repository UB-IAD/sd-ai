import { describe, test, expect } from '@jest/globals';
import { simTest } from './simTest.js';
import * as behavioralPattern from '../../evals/categories/behavioralPattern.js';

describe('Behavioral Pattern Evaluation', () => {

    describe('Evaluate Function', () => {
        test('should fail when model is missing', async () => {
            const response = {};
            const requirements = { expectedBehavior: 'exponential_growth' };

            const result = await behavioralPattern.evaluate(response, requirements);

            expect(result.length).toBeGreaterThan(0);
            expect(result[0].type).toBe('Missing model');
        });

        test('should fail when output variable is missing', async () => {
            const response = {
                model: {
                    variables: [
                        { name: 'x', type: 'stock', equation: '10' }
                    ],
                    relationships: []
                }
            };
            const requirements = { expectedBehavior: 'exponential_growth' };

            const result = await behavioralPattern.evaluate(response, requirements);

            expect(result.length).toBeGreaterThan(0);
            expect(result[0].type).toBe('Missing output variable');
        });

        simTest('should detect output variable case-insensitively', async () => {
            const response = {
                model: {
                    variables: [
                        { name: 'OUTPUT', type: 'stock', equation: '10' }
                    ],
                    relationships: []
                }
            };
            const requirements = { expectedBehavior: 'exponential_growth' };

            const result = await behavioralPattern.evaluate(response, requirements);

            // Should not fail for missing output variable (will fail later in conversion/simulation)
            const missingOutputError = result.find(f => f.type === 'Missing output variable');
            expect(missingOutputError).toBeUndefined();
        }, 30000);
    });
});
