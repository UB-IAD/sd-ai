import PySDSimulator, { evenLookups, MAX_LOOKUP_POINTS } from '../../evals/utilities/simulator/PySDSimulator.js';
import SDJsonToXMILE from '../../utilities/SDJsonToXMILE.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('PySDSimulator', () => {
    let armsRaceContent;
    let bassDiffusionContent;
    const TIMEOUT = 5*60*1000;
    beforeAll(() => {
        // Load the XMILE model files
        const armsRacePath = join(__dirname, '../../evals/categories/feedbackExplanationData/armsRace.stmx');
        const bassDiffusionPath = join(__dirname, '../../evals/categories/feedbackExplanationData/bassDiffusion.stmx');

        armsRaceContent = readFileSync(armsRacePath, 'utf8');
        bassDiffusionContent = readFileSync(bassDiffusionPath, 'utf8');
    });

    describe('Constructor', () => {
        test('should create simulator with valid XMILE content', () => {
            expect(() => new PySDSimulator(armsRaceContent)).not.toThrow();
        }, TIMEOUT);

        test('should throw error for empty content', () => {
            expect(() => new PySDSimulator('')).toThrow('xmileContent must be a non-empty string');
        }, TIMEOUT);

        test('should throw error for non-string content', () => {
            expect(() => new PySDSimulator(null)).toThrow('xmileContent must be a non-empty string');
            expect(() => new PySDSimulator(undefined)).toThrow('xmileContent must be a non-empty string');
            expect(() => new PySDSimulator(123)).toThrow('xmileContent must be a non-empty string');
        }, TIMEOUT);
    });

    describe('getAvailableVariables', () => {
        test('should return variables for armsRace model', async () => {
            const simulator = new PySDSimulator(armsRaceContent);
            const variables = await simulator.getAvailableVariables();

            expect(Array.isArray(variables)).toBe(true);
            expect(variables.length).toBeGreaterThan(0);

            // Check for key variables in the arms race model
            expect(variables).toContain('Our Weapons');
            expect(variables).toContain('Their Weapons');
        }, TIMEOUT);

        test('should return variables for bassDiffusion model', async () => {
            const simulator = new PySDSimulator(bassDiffusionContent);
            const variables = await simulator.getAvailableVariables();

            expect(Array.isArray(variables)).toBe(true);
            expect(variables.length).toBeGreaterThan(0);

            // Check for key variables in the bass diffusion model
            expect(variables).toContain('Adopters');
            expect(variables).toContain('Potential Adopters');
        }, TIMEOUT);
    });

    describe('simulate - armsRace model', () => {
        let simulator;

        beforeEach(() => {
            simulator = new PySDSimulator(armsRaceContent);
        });

        test('should compute correct final values at t=50', async () => {
            const results = await simulator.simulate(['Our Weapons', 'Their Weapons']);

            const finalOurWeapons = results['Our Weapons'][results['Our Weapons'].length - 1];
            const finalTheirWeapons = results['Their Weapons'][results['Their Weapons'].length - 1];

            // Expected values from PySD simulation at t=50
            expect(finalOurWeapons).toBeCloseTo(36.76, 1);  // ~36.76 missiles
            expect(finalTheirWeapons).toBeCloseTo(36.76, 1);  // ~36.76 missiles

            // Both sides should converge to approximately equal arsenals
            expect(Math.abs(finalOurWeapons - finalTheirWeapons)).toBeLessThan(0.01);
        }, TIMEOUT);

    });

    describe('simulate - bassDiffusion model', () => {
        let simulator;

        beforeEach(() => {
            simulator = new PySDSimulator(bassDiffusionContent);
        });

        test('should compute correct final values at t=15', async () => {
            const results = await simulator.simulate(['Adopters', 'Potential Adopters', 'adopting']);

            const finalAdoters = results.Adopters[results.Adopters.length - 1];
            const finalPotential = results['Potential Adopters'][results['Potential Adopters'].length - 1];
            const finalAdoptionRate = results.adopting[results.adopting.length - 1];

            // Expected values from PySD simulation at t=15
            // Market is nearly saturated - almost all potential adopters have adopted
            expect(finalAdoters).toBeCloseTo(999785, -2);  // ~999,785 adopters (99.98% of market)
            expect(finalPotential).toBeCloseTo(215, 0);     // ~215 potential adopters remaining
            expect(finalAdoptionRate).toBeCloseTo(322, 0);  // ~322 adopters/year (declining rate)

            // Total population should be conserved (1,000,000)
            const totalPopulation = finalAdoters + finalPotential;
            expect(totalPopulation).toBeCloseTo(1000000, -2);
        }, TIMEOUT);

    });

    describe('XMILE builtin constants', () => {
        // XMILE's bare PI builtin: PySD read it as a variable named pi and failed to load
        // the model, which failed correct pendulum answers in the v2 physicalLaws evals.
        const xmileFor = (variables) => SDJsonToXMILE({
            model: {
                variables,
                relationships: [],
                specs: { startTime: 0, stopTime: 1, dt: 0.5, timeUnits: 'seconds' }
            }
        }, { modelName: 'pi test', vendor: 'SD-AI Evaluation', product: 'sd-ai-evals', version: '1.0' });

        test('should evaluate a bare PI as the builtin constant', async () => {
            const simulator = new PySDSimulator(xmileFor([
                { name: 'radius', type: 'variable', equation: '2' },
                { name: 'circumference', type: 'variable', equation: '2*PI*radius' }
            ]));
            const results = await simulator.simulate(['circumference']);
            expect(results['circumference'][0]).toBeCloseTo(4 * Math.PI, 9);
        }, TIMEOUT);

        test('should leave PI alone when the model defines its own pi', async () => {
            const simulator = new PySDSimulator(xmileFor([
                { name: 'pi', type: 'variable', equation: '3' },
                { name: 'doubled', type: 'variable', equation: '2*pi' }
            ]));
            const results = await simulator.simulate(['doubled']);
            expect(results['doubled'][0]).toBeCloseTo(6, 9);
        }, TIMEOUT);
    });

    describe('lookups with uneven x points', () => {
        // PySD ignores <xpts> and spaces <ypts> evenly over <xscale>, so a lookup with
        // breakpoints at 0, 1 and 10 was read as if they were at 0, 5 and 10.
        const xmileFor = (points, gfType) => {
            const xmile = SDJsonToXMILE({
                model: {
                    variables: [
                        { name: 'effect', type: 'variable', equation: 'TIME', graphicalFunction: { points } }
                    ],
                    relationships: [],
                    specs: { startTime: 0, stopTime: 12, dt: 1, timeUnits: 'months' }
                }
            }, { modelName: 'lookup test', vendor: 'SD-AI Evaluation', product: 'sd-ai-evals', version: '1.0' });
            return gfType ? xmile.replace('<gf>', `<gf type="${gfType}">`) : xmile;
        };
        const uneven = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 10, y: 2 }];
        const truth = (t) => (t <= 1 ? t : 1 + (t - 1) / 9);

        test('should honour uneven x points', async () => {
            const results = await new PySDSimulator(xmileFor(uneven, null)).simulate(['effect']);
            for (let t = 0; t <= 10; t++) expect(results.effect[t]).toBeCloseTo(truth(t), 6);
        }, TIMEOUT);

        test('should hold the last value beyond the last point, as before', async () => {
            const results = await new PySDSimulator(xmileFor(uneven, null)).simulate(['effect']);
            expect(results.effect[12]).toBeCloseTo(2, 6);
        }, TIMEOUT);

        test('should resample on the coarsest exact grid, and leave even lookups alone', () => {
            const resampled = evenLookups(xmileFor(uneven, null));
            expect(resampled).not.toMatch(/<xpts>/);
            expect(resampled.match(/<ypts>([^<]*)<\/ypts>/)[1].split(',')).toHaveLength(11);
            const even = xmileFor([{ x: 0, y: 0 }, { x: 5, y: 1 }, { x: 10, y: 2 }], null);
            expect(evenLookups(even)).toBe(even);
        });

        test('should leave a discrete lookup alone', () => {
            const discrete = xmileFor(uneven, 'discrete');
            expect(evenLookups(discrete)).toBe(discrete);
        });

        test('should approximate closely when no small exact grid exists', () => {
            const points = [{ x: 0, y: 0 }, { x: 0.0000013, y: 1 }, { x: 10, y: 2 }];
            const ys = evenLookups(xmileFor(points, null)).match(/<ypts>([^<]*)<\/ypts>/)[1].split(',').map(Number);
            expect(ys).toHaveLength(MAX_LOOKUP_POINTS);
            expect(ys[ys.length - 1]).toBeCloseTo(2, 12);
        });
    });

    describe('variable names', () => {
        // PySD matches element names exactly; XMILE treats case, spaces, underscores and line
        // breaks as insignificant. The wrapper resolves the difference and answers under the
        // caller's spelling.
        test('should accept any XMILE spelling of a name with spaces or line breaks', async () => {
            const simulator = new PySDSimulator(armsRaceContent);
            const results = await simulator.simulate(['Our Weapons', 'our_weapons', 'OUR WEAPONS']);
            expect(results['our_weapons']).toEqual(results['Our Weapons']);
            expect(results['OUR WEAPONS']).toEqual(results['Our Weapons']);
        }, TIMEOUT);

        test('should accept spaces and case for a model written with underscores', async () => {
            const xmile = SDJsonToXMILE({
                model: {
                    variables: [
                        { name: 'Angular Velocity', type: 'stock', equation: '1', inflows: ['Spin Up'] },
                        { name: 'Spin Up', type: 'flow', equation: '2' }
                    ],
                    relationships: [],
                    specs: { startTime: 0, stopTime: 1, dt: 0.5, timeUnits: 'seconds' }
                }
            }, { modelName: 'names', vendor: 'SD-AI Evaluation', product: 'sd-ai-evals', version: '1.0' });
            const results = await new PySDSimulator(xmile).simulate(['angular velocity', 'Angular_Velocity']);
            expect(results['angular velocity']).toEqual([1, 2, 3]);
            expect(results['Angular_Velocity']).toEqual([1, 2, 3]);
        }, TIMEOUT);
    });

    describe('modular models', () => {
        // PySD loads only the root <model>: a module variable was "not found as model element"
        // and a ghost failed the load with "list index out of range". The wrapper flattens
        // modules first, and the caller still asks for module.variable.
        test('should simulate a two-module model with a ghost', async () => {
            const xmile = SDJsonToXMILE({
                model: {
                    variables: [
                        { name: 'foxes.count', type: 'stock', equation: '5' },
                        { name: 'chickens.count', type: 'stock', equation: '10', outflows: ['chickens.deaths'] },
                        { name: 'chickens.deaths', type: 'flow', equation: 'count*foxes_count*0.01' },
                        { name: 'chickens.foxes count', type: 'variable', equation: '', crossLevelGhostOf: 'foxes.count' }
                    ],
                    modules: [{ name: 'foxes', parentModule: '' }, { name: 'chickens', parentModule: '' }],
                    relationships: [],
                    specs: { startTime: 0, stopTime: 2, dt: 1, timeUnits: 'years' }
                }
            }, { modelName: 'modules', vendor: 'SD-AI Evaluation', product: 'sd-ai-evals', version: '1.0' });
            const results = await new PySDSimulator(xmile).simulate(['chickens.count', 'foxes.count']);
            expect(results['chickens.count']).toEqual([10, 9.5, 9.025]);
            expect(results['foxes.count']).toEqual([5, 5, 5]);
        }, TIMEOUT);
    });

    describe('integration method', () => {
        // x'' = -x from x = 1: amplitude stays 1. PySD only does Euler, which at dt 0.1 over
        // 20 time units inflates it to about 2.7; an RK4 model is run at a finer step instead.
        const oscillator = (method) => SDJsonToXMILE({
            model: {
                variables: [
                    { name: 'x', type: 'stock', equation: '1', inflows: ['dx'] },
                    { name: 'v', type: 'stock', equation: '0', inflows: ['dv'] },
                    { name: 'dx', type: 'flow', equation: 'v' },
                    { name: 'dv', type: 'flow', equation: '-x' }
                ],
                relationships: [],
                specs: { startTime: 0, stopTime: 20, dt: 0.1, timeUnits: 'seconds', integrationMethod: method }
            }
        }, { modelName: 'oscillator', vendor: 'SD-AI Evaluation', product: 'sd-ai-evals', version: '1.0' });

        test('should run an RK4 model finely and return its own time grid', async () => {
            const results = await new PySDSimulator(oscillator('RK4')).simulate(['x']);
            expect(results.time).toHaveLength(201);
            expect(results.time[1]).toBeCloseTo(0.1, 9);
            expect(results.time[200]).toBeCloseTo(20, 9);
            expect(Math.max(...results.x)).toBeLessThan(1.15);
            expect(results.x[200]).toBeCloseTo(Math.cos(20), 1);
        }, TIMEOUT);

        test('should run an Euler model exactly as written', async () => {
            const results = await new PySDSimulator(oscillator('Euler')).simulate(['x']);
            expect(results.time).toHaveLength(201);
            expect(Math.max(...results.x)).toBeGreaterThan(2);
        }, TIMEOUT);

        test('should reject a run PySD stopped before its stop time', async () => {
            // Far past the step count at which PySD stops partway and still reports success.
            const xmile = oscillator('Euler').replace(/<dt>[^<]*<\/dt>/, '<dt>0.00002</dt>');
            await expect(new PySDSimulator(xmile).simulate(['x'])).rejects.toThrow(/ended early/);
        }, TIMEOUT);
    });

    describe('Error handling', () => {
        test('should handle invalid XMILE content gracefully', async () => {
            const invalidXmile = '<xmile>invalid content</xmile>';
            const simulator = new PySDSimulator(invalidXmile);

            await expect(simulator.simulate(['test'])).rejects.toThrow();
        });

        test('should provide meaningful error message for missing variables', async () => {
            const simulator = new PySDSimulator(armsRaceContent);

            await expect(simulator.simulate(['InvalidVariable']))
                .rejects
                .toThrow(/Variable.*not found/i);
        });
    });
});
