import { DOCKER_TIMEOUT_MS } from '../../../engines/simlin-agent/engine.js';

describe('SimlinAgentEngine', () => {
    describe('DOCKER_TIMEOUT_MS', () => {
        it('should be set to 20 minutes for complex error-fixing tasks', () => {
            expect(DOCKER_TIMEOUT_MS).toBe(20 * 60 * 1000);
        });
    });
});
