import dataForge from "data-forge";

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

import { RateLimiter } from "limiter";
import { Tiktoken } from "js-tiktoken/lite";
import o200k_base from "js-tiktoken/ranks/o200k_base";
const enc = new Tiktoken(o200k_base);

import cliProgress from "cli-progress";
import chalk from "chalk";
import prompts from "prompts";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { withCostAccounting } from "../utilities/costAccounting.js";
import { ANTHROPIC_REFUSAL_PREFIX } from "../utilities/LLMWrapper.js";
import { printTable, pivotAndUnstack, uniqueFileId } from "./helpers.js";
import {
  BASELINE_TOKEN_USAGE,
  TOKENS_PER_MINUTE,
  REQUESTS_PER_MINUTE,
  applyDefaultLimits,
  loadCategoryTests,
  loadTestsForEngine,
  createEngineBackoff,
} from "./runHelpers.js";

import "dotenv/config";

// Running evals: silence the engines' / agent's internal logger so its debug
// output doesn't interleave with the progress bar and result tables. The logger
// re-reads this flag on every call, so it takes effect for modules already
// imported above as well as the engines and categories loaded dynamically below.
// WorkerSpawner forwards the same flag into any sandboxed sub-process it spawns.
// Set SDAI_TEST_MODE explicitly to opt out (e.g. SDAI_TEST_MODE=false) when you
// need the agent's logs while debugging.
process.env.SDAI_TEST_MODE ??= 'true';

const argv = yargs(hideBin(process.argv))
  .option("experiment", {
    alias: "e",
    type: "string",
    description: "Experiment configuration file to use",
    demandOption: true,
  })
  .help().argv;

const experiment = JSON.parse(fs.readFileSync(argv.experiment, "utf8"));
const experimentName = path.basename(path.resolve(argv.experiment)).split(".")[0];

// Normalize verbose flag to integer levels
// false or undefined -> 0, true -> 2, otherwise use the integer value
if (experiment.verbose === false || experiment.verbose === undefined) {
  experiment.verbose = 0;
} else if (experiment.verbose === true) {
  experiment.verbose = 2;
}

const files = fs.readdirSync('.');
const inProgressFileSuffix = "_in_progress.jsonl"
const matchingFiles = files.filter(file => file.includes(`${experimentName}${inProgressFileSuffix}`));

let previousResults = []
let isContinuing = false;
let experimentResultsName;

if (matchingFiles.length > 0) {
    // SDAI_NONINTERACTIVE=1 skips the interactive resume prompt — needed for
    // background/CI runs (prompts hangs on a non-TTY stdin). Defaults to
    // resuming, the same answer the prompt's initial state gives.
    const response = process.env.SDAI_NONINTERACTIVE === '1'
      ? { resume: true }
      : await prompts({
          type: 'toggle',
          name: 'resume',
          message: 'Do you want to resume previous evaluation run? Selecting no will discard previous in progress results.',
          initial: true,
          active: 'yes',
          inactive: 'no'
        });
    isContinuing = response.resume;
    if (isContinuing && matchingFiles.length > 1) {
      console.log(chalk.red(chalk.bold("Found multiple in progress experiment runs. Please delete all files you don't wish to resume from.")));
      matchingFiles.forEach(f => {
        console.log("- " + f)
      })
      process.exit(1)
    }
    if (!isContinuing) {
      matchingFiles.forEach(f => {
        fs.unlinkSync(f);
      });
    }
    console.log()
}

