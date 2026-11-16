/**
 * Computes every category's floor for each null agent: the share of its tests the agent passes. The
 * judge must already be replaced by the null agent's reading (see buildFloors.js, and the floors
 * unit test, which mock it).
 */
import { nullResponse } from './nullAgents.js';

export const floorOf = async function(category, agent) {
    const tests = Object.values(category.groups).flat();
    let passed = 0;
    for (const t of tests) {
        let failures;
        try {
            failures = await category.evaluate(nullResponse(agent, t), t.expectations);
        } catch (error) {
            failures = [{ type: 'Error', details: error.message }];
        }
        if (!failures.length) passed++;
    }
    return { passed, total: tests.length, share: tests.length ? Number((passed / tests.length).toFixed(3)) : 0 };
};
