import dataForge from "data-forge";
import "data-forge-fs";

//generic prompt and problem statement used for all tests
const prompt =
  "Please find all causal relationships in the background information.";
const problemStatement =
  "I'm trying to do causal discovery, and extract every cause and effect relationship from the information I give you. Please only use variables listed in parenthesis for your answer.";

// Parses a subgraph string into tokens
function parseSubgraph(subgraph) {
  const relationships = [];
  const tokens = subgraph.split(/\s+/).filter((token) => token.length > 0);

  let awaiting = "";

  let toInProgress = [];
  let fromInProgress = [];
  let polarity = "";

  for (let i = 0; i < tokens.length; i++) {
    const current = tokens[i];
    /*
    console.log("processing", current)
    console.log(" to", toInProgress)
    console.log(" from", fromInProgress)
    console.log(" polarity", polarity)
    console.log(" awaiting", awaiting)
    */
    if (current.charAt(current.length - 1) == ">" && current.charAt(0) == "<") {
      if (current == "<H>" || current == "<E>") {
        if (current == "<H>") {
          awaiting = "from";
        }
        if (
          toInProgress.length > 0 &&
          fromInProgress.length > 0 &&
          polarity != ""
        ) {
          //console.log("attemping a push")
          relationships.push({
            to: toInProgress.join(" "),
            from: fromInProgress.join(" "),
            polarity,
          });

          toInProgress = [];
          fromInProgress = [];
          polarity = "";
        }
      } else if (current == "<NEG>") {
        polarity = "-";
      } else if (current == "<POS>") {
        polarity = "+";
      } else if (current == "<T>") {
        awaiting = "to";
      }
    } else if (awaiting == "from") {
      fromInProgress.push(current);
    } else if (awaiting == "to") {
      toInProgress.push(current);
    }
  }

  return relationships;
}

const parseRelationships = function (filePath) {
  const df = dataForge
    .readFileSync(filePath)
    .parseCSV()
    .withSeries({
      expectations: (df) => df.select((row) => parseSubgraph(row.Subgraph)),
    });
  return df.toArray().map((row, index) => {
    const uniqueVariables = [...new Set(row.expectations.flatMap((r) => [r.from, r.to]))];
    const variableList = uniqueVariables.join(", ");
    const backgroundKnowledge = row.Sentence + `(${variableList})`;
    return {
      name: row.Filename || `row #${index + 1}`,
      prompt: prompt,
      additionalParameters: {
        problemStatement: problemStatement,
        backgroundKnowledge: backgroundKnowledge,
        mainTopics: "",
        depth: 1,
      },
      expectations: row.expectations,
    };
  });
};

export const evaluate = function (generatedResponse, groundTruth) {
  const fromAI = generatedResponse.model?.relationships || [];
  const failures = [];

  const stringifyRelationship = function (r) {
    return r.from + " --> (" + r.polarity + ") " + r.to;
  };

  const comparator = function (a, b) {
    if (a.textRepresentation < b.textRepresentation) {
      return -1;
    }
    if (a.textRepresentation > b.textRepresentation) {
      return 1;
    }
    return 0;
  };

  const relationshipEqualityComparatorGenerator = function (a) {
    return (b) => {
      return (
        a.from.toLowerCase() === b.from.toLowerCase() &&
        a.to.toLowerCase() === b.to.toLowerCase()
      );
    };
  };

  const cleanedSortedAI = fromAI
    .map((r) => {
      delete r.reasoning; //these attributes aren't in ground truth
      delete r.polarityReasoning; //these attributes aren't in ground truth
      r.textRepresentation = stringifyRelationship(r);
      return r;
    })
    .sort(comparator);

  const sortedGroundTruth = groundTruth
    .map((r) => {
      r.textRepresentation = stringifyRelationship(r);
      return r;
    })
    .sort(comparator);

  const removed = sortedGroundTruth.filter((element) => {
    return !cleanedSortedAI.some(
      relationshipEqualityComparatorGenerator(element)
    );
  });
  const added = cleanedSortedAI.filter((element) => {
    return !sortedGroundTruth.some(
      relationshipEqualityComparatorGenerator(element)
    );
  });

  const addedStr = added
    .map((r) => {
      return r.textRepresentation;
    })
    .join(", ");
  const removedStr = removed
    .map((r) => {
      return r.textRepresentation;
    })
    .join(", ");
  const groundTruthStr = sortedGroundTruth
    .map((r) => {
      return r.textRepresentation;
    })
    .join(", ");

  if (added.length > 0) {
    failures.push({
      type: "Fake relationships found",
      details:
        "Fake relationships found\n" +
        addedStr +
        "\nGround Truth\n" +
        groundTruthStr,
    });
  }

  if (removed.length > 0) {
    failures.push({
      type: "Real relationships not found",
      details:
        "Real relationships not found\n" +
        removedStr +
        "\nGround Truth\n" +
        groundTruthStr,
    });
  }

  for (const groundTruthRelationship of sortedGroundTruth) {
    let aiRelationship = cleanedSortedAI.find(
      relationshipEqualityComparatorGenerator(groundTruthRelationship)
    );
    if (
      aiRelationship &&
      aiRelationship.polarity !== groundTruthRelationship.polarity
    ) {
      failures.push({
        type: "Incorrect polarity discovered",
        details:
          "Incorrect polarity discovered. Expected " +
          aiRelationship.polarity +
          " to be " +
          groundTruthRelationship.polarity,
      });
    }
  }

  return failures;
};

export const groups = {
  suicide: parseRelationships(
    "./evals/categories/data/suicide_subgraphs.csv"
  ).slice(0, 3),
  lake: parseRelationships(
    "./evals/categories/data/virginia_tech_subgraphs.csv"
  ).slice(0, 3),
  sd: parseRelationships(
    "./evals/categories/data/published_vignettes_subgraphs.csv"
  ).slice(0, 3),
  student: parseRelationships(
    "./evals/categories/data/student_subgraphs.csv"
  ).slice(0, 3),
};