if (isContinuing) {
  const previousFileName = matchingFiles[0];
  previousResults = fs.readFileSync(previousFileName, 'utf-8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l))
  experimentResultsName = previousFileName.replace(inProgressFileSuffix,"")
} else {
  const experimentId = uniqueFileId();
  experimentResultsName = `${experimentId}_${experimentName}`;
}


// goal of tests is to create a pretty flat denormaized structure
// but all keyed on engine name so that we can easily rate limit by engine
const tests = Object.fromEntries(
  (await Promise.all(
    Object.entries(experiment.engineConfigs)
      .map(async ([engineConfigName, rawEngineConfig]) => {
        const engineConfig = applyDefaultLimits(rawEngineConfig);

        const allTests = Object.fromEntries(
          await Promise.all(
            Object.entries(experiment.categories).map(async ([categoryName, filter]) => {
              const { groups } = await import(`./categories/${categoryName}.js`);
              return [categoryName, loadCategoryTests(groups, filter)];
            })
          )
        );

        const engine = await import(`./../engines/${engineConfig.engine}/engine.js`);

        return [engineConfigName, loadTestsForEngine(allTests, engineConfig, engineConfigName)];
      })
  ))
  .filter(entry => entry[0] !== undefined)
);

// A provider 503/429/timeout is a fact about the provider, not about the engine under
// test, so an errored generation is retried rather than scored as a failure.
//
// What happens once the retries are exhausted depends on what kind of error it was, and
// TEST_LEVEL_ERROR_PREFIXES below draws the line. An error that belongs to this one
// generation — a safety refusal, a model emitting output its own engine rejects — scores
// the test as a failure and the config carries on: the model did fail the test, and every
// other prompt would have run fine.
//
// Anything else stops that ENGINE CONFIG. It does not drop the test and carry on: a
// leaderboard missing a test scores that engine over a smaller set than the others, which
// is a silently wrong number rather than an obviously absent one.
//
// The stop is scoped to the engine config that failed, not the whole run. One provider
// being down says nothing about the others, and halting them too used to throw away every
// test still queued behind their rate limiters — hundreds of tests that would have
// finished fine. The other configs now run to completion, so the resume has far less to
// redo. The run as a whole still refuses to publish (see failedTests below): completed
// work stays in <experiment>_in_progress.jsonl and re-running the same experiment resumes
// from there, re-attempting only what is missing.
const MAX_GENERATION_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

// Engine configs that have had a test exhaust its retries. Checked at the point of
// spending so tests still queued behind that config's rate limiter don't buy tokens for a
// config that is already stopping — while tests of every other config carry on.
const stoppedEngineConfigs = new Set();

// Errors that are a property of THIS test's generation rather than of the provider's
// health. Exhausting the retries on one of these scores the test as a failure and lets
// the config carry on; anything else still stops the config, which is what keeps a dead
// provider or a bad key from buying 93 tests' worth of tokens to fail 93 times.
//
// The distinction is which of the two would have run fine: a refusal or a model emitting
// invalid output says nothing about the next prompt, so stopping over it throws away a
// whole config's rows to record one failure. That is not hypothetical — stopping on a
// refusal once cost quantitative-claude-sonnet-5 28 of its 93 rows, and stopping on
// SDCodeError cost quantitative-sdcode-claude-opus-5 23 of its 93 over two tests where
// the model referenced a component it never declared. Both are real results: the model
// failed the test. Recording them as failures is more honest than a hole in the board.
//
// Matched on the error text because that is all an engine returns — engines flatten to
// `{ err: String(e) }`, so there is no error class left to check by the time it lands here.
const TEST_LEVEL_ERROR_PREFIXES = [
    // A safety classifier declined this one prompt.
    ANTHROPIC_REFUSAL_PREFIX,
    // quantitative-sdcode's validator rejecting the model's own SDCode output.
    'SDCodeError',
];

const isTestLevelError = (err) =>
    TEST_LEVEL_ERROR_PREFIXES.some((prefix) => err.includes(prefix));

// Retry backoff, held per engine config rather than per test — see createEngineBackoff.
const engineBackoff = createEngineBackoff();

const failedTests = [];

console.log(chalk.blue("Experiment Configuration:"));
console.log("Experiment Name: " + experimentResultsName);
if (isContinuing) {
  console.log(`  will attempt to use ${previousResults.length} previously saved test results`);
}
console.log("Sequential: " + (experiment.sequential || "false"));
console.log("Verbose: " + experiment.verbose);
console.log(`On error: retry up to ${MAX_GENERATION_RETRIES}x, then score the test as a failure (refusals, invalid model output) or stop the config and keep progress for resume (anything else)`);
console.log();

console.log(chalk.blue("Engine Configurations:"));
printTable(
  new dataForge.DataFrame({
    values: Object.entries(tests).map(([engineConfigName, engineTests]) => {
      return {
        engineConfigName: engineConfigName,
        engine: engineTests[0].engineConfig.engine,
        "tokensPerMinute (TPM)":
          engineTests[0].engineConfig.limits.tokensPerMinute +
          (engineTests[0].engineConfig.limits.tokensPerMinute !=
          TOKENS_PER_MINUTE
            ? "*"
            : ""),
        "requestsPerMinute (RPM)":
          engineTests[0].engineConfig.limits.requestsPerMinute +
          (engineTests[0].engineConfig.limits.requestsPerMinute !=
          REQUESTS_PER_MINUTE
            ? "*"
            : ""),
        baselineTokenUsage:
          engineTests[0].engineConfig.limits.baselineTokenUsage +
          (engineTests[0].engineConfig.limits.baselineTokenUsage !=
          BASELINE_TOKEN_USAGE
            ? "*"
            : ""),
      };
    }),
  })
);
console.log("* indicates override of default values");
console.log();
console.log();

console.log(chalk.blue("Test Configurations:"));
const exampleTest = Object.entries(tests)[0][1];
printTable(
  new dataForge.DataFrame({
    values: exampleTest,
  })
    .subset(["category", "group"])
    .pivot(["category", "group"], "prompt", (series) => series.count())
    .renameSeries({
      prompt: "# tests",
    })
);

console.log();

console.log("Press enter to run this experiment...");

if (process.env.SDAI_NONINTERACTIVE !== '1') {
  if (process.platform === "win32") {
    spawnSync("pause", { shell: true, stdio: [0, 1, 2] });
  } else {
    spawnSync("read _", { shell: true, stdio: [0, 1, 2] });
  }
}


const progress = new cliProgress.MultiBar(
  {
    clearOnComplete: true,
    hideCursor: true,
    format:
      "{bar} | ETA: {eta}s | {earlyResults} = {value} of {total} | {engineConfigName} | {inProgress}",
    stream: experiment.verbose > 0
    ? fs.createWriteStream(process.platform === "win32" ? "NULL" : "/dev/null")
    : process.stderr,

  },
  cliProgress.Presets.rect
);

const printProgress = (s) => {
  if (s.size === 0) return "[paused for rate limiting]";
  return `[${s.size} generating]: ${Array.from(s).join(", ")})`;
};

const printEarlyResults = (r) => {
  // cute little check or x emoji response for pass/fail
  return `${chalk.bold(chalk.green(r[true]))} + ${chalk.bold(
    chalk.red(r[false])
  )}`;
};

// Cache of in-flight engine generations, keyed on the engine + generation inputs. Some categories
// (e.g. policyGuidance) split one engine response into several tests that each grade a different
// criterion of the same discussion; those sibling tests share identical prompt/model/parameters
// and so map to one cache entry, meaning the (often expensive) engine runs once and every sibling
// reuses its result. Storing the promise lets concurrently-scheduled siblings await one call.
const generationCache = new Map();


/** Fold one attempt's cost into a running total for the test. */
function addSpend(total, accounting) {
  if (!accounting) return total;
  total.totalCost += accounting.totalCost;
  total.calls += accounting.calls;
  total.unpricedCalls += accounting.unpricedCalls;
  for (const [model, per] of Object.entries(accounting.byModel)) {
    const entry = (total.byModel[model] ??= { calls: 0, cost: 0, unpricedCalls: 0 });
    entry.calls += per.calls;
    entry.cost += per.cost;
    entry.unpricedCalls += per.unpricedCalls;
  }
  return total;
}

const runEngineTests = async ([engineConfigName, engineTests]) => {
  const tokenLimitConfig = {
    tokensPerInterval: engineTests[0].engineConfig.limits.tokensPerMinute,
    interval: "minute",
  };
  const requestLimitConfig = {
    tokensPerInterval: engineTests[0].engineConfig.limits.requestsPerMinute,
    interval: "minute",
  };

  const requestLimiter = new RateLimiter(requestLimitConfig);
  const tokenLimiter = new RateLimiter(tokenLimitConfig);

  const inProgress = new Set();
  const earlyResults = { true: 0, false: 0 };
  const engineBar = progress.create(engineTests.length, 0, {
    engineConfigName,
    earlyResults: printEarlyResults(earlyResults),
    inProgress: printProgress(inProgress),
  });
  if (experiment.verbose > 0)
    console.log(chalk.blue(`Running tests for: ${engineConfigName}`));

  let testRuns = [];
  if (experiment.sequential) {
    testRuns = await engineTests.reduce(async (promise, test) => {
      const acc = await promise;
      const result = await runSingleTest(
        test,
        requestLimiter,
        tokenLimiter,
        inProgress,
        earlyResults,
        engineBar
      );

      return [...acc, result];
    }, Promise.resolve([]));
  } else {
    testRuns = await Promise.all(
      engineTests.map((test) =>
        runSingleTest(
          test,
          requestLimiter,
          tokenLimiter,
          inProgress,
          earlyResults,
          engineBar
        )
      )
    );
  }

  // The bar counts skipped tests as progress, so a stopped config still ends at 100%.
  // Saying [Done] there is what makes a halted run read as a complete one.
  const stopped = stoppedEngineConfigs.has(engineConfigName);
  engineBar.update({ inProgress: stopped ? "[STOPPED - resume to finish]" : "[Done]" });
  if (experiment.verbose > 0)
    console.log(chalk.blue(
      stopped
        ? `Stopped early for: ${engineConfigName} (remaining tests skipped, resume to finish)`
        : `Finished all tests for: ${engineConfigName}`
    ));

  return testRuns;
};

const runSingleTest = async (
  test,
  requestLimiter,
  tokenLimiter,
  inProgress,
  earlyResults,
  engineBar
) => {
  const name = test.testParams["name"];
  const cachedResult = previousResults.find(r => {
    return (
      r.engineConfigName == test.engineConfigName && 
      r.category == test.category && 
      r.group == test.group &&
      r.testParams.name == test.testParams.name
    )
  })

  let testWithResult;
  if (cachedResult) {
    if (experiment.verbose > 0)
      console.log(chalk.blue(`No need to run "${name}" test, we already have results from previous experiment run.`));

    testWithResult = cachedResult;

  } else {
    const additionalTestParametersTokenCount =
      enc.encode(test.testParams["prompt"]).length +
      Object.entries(test.testParams.additionalParameters)
        .map(([_, v]) => {
          return enc.encode(String(v)).length; 
        })
        .reduce((a, b) => a + b, 0);

    const totalTokens =
      additionalTestParametersTokenCount +
      test.engineConfig.limits.baselineTokenUsage;

    if (experiment.verbose === 2)
      console.log(chalk.blue(`Starting test: ${name}. Awaiting rate limit. Requested additional ${additionalTestParametersTokenCount} tokens beyond the baselineTokenUsage (${test.engineConfig.limits.baselineTokenUsage})`));

    inProgress.add(name);
    engineBar.update({ inProgress: printProgress(inProgress) });

    const additionalParameters = {
      ...test.engineConfig.additionalParameters,
      ...test.testParams.additionalParameters,
    };

    if (experiment.verbose === 2) {
      console.log(additionalParameters)
    }

    // Reuse one engine generation across every test sharing the same engine, prompt, model, and
    // parameters (see generationCache). Only the first such test reserves rate-limit budget and
    // calls the engine; siblings await its result. The get/create/set below runs with no await in
    // between, so two concurrent siblings can never both miss and double-generate.
    const generationKey = JSON.stringify([
      test.engineConfigName,
      test.testParams["prompt"],
      test.testParams["currentModel"],
      additionalParameters,
    ]);

    // Attempt loop. Retries live here rather than in a recursive call with shared state:
    // the previous version threaded one errorTracker through every test of an engine
    // config, so in the default parallel mode a retry for one test spent the retry budget
    // of every other test in flight, and "same error twice" tripped on two unrelated tests.
    let generateResponse = null;
    let reusedGeneration = false;
    const attemptErrors = [];
    // Every attempt's tokens were really bought, so the row is charged for all of them —
    // reporting only the successful attempt would understate what the leaderboard cost.
    const spend = { totalCost: 0, calls: 0, unpricedCalls: 0, byModel: {} };
    // Engine time, summed over attempts on the same rule as spend: a test that generated
    // three times really did occupy the engine three times.
    //
    // This deliberately excludes everything before the engine call — the rate-limiter
    // queue and the backoff hold. Those are properties of how the run was scheduled, not
    // of the engine: with tests queued behind a shared limiter, a test's wait grows with
    // how many others were queued ahead of it, so including it made `duration` scale with
    // the size of the experiment and stop being comparable between runs.
    let generationMs = 0;

    for (let attempt = 0; attempt <= MAX_GENERATION_RETRIES; attempt++) {
      let generationPromise = generationCache.get(generationKey);
      // Whether this test is a sibling reusing a generation another test paid for. It
      // still reports that generation's full cost below, but only the originator's row
      // counts toward an experiment total — otherwise one engine call is billed once
      // per sibling and the total is inflated.
      reusedGeneration = !!generationPromise;
      if (!generationPromise) {
        generationPromise = (async () => {
          await requestLimiter.removeTokens(1);
          await tokenLimiter.removeTokens(totalTokens);

          // Checked after the wait, not before it: every parallel test clears the code
          // above within milliseconds of the run starting, so a check before the wait
          // would already have passed by the time anything failed.
          if (stoppedEngineConfigs.has(test.engineConfigName))
            return { value: { skipped: true }, accounting: null };

          // Another test of this config is backing off; wait it out before adding load.
          // Re-check the stop afterwards — the hold is long enough for that same test to
          // have exhausted its retries while we sat here.
          await engineBackoff.wait(test.engineConfigName);
          if (stoppedEngineConfigs.has(test.engineConfigName))
            return { value: { skipped: true }, accounting: null };

          const engine = await import(
            `../engines/${test["engineConfig"]["engine"]}/engine.js`
          );
          const instance = new engine.default();

          if (experiment.verbose === 2)
            console.log(
              chalk.blue(`Rate limit passed ${name}, awaiting engine response`)
            );

          // Every LLM call made while generating lands in this scope, however deep:
          // a plain engine's own call, and for an agent engine its conversation turns
          // plus every engine it drives through a tool. So `accounting` is the whole
          // price of producing this response, not just the outermost request.
          // The stopwatch starts here: both rate limiters and the backoff hold are above.
          const generationStart = Date.now();
          const generated = await withCostAccounting(() => instance.generate(
            test.testParams["prompt"],
            test.testParams["currentModel"],
            additionalParameters
          ));
          // Siblings awaiting this same promise report the generation they are grading,
          // which is the number they should carry — they did no engine work of their own.
          return { ...generated, generationMs: Date.now() - generationStart };
        })();
        generationCache.set(generationKey, generationPromise);
      }

      let accounting = null;
      let attemptMs = 0;
      try {
        ({ value: generateResponse, accounting, generationMs: attemptMs } = await generationPromise);
      } catch (err) {
        // An engine that throws instead of returning {err} would otherwise reject
        // Promise.all and take down the whole run. Treat it as any other failure.
        generateResponse = { err: err?.message ?? String(err) };
      }
      addSpend(spend, accounting);
      // A skipped or thrown attempt carries no timing; it also did no engine work.
      generationMs += attemptMs ?? 0;

      if (!generateResponse || !generateResponse.err) break;

      // This engine config is stopping already; don't burn retries on top of it.
      if (stoppedEngineConfigs.has(test.engineConfigName)) break;

      // A failed generation must not be cached: drop it so this retry, or a later
      // sibling, regenerates rather than inheriting the failure.
      generationCache.delete(generationKey);
      attemptErrors.push({ attempt: attempt + 1, error: generateResponse.err });

      if (attempt < MAX_GENERATION_RETRIES) {
        // Backing off matters more than retrying: a 429 or an overloaded provider is
        // exactly what a fixed short delay walks straight back into.
        const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
        // Hold every test of this engine config, not just this one — see createEngineBackoff.
        engineBackoff.hold(test.engineConfigName, delay);
        if (experiment.verbose > 0)
          console.log(chalk.yellow(
            `Error on "${name}" (attempt ${attempt + 1}/${MAX_GENERATION_RETRIES + 1}), ` +
            `holding ${test.engineConfigName} for ${delay / 1000}s: ` +
            `${JSON.stringify(generateResponse.err).slice(0, 200)}`
          ));
        await engineBackoff.wait(test.engineConfigName);
      }
    }

    // Never started, because this test's engine config was already stopping when it
    // reached the front of the rate-limiter queue. Not a result and not a failure — the
    // resume will pick it up.
    if (generateResponse && generateResponse.skipped) {
      inProgress.delete(name);
      engineBar.increment(1, { inProgress: printProgress(inProgress) });
      return null;
    }

    if (generateResponse && generateResponse.err) {
      // Every attempt failed. Stop this engine config rather than dropping the test: the
      // completed work is already in the in-progress file, so the right move is to leave it
      // there for a resume instead of publishing a leaderboard with a hole in it. Every
      // other engine config keeps running — this one's provider is the thing that failed.
      //
      // Tests already in flight are deliberately not cancelled — they have been paid for,
      // and letting them finish means the resume has less to redo.
      //
      // A test-level error is the exception — see TEST_LEVEL_ERROR_PREFIXES. It says this
      // one generation failed, not that the provider is unhealthy, so it scores as a
      // failed test and the config carries on to its remaining rows.
      if (!isTestLevelError(generateResponse.err)) {
        stoppedEngineConfigs.add(test.engineConfigName);
        failedTests.push({
          engineConfigName: test.engineConfigName,
          engine: test.engineConfig.engine,
          category: test.category,
          group: test.group,
          name,
          attempts: attemptErrors,
          cost: spend,
        });

        inProgress.delete(name);
        engineBar.increment(1, { inProgress: printProgress(inProgress) });
        return null;
      }

      // Scored as a failure rather than dropped, so the config still reports 93 of 93
      // and the row carries why it failed. There is no `evaluate` call to make here:
      // the engine returned no model, so every expectation is unmet by definition and
      // there is nothing for a category to grade.
      testWithResult = structuredClone(test);
      testWithResult["duration"] = generationMs;
      testWithResult["generatedResponse"] = { err: generateResponse.err };
      testWithResult["cost"] = {
        total: spend.totalCost,
        calls: spend.calls,
        unpricedCalls: spend.unpricedCalls,
        byModel: spend.byModel,
        reusedGeneration,
        ...(attemptErrors.length > 0 ? { failedAttempts: attemptErrors.length } : {}),
      };
      testWithResult["failures"] = [{
        type: "Generation failed",
        details:
          `The engine returned no model after ${attemptErrors.length} attempt(s). ` +
          `Last error: ${generateResponse.err}`,
      }];
      testWithResult["failureSummary"] = { "Generation failed": 1 };
      testWithResult["pass"] = false;
      testWithResult["name"] = name;

      if (experiment.verbose > 0) {
        console.log(chalk.bold(chalk.red(`Failed (no model generated): ${name}`)));
        console.log(generateResponse.err);
        console.log();
      }

      fs.appendFileSync(`${experimentResultsName}${inProgressFileSuffix}`, JSON.stringify(testWithResult) + "\n");

      inProgress.delete(name);
      earlyResults[false] += 1;
      engineBar.increment(1, { inProgress: printProgress(inProgress) });
      engineBar.update({ earlyResults: printEarlyResults(earlyResults) });
      return testWithResult;
    }

    testWithResult = structuredClone(test);
    // Engine time only — see generationMs above. Not schedule-to-done: that included the
    // rate-limiter queue, which is why this used to grow with the number of tests in a run.
    testWithResult["duration"] = generationMs;
    testWithResult["generatedResponse"] = generateResponse || {};
    testWithResult["cost"] = {
      // USD for the generation behind this test, summed over every attempt it took.
      // `unpricedCalls` is what keeps this honest: a call with no price contributes
      // nothing to the total, so a non-zero count means `total` is a lower bound.
      total: spend.totalCost,
      calls: spend.calls,
      unpricedCalls: spend.unpricedCalls,
      byModel: spend.byModel,
      reusedGeneration,
      ...(attemptErrors.length > 0 ? { failedAttempts: attemptErrors.length } : {}),
    };

    if (experiment.verbose === 2)
      console.log(
        chalk.blue(`Cost for ${name}: $${spend.totalCost.toFixed(6)} over ${spend.calls} LLM call(s)`) +
        (spend.unpricedCalls > 0 ? chalk.yellow(` (${spend.unpricedCalls} unpriced — total is a lower bound)`) : "") +
        (attemptErrors.length > 0 ? chalk.yellow(` [${attemptErrors.length} failed attempt(s) included]`) : "") +
        (reusedGeneration ? chalk.gray(" [reused a sibling test's generation]") : "")
      );

    if (experiment.verbose === 2) {
      console.log(
        chalk.blue(
          `Response returned: ${name}, awaiting evaluation of the generated response:`
        )
      );
      console.log(
        JSON.stringify(generateResponse, null, 2)
      );
      console.log();
      // pretty json print the expectations
      console.log(chalk.blue("Against these expectations:"));
      console.log(JSON.stringify(test.testParams["expectations"], null, 2));
    }

    const { evaluate } = await import(`./categories/${test.category}.js`);
    testWithResult["failures"] = await evaluate(
      testWithResult["generatedResponse"],
      test.testParams["expectations"]
    );
    // return count of each failure type
    testWithResult["failureSummary"] = testWithResult["failures"].reduce(
      (acc, failure) => {
        acc[failure.type] = (acc[failure.type] || 0) + 1;
        return acc;
      },
      {}
    );
    testWithResult["pass"] = testWithResult["failures"].length == 0;

    if (experiment.verbose > 0) {
      console.log(
        chalk.blue(
          `Finished evaluation in ${Math.round(
            testWithResult["duration"] / 1000
          )}s: ${name}`
        )
      );
      if (testWithResult["pass"]) {
        console.log(chalk.bold(chalk.green("Passed")));
      } else {
        console.log(chalk.bold(chalk.red("Failed")));
        testWithResult["failures"].forEach((failure) => {
          console.log(failure.details);
          console.log()
        });
      }
      console.log();
    }
    testWithResult["name"] = name;
    fs.appendFileSync(`${experimentResultsName}${inProgressFileSuffix}`, JSON.stringify(testWithResult) + "\n");
  }

  inProgress.delete(name);
  earlyResults[testWithResult["pass"]] += 1;
  engineBar.increment(1, { inProgress: printProgress(inProgress) });
  engineBar.update({ earlyResults: printEarlyResults(earlyResults) });

  return testWithResult;
};

const output = experiment.sequential
  ? await Object.entries(tests).reduce(async (promise, engineEntry) => {
      const acc = await promise;
      const result = await runEngineTests(engineEntry);
      return [...acc, result];
    }, Promise.resolve([]))
  : await Promise.all(Object.entries(tests).map(runEngineTests));

progress.stop();

// Dropped tests come back as null (see runSingleTest): a provider outage must not
// appear as a scored zero, so those rows never enter the results at all.
const responses = output.flat(1).filter(Boolean);
// A test exhausted its retries. Everything that finished is already in the in-progress
// file; nothing is summarised or published, and that file is deliberately left in place
// so re-running the same experiment resumes from it.
if (failedTests.length > 0) {
  const completed = responses.length;
  console.log();
  console.log(chalk.red(chalk.bold(
    `Stopped: ${failedTests.length} test(s) failed all ${MAX_GENERATION_RETRIES + 1} attempts.`
  )));
  console.log();

  const byConfig = {};
  for (const f of failedTests) (byConfig[f.engineConfigName] ??= []).push(f);

  // Scored rows per config, so the "stopped after N of M" line below reports what actually
  // landed rather than the progress bar's count, which includes the tests it skipped.
  const scoredByConfig = {};
  for (const r of responses) scoredByConfig[r.engineConfigName] = (scoredByConfig[r.engineConfigName] ?? 0) + 1;

  for (const [configName, failures] of Object.entries(byConfig)) {
    const scored = scoredByConfig[configName] ?? 0;
    const planned = tests[configName]?.length ?? 0;
    console.log(chalk.red(chalk.bold(
      `  ${configName} (${failures[0].engine}) — stopped after ${scored} of ${planned} tests`
    )));
    for (const f of failures) {
      console.log(chalk.red(`    ${f.category} / ${f.group} / ${f.name}`));
      for (const attempt of f.attempts) {
        console.log(chalk.gray(`      attempt ${attempt.attempt}: ${JSON.stringify(attempt.error).slice(0, 300)}`));
      }
    }
    console.log();
  }

  const errorFile = `${experimentResultsName}_errors.json`;
  fs.writeFileSync(errorFile, JSON.stringify({ failed: failedTests }, null, 2));

  const finished = Object.keys(tests).filter(name => !stoppedEngineConfigs.has(name));
  if (finished.length > 0)
    console.log(chalk.green(`Ran to completion: ${finished.join(", ")}`));
  console.log(chalk.yellow(`${completed} completed test(s) kept in ${experimentResultsName}${inProgressFileSuffix}`));
  console.log(chalk.yellow(`Full error detail written to ${errorFile}`));
  console.log(chalk.yellow(`Resume with: npm run evals -- -e ${argv.experiment}`));
  console.log();
  process.exit(1);
}

const results = new dataForge.DataFrame({ values: responses });


// write the full results to json file
fs.writeFileSync(
  `${experimentResultsName}_full_results.json`,
  JSON.stringify({ results: responses }, null, 2)
);
// force: nothing was appended if every result came from the resume cache, and an ENOENT
// here would throw away a completed run at the last step.
fs.rmSync(`${experimentResultsName}${inProgressFileSuffix}`, { force: true });
// An errors file from the run this one resumed is now answered and would otherwise sit
// next to the results implying failures that no longer exist.
fs.rmSync(`${experimentResultsName}_errors.json`, { force: true });

// Nothing to score. Not the error path (that exits above with progress preserved) — this
// is an experiment whose categories selected no tests at all. The summary tables pivot
// over the results and throw on an empty frame, which would bury the real problem.
if (responses.length === 0) {
  console.error(chalk.red(chalk.bold("No test produced a result — nothing to summarise.")));
  process.exit(1);
}

const engineFailureTypes = [];
results.forEach((result) => {
  if (Object.keys(result["failureSummary"]).length > 1) {
    engineFailureTypes.push({
      engineConfigName: result["engineConfigName"],
      failureType: `${result["category"]} - Multiple kinds of failures`,
      id: engineFailureTypes.length,
    });
  } else if (Object.keys(result["failureSummary"]).length == 1) {
    engineFailureTypes.push({
      engineConfigName: result["engineConfigName"],
      failureType: `${result["category"]} - ${
        Object.keys(result["failureSummary"])[0]
      }`,
      id: engineFailureTypes.length,
    });
  }
});
fs.writeFileSync(
  `${experimentResultsName}_failure_summary.csv`,
  await pivotAndUnstack(
    new dataForge.DataFrame({ values: engineFailureTypes }),
    "engineConfigName",
    "failureType",
    "id",
    (v) => v.count()
  ).toCSV()
);

// Cost per engine config. Only originator rows are summed — a sibling reusing a cached
// generation carries that generation's full cost on its own row for visibility, but
// adding it here would bill one engine call once per sibling.
const costByEngineConfig = {};
results.forEach((result) => {
  const cost = result["cost"];
  if (!cost || cost.reusedGeneration) return;
  const entry = (costByEngineConfig[result["engineConfigName"]] ??= {
    generations: 0, llmCalls: 0, unpricedCalls: 0, total: 0,
  });
  entry.generations += 1;
  entry.llmCalls += cost.calls;
  entry.unpricedCalls += cost.unpricedCalls;
  entry.total += cost.total;
});

const costRows = Object.entries(costByEngineConfig).map(([engineConfigName, e]) => ({
  engineConfigName,
  generations: e.generations,
  llmCalls: e.llmCalls,
  "cost ($)": e.total.toFixed(4),
  "$/generation": (e.total / (e.generations || 1)).toFixed(4),
  // Loud rather than absent: a non-zero count means the cost column understates.
  "unpriced calls": e.unpricedCalls,
}));

if (costRows.length > 0) {
  const grandTotal = Object.values(costByEngineConfig).reduce((a, e) => a + e.total, 0);
  const unpriced = Object.values(costByEngineConfig).reduce((a, e) => a + e.unpricedCalls, 0);
  console.log();
  console.log(chalk.blue("Cost:"));
  const costFrame = new dataForge.DataFrame({ values: costRows });
  printTable(costFrame);
  console.log(chalk.bold(`Total: $${grandTotal.toFixed(4)}`));
  if (unpriced > 0) {
    console.log(chalk.yellow(
      `Warning: ${unpriced} LLM call(s) used a model with no pricing.js entry — the totals above are a lower bound.`
    ));
  }
  console.log();
  fs.writeFileSync(`${experimentResultsName}_cost.csv`, await costFrame.toCSV());
}

const summary = pivotAndUnstack(
  results.withSeries({
    pass: (df) => df.select((row) => (row["pass"] ? 1 : 0)),
  }),
  "engineConfigName",
  "category",
  "pass",
  (values) => values.average()
);
printTable(summary);
fs.writeFileSync(`${experimentResultsName}_summary.csv`, await summary.toCSV());

console.log(chalk.blue(`Wrote result and summaries to various ${chalk.bold(experimentResultsName)} files`));
