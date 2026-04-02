import SDJsonToXMILE from '../../utilities/SDJsonToXMILE.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('SDJsonToXMILE', () => {
    describe('Basic Structure', () => {
        test('should generate valid XML with required header', () => {
            const sdJson = {
                variables: [
                    { name: 'population', type: 'stock', equation: '100' }
                ],
                relationships: []
            };

            const xmile = SDJsonToXMILE(sdJson);

            expect(xmile).toContain('<?xml version="1.0" encoding="UTF-8"?>');
            expect(xmile).toContain('<xmile version="1.0" xmlns="http://docs.oasis-open.org/xmile/ns/XMILE/v1.0">');
            expect(xmile).toContain('<header>');
            expect(xmile).toContain('<vendor>BEAMS Initiative</vendor>');
            expect(xmile).toContain('<product version="1.0">sd-ai</product>');
            expect(xmile).toContain('</xmile>');
        });

        test('should accept model wrapped in model property', () => {
            const sdJson = {
                model: {
                    variables: [
                        { name: 'test', type: 'variable', equation: '5' }
                    ],
                    relationships: []
                }
            };

            const xmile = SDJsonToXMILE(sdJson);
            expect(xmile).toContain('<aux name="test">');
        });

        test('should throw error for invalid input', () => {
            expect(() => SDJsonToXMILE({})).toThrow('Invalid SD-JSON: missing or invalid variables array');
            expect(() => SDJsonToXMILE({ variables: [] })).toThrow('Invalid SD-JSON: missing or invalid relationships array');
        });
    });

    describe('Stocks', () => {
        test('should generate stock with basic properties', () => {
            const sdJson = {
                variables: [
                    {
                        name: 'Population',
                        type: 'stock',
                        equation: '100',
                        units: 'people',
                        documentation: 'Total population',
                        inflows: ['births'],
                        outflows: ['deaths']
                    }
                ],
                relationships: []
            };

            const xmile = SDJsonToXMILE(sdJson);

            expect(xmile).toContain('<stock name="Population">');
            expect(xmile).toContain('<doc>Total population</doc>');
            expect(xmile).toContain('<eqn>100</eqn>');
            expect(xmile).toContain('<inflow>births</inflow>');
            expect(xmile).toContain('<outflow>deaths</outflow>');
            expect(xmile).toContain('<units>people</units>');
            expect(xmile).toContain('</stock>');
        });

        test('should handle stock names with spaces and special characters', () => {
            const sdJson = {
                variables: [
                    { name: 'Total Population', type: 'stock', equation: '1000' }
                ],
                relationships: []
            };

            const xmile = SDJsonToXMILE(sdJson);
            expect(xmile).toContain('<stock name="Total_Population">');
        });

        test('should handle newlines in stock names via xmileName conversion', () => {
            const sdJson = {
                variables: [
                    { name: 'Two\nLines', type: 'stock', equation: '50' }
                ],
                relationships: []
            };

            const xmile = SDJsonToXMILE(sdJson);
            // utils.xmileName converts \n to space, then spaces to underscores
            expect(xmile).toContain('name="Two_Lines"');
        });
    });

    describe('Flows', () => {
        test('should NOT generate non_negative tag by default', () => {
            const sdJson = {
                variables: [
                    { name: 'births', type: 'flow', equation: 'population * 0.1' }
                ],
                relationships: []
            };

            const xmile = SDJsonToXMILE(sdJson);

            expect(xmile).toContain('<flow name="births">');
            expect(xmile).not.toContain('<non_negative/>');
            expect(xmile).toContain('<eqn>population * 0.1</eqn>');
        });

        test('should include non_negative when uniflow is true', () => {
            const sdJson = {
                variables: [
                    { name: 'births', type: 'flow', equation: 'population * 0.1', uniflow: true }
                ],
                relationships: []
            };

            const xmile = SDJsonToXMILE(sdJson);

            expect(xmile).toContain('<flow name="births">');
            expect(xmile).toContain('<non_negative/>');
        });

        test('should NOT include non_negative when uniflow is undefined', () => {
            const sdJson = {
                variables: [
                    { name: 'production', type: 'flow', equation: '50' }
                ],
                relationships: []
            };

            const xmile = SDJsonToXMILE(sdJson);

            expect(xmile).not.toContain('<non_negative/>');
        });

        test('should NOT include non_negative when uniflow is false', () => {
            const sdJson = {
                variables: [
                    { name: 'net change', type: 'flow', equation: 'inflow - outflow', uniflow: false }
                ],
                relationships: []
            };

            const xmile = SDJsonToXMILE(sdJson);
            const flowSection = xmile.substring(
                xmile.indexOf(`<flow name=`),
                xmile.indexOf('</flow>') + 7
            );

            expect(flowSection).not.toContain('<non_negative/>');
        });

        test('should handle multiple flows with different uniflow settings', () => {
            const sdJson = {
                variables: [
                    { name: 'births', type: 'flow', equation: '10', uniflow: true },
                    { name: 'deaths', type: 'flow', equation: '5', uniflow: true },
                    { name: 'net migration', type: 'flow', equation: 'immigrants - emigrants', uniflow: false }
                ],
                relationships: []
            };

            const xmile = SDJsonToXMILE(sdJson);

            // births and deaths should be non-negative
            const birthsSection = xmile.substring(
                xmile.indexOf('<flow name="births">'),
                xmile.indexOf('</flow>', xmile.indexOf('<flow name="births">'))
            );
            expect(birthsSection).toContain('<non_negative/>');

            const deathsSection = xmile.substring(
                xmile.indexOf('<flow name="deaths">'),
                xmile.indexOf('</flow>', xmile.indexOf('<flow name="deaths">'))
            );
            expect(deathsSection).toContain('<non_negative/>');

            // net migration should NOT be non-negative
            const migrationSection = xmile.substring(
                xmile.indexOf('<flow name="net_migration">'),
                xmile.indexOf('</flow>', xmile.indexOf('<flow name="net_migration">'))
            );
            expect(migrationSection).not.toContain('<non_negative/>');
        });

        test('should generate NAN equation for flows without equations', () => {
            const sdJson = {
                variables: [
                    { name: 'births', type: 'flow' },
                    { name: 'population', type: 'stock', equation: '100' }
                ],
                relationships: [
                    { from: 'population', to: 'births' }
                ]
            };

            const xmile = SDJsonToXMILE(sdJson);
            expect(xmile).toContain('<eqn>NAN(population)</eqn>');
        });
    });

    describe('Auxiliaries', () => {
        test('should generate auxiliary with basic properties', () => {
            const sdJson = {
                variables: [
                    {
                        name: 'birth rate',
                        type: 'variable',
                        equation: '0.05',
                        units: 'per year',
                        documentation: 'Annual birth rate'
                    }
                ],
                relationships: []
            };

            const xmile = SDJsonToXMILE(sdJson);

            expect(xmile).toContain('<aux name="birth_rate">');
            expect(xmile).toContain('<doc>Annual birth rate</doc>');
            expect(xmile).toContain('<eqn>0.05</eqn>');
            expect(xmile).toContain('<units>per year</units>');
        });

        test('should add isee:delay_aux tag for auxiliaries without equations', () => {
            const sdJson = {
                variables: [
                    { name: 'delayed value', type: 'variable' }
                ],
                relationships: []
            };

            const xmile = SDJsonToXMILE(sdJson);
            expect(xmile).toContain('<isee:delay_aux/>');
        });

        test('should add isee:delay_aux tag for auxiliaries with NAN equations', () => {
            const sdJson = {
                variables: [
                    { name: 'placeholder', type: 'variable', equation: 'NAN(var1,var2)' }
                ],
                relationships: []
            };

            const xmile = SDJsonToXMILE(sdJson);
            expect(xmile).toContain('<isee:delay_aux/>');
            expect(xmile).toContain('<eqn>NAN(var1,var2)</eqn>');
        });

        test('should generate NAN equation from relationships for auxiliaries without equations', () => {
            const sdJson = {
                variables: [
                    { name: 'effect', type: 'variable' },
                    { name: 'cause1', type: 'variable', equation: '10' },
                    { name: 'cause2', type: 'variable', equation: '20' }
                ],
                relationships: [
                    { from: 'cause1', to: 'effect' },
                    { from: 'cause2', to: 'effect' }
                ]
            };

            const xmile = SDJsonToXMILE(sdJson);
            expect(xmile).toContain('<eqn>NAN(cause1,cause2)</eqn>');
            expect(xmile).toContain('<isee:delay_aux/>');
        });
    });

    describe('Graphical Functions', () => {
        test('should generate graphical function with points', () => {
            const sdJson = {
                variables: [
                    {
                        name: 'multiplier',
                        type: 'variable',
                        equation: 'input_var',
                        graphicalFunction: {
                            points: [
                                { x: 0, y: 0 },
                                { x: 50, y: 0.5 },
                                { x: 100, y: 1 }
                            ]
                        }
                    }
                ],
                relationships: []
            };

            const xmile = SDJsonToXMILE(sdJson);

            expect(xmile).toContain('<gf>');
            expect(xmile).toContain('<xscale min="0" max="100"/>');
            expect(xmile).toContain('<yscale min="0" max="1"/>');
            expect(xmile).toContain('<xpts>0,50,100</xpts>');
            expect(xmile).toContain('<ypts>0,0.5,1</ypts>');
            expect(xmile).toContain('</gf>');
            expect(xmile).toContain('<eqn>input_var</eqn>');
        });
    });

    describe('Simulation Specs', () => {
        test('should generate sim_specs from model specs', () => {
            const sdJson = {
                variables: [
                    { name: 'test', type: 'variable', equation: '1' }
                ],
                relationships: [],
                specs: {
                    startTime: 0,
                    stopTime: 100,
                    dt: 0.25,
                    timeUnits: 'year'
                }
            };

            const xmile = SDJsonToXMILE(sdJson);

            expect(xmile).toContain('<sim_specs>');
            expect(xmile).toContain('<start>0</start>');
            expect(xmile).toContain('<stop>100</stop>');
            expect(xmile).toContain('<dt>0.25</dt>');
            expect(xmile).toContain('<time_units>year</time_units>');
            expect(xmile).toContain('</sim_specs>');
        });

        test('should use defaults for missing sim specs', () => {
            const sdJson = {
                variables: [
                    { name: 'test', type: 'variable', equation: '1' }
                ],
                relationships: [],
                specs: {}
            };

            const xmile = SDJsonToXMILE(sdJson);

            expect(xmile).toContain('<start>0</start>');
            expect(xmile).toContain('<stop>100</stop>');
            expect(xmile).toContain('<dt>1</dt>');
        });
    });

    describe('Array Dimensions', () => {
        test('should generate dimensions for label type arrays', () => {
            const sdJson = {
                variables: [
                    {
                        name: 'population',
                        type: 'stock',
                        equation: '1000',
                        dimensions: ['City']
                    }
                ],
                relationships: [],
                specs: {
                    arrayDimensions: [
                        {
                            name: 'City',
                            type: 'labels',
                            size: 3,
                            elements: ['Boston', 'Chicago', 'LA']
                        }
                    ]
                }
            };

            const xmile = SDJsonToXMILE(sdJson);

            expect(xmile).toContain('<dimensions>');
            expect(xmile).toContain('<dim name="City">');
            expect(xmile).toContain('<elem name="Boston"/>');
            expect(xmile).toContain('<elem name="Chicago"/>');
            expect(xmile).toContain('<elem name="LA"/>');
            expect(xmile).toContain('</dim>');
            expect(xmile).toContain('</dimensions>');
        });

        test('should generate dimensions for numeric type arrays', () => {
            const sdJson = {
                variables: [
                    { name: 'test', type: 'variable', equation: '1' }
                ],
                relationships: [],
                specs: {
                    arrayDimensions: [
                        {
                            name: 'Index',
                            type: 'numeric',
                            size: 5
                        }
                    ]
                }
            };

            const xmile = SDJsonToXMILE(sdJson);

            expect(xmile).toContain('<dim name="Index" size="5"/>');
        });
    });

    describe('Model Units', () => {
        test('should extract and generate model_units section', () => {
            const sdJson = {
                variables: [
                    { name: 'pop', type: 'stock', equation: '100', units: 'people' },
                    { name: 'births', type: 'flow', equation: '10', units: 'people/year' },
                    { name: 'rate', type: 'variable', equation: '0.1', units: 'per year' }
                ],
                relationships: []
            };

            const xmile = SDJsonToXMILE(sdJson);

            expect(xmile).toContain('<model_units>');
            expect(xmile).toContain('<unit name="people">');
            expect(xmile).toContain('<eqn>people</eqn>');
            expect(xmile).toContain('<unit name="people/year">');
            expect(xmile).toContain('<unit name="per year">');
            expect(xmile).toContain('</model_units>');
        });
    });

    describe('XML Escaping', () => {
        test('should escape XML special characters in equations and documentation', () => {
            const sdJson = {
                variables: [
                    {
                        name: 'test',
                        type: 'variable',
                        equation: 'a < b && b > c',
                        documentation: 'Test with <special> & "quoted" characters'
                    }
                ],
                relationships: []
            };

            const xmile = SDJsonToXMILE(sdJson);

            expect(xmile).toContain('&lt;');
            expect(xmile).toContain('&gt;');
            expect(xmile).toContain('&amp;');
            expect(xmile).toContain('&quot;');
        });

        test('should handle newlines and carriage returns in names via xmileName conversion', () => {
            const sdJson = {
                variables: [
                    { name: 'line1\nline2\rline3', type: 'variable', equation: '1' }
                ],
                relationships: []
            };

            const xmile = SDJsonToXMILE(sdJson);

            // utils.xmileName converts \n and \r to spaces, then spaces to underscores
            expect(xmile).toContain('name="line1_line2_line3"');
        });
    });

    describe('Real Model Examples', () => {
        test('should convert predatorPrey model', () => {
            const modelPath = join(__dirname, '../../evals/categories/feedbackExplanationData/predatorPrey.json');
            const fileContent = readFileSync(modelPath, 'utf8');
            const modelData = JSON.parse(fileContent);

            const xmile = SDJsonToXMILE(modelData.model);

            // Check for key stocks
            expect(xmile).toContain('<stock name="Hares">');
            expect(xmile).toContain('<stock name="Lynx">');

            // Check for flows
            expect(xmile).toContain('<flow name="hare_births">');
            expect(xmile).toContain('<flow name="hare_deaths">');
            expect(xmile).toContain('<flow name="lynx_births">');
            expect(xmile).toContain('<flow name="lynx_deaths">');

            // Check for auxiliaries with graphical functions
            expect(xmile).toContain('<aux name="hares_killed_per_lynx">');
            expect(xmile).toContain('<gf>');

            // Check simulation specs
            expect(xmile).toContain('<start>0</start>');
            expect(xmile).toContain('<stop>100</stop>');
            expect(xmile).toContain('<dt>0.03125</dt>');
            expect(xmile).toContain('<time_units>year</time_units>');
        });
    });

    describe('Modules', () => {
        test('should generate nested models for modules', () => {
            const sdJson = {
                variables: [
                    { name: 'Hares.population', type: 'stock', equation: '50000', inflows: ['Hares.births'], outflows: ['Hares.deaths'] },
                    { name: 'Hares.births', type: 'flow', equation: 'Hares.population * Hares.birth_rate' },
                    { name: 'Hares.deaths', type: 'flow', equation: 'Hares.population * 0.1' },
                    { name: 'Hares.birth_rate', type: 'variable', equation: '0.15' },
                    { name: 'Lynx.population', type: 'stock', equation: '850', inflows: ['Lynx.births'], outflows: ['Lynx.deaths'] },
                    { name: 'Lynx.births', type: 'flow', equation: 'Lynx.population * 0.25' },
                    { name: 'Lynx.deaths', type: 'flow', equation: 'Lynx.population * 0.9' }
                ],
                relationships: [],
                modules: [
                    { name: 'Hares', parentModule: '' },
                    { name: 'Lynx', parentModule: '' }
                ]
            };

            const xmile = SDJsonToXMILE(sdJson);

            // Check for module structures
            expect(xmile).toContain('<model name="Hares">');
            expect(xmile).toContain('<model name="Lynx">');

            // Check that variables use local names within modules
            expect(xmile).toContain('<stock name="population">');
            expect(xmile).toContain('<flow name="births">');
            expect(xmile).toContain('<flow name="deaths">');
            expect(xmile).toContain('<aux name="birth_rate">');

            // Should have multiple stocks named "population" (one in each module)
            const populationMatches = xmile.match(/<stock name="population">/g);
            expect(populationMatches).toHaveLength(2);
        });

        test('should handle ghost variables for inter-module references', () => {
            const sdJson = {
                variables: [
                    { name: 'ModuleA.value', type: 'variable', equation: '100' },
                    { name: 'ModuleB.value', type: 'variable', crossLevelGhostOf: 'ModuleA.value', equation: '' },
                    { name: 'ModuleB.result', type: 'variable', equation: 'ModuleB.value * 2' }
                ],
                relationships: [],
                modules: [
                    { name: 'ModuleA', parentModule: '' },
                    { name: 'ModuleB', parentModule: '' }
                ]
            };

            const xmile = SDJsonToXMILE(sdJson);

            // Check for modules
            expect(xmile).toContain('<model name="ModuleA">');
            expect(xmile).toContain('<model name="ModuleB">');

            // Ghost variable should have access="input" and no equation
            expect(xmile).toContain('<aux name="value" access="input">');

            // Source variable should have access="output"
            expect(xmile).toContain('<aux name="value" access="output">');

            // Should have connect tag linking them
            expect(xmile).toContain('<connect to="ModuleB.value" from="ModuleA.value"/>');
        });

        test('should handle top-level variables and modules together', () => {
            const sdJson = {
                variables: [
                    { name: 'time', type: 'variable', equation: 'TIME' },
                    { name: 'Module1.x', type: 'variable', equation: '5' }
                ],
                relationships: [],
                modules: [
                    { name: 'Module1', parentModule: '' }
                ]
            };

            const xmile = SDJsonToXMILE(sdJson);

            // Check for top-level variable
            expect(xmile).toContain('<aux name="time">');

            // Check for module
            expect(xmile).toContain('<model name="Module1">');
            expect(xmile).toContain('<aux name="x">');
        });
    });

    describe('Custom Options', () => {
        test('should accept custom vendor and product names', () => {
            const sdJson = {
                variables: [
                    { name: 'test', type: 'variable', equation: '1' }
                ],
                relationships: []
            };

            const xmile = SDJsonToXMILE(sdJson, {
                vendor: 'Custom Vendor',
                product: 'Custom Product',
                version: '2.0',
                modelName: 'Test Model'
            });

            expect(xmile).toContain('<vendor>Custom Vendor</vendor>');
            expect(xmile).toContain('<product version="2.0">Custom Product</product>');
            expect(xmile).toContain('<name>Test Model</name>');
        });
    });
});
