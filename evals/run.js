import dataForge from 'data-forge';
import Table  from 'cli-table3';
import { spawnSync } from 'child_process';
import fs from 'fs';

import { RateLimiter } from "limiter";

import cliProgress from 'cli-progress';

const printTable = function(results) {
    const table = new Table({
        head: results.getColumnNames()
    });
    table.push(...results.toRows());
    console.log(table.toString());
}

const compareRelationshipLists = function(fromAI, groundTruth) {
    const failures = [];
    
    const stringifyRelationship = function(r) {
        return r.from + " --> (" + r.polarity + ") " + r.to;
    };

    const comparator = function(a, b) {
        if ( a.textRepresentation < b.textRepresentation ){
            return -1;
        }
        if ( a.textRepresentation > b.textRepresentation ){
            return 1;
        }
        return 0;
    };

    const relationshipEqualityComparatorGenerator = function(a) {
        return (b) => {
            return (a.from.toLowerCase() === b.from.toLowerCase() && 
                a.to.toLowerCase() === b.to.toLowerCase()); 
        };
    };

    const cleanedSortedAI = fromAI.map((r)=> {
        delete r.reasoning; //these attributes aren't in ground truth
        delete r.polarityReasoning; //these attributes aren't in ground truth
        r.textRepresentation = stringifyRelationship(r);
        return r;
    }).sort(comparator);

    const sortedGroundTruth = groundTruth.map((r)=> {
        r.textRepresentation = stringifyRelationship(r);
        return r;
    }).sort(comparator);

    const removed = sortedGroundTruth.filter((element) => { return !cleanedSortedAI.some(relationshipEqualityComparatorGenerator(element))});
    const added = cleanedSortedAI.filter((element) => { return !sortedGroundTruth.some(relationshipEqualityComparatorGenerator(element))});

    const addedStr = added.map((r)=>{return r.textRepresentation}).join(", ");
    const removedStr = removed.map((r)=>{return r.textRepresentation}).join(", ");
    const groundTruthStr = sortedGroundTruth.map((r)=>{return r.textRepresentation}).join(", ");

    if (added.length > 0) {
        failures.push("Fake relationships found\n" + addedStr + "\nGround Truth\n" + groundTruthStr);
    }
    
    if (removed.length > 0) {
        failures.push("Real relationships not found\n" + removedStr + "\nGround Truth\n" + groundTruthStr);
    }

    for (const groundTruthRelationship of sortedGroundTruth) {
        let aiRelationship = cleanedSortedAI.find(relationshipEqualityComparatorGenerator(groundTruthRelationship));
        if (aiRelationship && aiRelationship.polarity !== groundTruthRelationship.polarity) {
            failures.push("Incorrect polarity discovered");
        }
    }

    return {
        pass: failures.length === 0,
        failures: failures
    };
};

const experiment = JSON.parse(fs.readFileSync('./evals/experiment.json', 'utf8'));

// goal of tests is to create a pretty flat denormaized structure
// but all keyed on engine name so that we can easily rate limit by engine
const tests = Object.fromEntries(await Promise.all(experiment.engine_configs.map(async engine_config => {
    // return all the map of all tests in a group if filter is true
    // return only the tests in the groups specified by filter if list is provided
    // return nothing if criteria isn't mentioned
    const allTests = Object.fromEntries(await Promise.all(Object.entries(experiment.categories).map(async ([c, filter]) => {
        const { groups } = await import(`./categories/${c}.js`);
        if (filter === true) 
            return [c, groups]
        return [c, Object.fromEntries(Object.entries(groups).filter(([group_name, _]) => {
            // only include groups that are specified
            return filter.indexOf(group_name) > -1
        }))]
    })))

    // jam the details of the engine and the category and group into the test itself 
    const fullTests = Object.entries(allTests).map(([category, groups]) => {
        return Object.entries(groups).map(([group_name, tests]) => {
            return tests.map((test) => {
                const clonedTest = structuredClone(test);
                clonedTest["engine_config"] = engine_config 
                clonedTest["engine_config_name"] = engine_config.name 
                clonedTest["category"] = category
                clonedTest["group"] = group_name;
                return clonedTest 
            })
        })
    });

    return [engine_config.name, fullTests.flat(2)]
})))

console.log("testing engine configs:", Object.keys(tests).join(", "));
const exampleTest = Object.entries(tests)[0][1];
printTable(new dataForge.DataFrame({
    values: exampleTest
}).subset(["category", "group"]).pivot(
    ["category", "group"], 
    "prompt", 
    series => series.count()
).renameSeries({
    prompt: "# tests"
}))


console.log("Press enter to continue...");
spawnSync("read _ ", {shell: true, stdio: [0, 1, 2]});

const progress = new cliProgress.MultiBar(
    {
        clearOnComplete: true,
        hideCursor: true, 
        format: '{bar} | ETA: {eta}s | {value}/{total} | {engine_config_name} | {inProgress}',
    }, 
    cliProgress.Presets.rect
);

// using promise.all here to kick off all the engine configs tests at once 
const responses = await Promise.all(Object.entries(tests).map(async ([engine_config_name, engine_tests]) => {
    const limiter = new RateLimiter({ tokensPerInterval: 5, interval: "second" });
    const engine_bar = progress.create(engine_tests.length, 0, { engine_config_name });

    const inProgress = new Set()
    const progressPrint = (s) => {
        return `[${s.size} generating]: ${Array.from(s).join(", ")})`
    }

    // but pausing the execution of each test with the await ratelimiter
    const testRuns = await Promise.all(engine_tests.map(async test => {
        await limiter.removeTokens(1);

        const testWithResult = structuredClone(test)
        inProgress.add(testWithResult["description"]);

        engine_bar.update({ inProgress: progressPrint(inProgress) });

        const engine = await import(`../engines/${test["engine_config"]["engine"]}/engine.js`);
        const instance = new engine.default();

        const engineSpecificParameters = Object.fromEntries(Object.entries(testWithResult).filter(([k, v]) => {
            return ["prompt", "currentModel", "expectedRelationships"].indexOf(k) == -1
        }));

        let generateResponse = await instance.generate(
            testWithResult["prompt"],
            testWithResult["currentModel"],
            engineSpecificParameters
        );
        testWithResult["result"] = generateResponse.model.relationships;

        inProgress.delete(testWithResult["description"]);
        engine_bar.increment(1, { inProgress: progressPrint(inProgress) });

        return testWithResult 
    }));
    engine_bar.update({ inProgress: "[Done]" }); 
    return testRuns
}))

progress.stop()

const results = new dataForge.DataFrame({ values: responses.flat(1) }).withSeries({
    comparison: df => df.select(row => compareRelationshipLists(row["result"], row["expectedRelationships"]))
}).withSeries({
    pass: df => df.select(row => row["comparison"]["pass"] ? 1 : 0),
    failures: df => df.select(row => row["comparison"]["failures"])
}).subset(["engine_config_name", "category", "group", "description", "pass", "failures"])
//printTable(results.subset(["engine_config_name", "category", "group", "description", "pass"]))

fs.writeFileSync('raw_results.csv', await results.toCSV());

const pivotted = results.pivot(
    ["engine_config_name", "category", "group"], 
    "pass", 
    series => series.average()
).renameSeries({ pass: "score" })

printTable(pivotted);