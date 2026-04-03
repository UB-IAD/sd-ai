import SimlinAgentEngine from '../../../engines/simlin-agent/engine.js';

describe('SimlinAgentEngine', () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;

    beforeEach(() => {
        delete process.env.ANTHROPIC_API_KEY;
    });

    afterEach(() => {
        if (savedKey !== undefined) {
            process.env.ANTHROPIC_API_KEY = savedKey;
        }
    });

    it('returns an error when no anthropicKey is provided', async () => {
        const engine = new SimlinAgentEngine();
        const result = await engine.generate('test prompt', null, {});
        expect(result).toEqual({
            err: 'Missing anthropicKey parameter (set via request or ANTHROPIC_API_KEY env var)'
        });
    });
});
