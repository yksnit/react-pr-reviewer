#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import { promisify } from "node:util";

/**
 * Fetch and print a list of open pull requests for a GitHub repository.
 *
 * Usage:
 *   node review.mjs [owner/repo]
 *
 * Environment variables:
 *   GITHUB_REPO - default owner/repo fallback if no CLI arg is provided.
 *
 * Requires: GitHub CLI (`gh`) with an authenticated session.
 */

const execFileAsync = promisify(execFile);

const [, , repoArg] = process.argv;
const repo =
  repoArg?.trim() ||
  process.env.GITHUB_REPO?.trim() ||
  "atom-insurance/atom-webclient-react-apps";

if (!repo.includes("/")) {
  console.error(
    `Expected repository in "owner/name" format but received "${repo}".`
  );
  process.exit(1);
}

const perPage = 200;

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const prs = await fetchOpenPullRequests(repo);

  if (!prs.length) {
    console.log(`No open pull requests found for ${repo}.`);
    return;
  }

  console.log(`Open pull requests for ${repo} (${prs.length}):`);
  for (const pr of prs) {
    const updated = formatDate(pr.updatedAt);
    console.log(
      `#${pr.number} ${pr.title} | ${pr.headRefName ?? "?"} | ${pr.author?.login ?? "unknown"} | updated ${updated}`
    );
  }

  await promptForReview(repo, prs);
}

async function fetchOpenPullRequests(ownerAndRepo) {
  const args = [
    "pr",
    "list",
    "--repo",
    ownerAndRepo,
    "--state",
    "open",
    "--limit",
    String(perPage),
    "--json",
    "number,title,headRefName,author,updatedAt",
  ];

  try {
    const { stdout } = await execFileAsync("gh", args, { env: process.env });
    return JSON.parse(stdout);
  } catch (error) {
    if (error && typeof error === "object" && "stderr" in error) {
      const stderr = String(error.stderr || "").trim();
      if (stderr) {
        throw new Error(stderr);
      }
    }

    throw new Error(
      "Failed to run `gh pr list`. Ensure GitHub CLI is installed and authenticated."
    );
  }
}

const ollamaModel =
  process.env.OLLAMA_MODEL?.trim() || "deepseek-coder-v2:lite";

async function promptForReview(ownerAndRepo, prs) {
  const rl = readline.createInterface({ input, output });

  try {
    const answer = await promptYesNo(rl, "Review a PR? (y/N) ");
    if (!answer) {
      return;
    }

    const validNumbers = new Set(prs.map((pr) => pr.number));

    let selected = null;
    while (selected === null) {
      const inputNumber = (await rl.question("Enter PR number (or q to quit): ")).trim();

      if (!inputNumber || /^q$/i.test(inputNumber)) {
        return;
      }

      const parsed = Number.parseInt(inputNumber, 10);
      if (Number.isNaN(parsed) || !validNumbers.has(parsed)) {
        console.log("Invalid PR number. Try again.");
        continue;
      }

      selected = parsed;
    }

    console.log(`\nFetching diff for PR #${selected}...\n`);
    const diff = await showPullRequestDiff(ownerAndRepo, selected);
    const reviewResult = await runOllamaReview(ownerAndRepo, selected, diff);
    if (!reviewResult) {
      return;
    }

    displayReviewSummary(reviewResult.review);

    const shouldSubmit = await promptYesNo(
      rl,
      "Submit these AI-generated comments to GitHub? (y/N) "
    );
    if (!shouldSubmit) {
      console.log("Skipping GitHub submission.");
      return;
    }

    await submitReview(ownerAndRepo, selected, diff, reviewResult.review);
  } finally {
    rl.close();
  }
}

async function showPullRequestDiff(ownerAndRepo, prNumber) {
  const args = ["pr", "diff", "--repo", ownerAndRepo, String(prNumber)];

  try {
    const { stdout } = await execFileAsync("gh", args, {
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });

    const trimmed = stdout.trim();
    if (!trimmed) {
      console.log("No diff available for this pull request.");
      return "";
    }

    console.log(trimmed);
    return trimmed;
  } catch (error) {
    if (error && typeof error === "object" && "stderr" in error) {
      const stderr = String(error.stderr || "").trim();
      if (stderr) {
        throw new Error(stderr);
      }
    }

    throw new Error(
      "Failed to run `gh pr diff`. Ensure the pull request is accessible."
    );
  }
}

async function runOllamaReview(ownerAndRepo, prNumber, diffText) {
  if (!diffText) {
    console.log("Skipping Ollama review because no diff was returned.");
    return null;
  }

  console.log(`\nRunning Ollama review with model "${ollamaModel}"...\n`);

  const prompt = [
    "You are a senior front-end engineer performing an inline code review.",
    `Review GitHub pull request #${prNumber} for repository ${ownerAndRepo}.`,
    "Focus on correctness, UX impact, maintainability, and missing tests.",
    "Only comment on lines that appear in the provided diff.",
    "Respond with JSON matching this exact schema and nothing else:",
    '{',
    '  "summary": "one or two sentences summarizing the overall feedback",',
    '  "comments": [',
    '    {',
    '      "path": "relative/path/to/file.js",',
    '      "line": 123,',
    '      "severity": "Major" | "Minor" | "Nitpick",',
    '      "body": "Concise inline review comment addressed to the author."',
    "    }",
    "  ]",
    "}",
    "Output valid JSON only. Use newline characters in bodies when needed.",
    "",
    "Diff to review (unified format):",
    diffText,
  ].join("\n");

  let output;
  try {
    output = await spawnWithInput(
      "ollama",
      ["run", ollamaModel],
      prompt
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to execute Ollama CLI (unknown error).";
    console.error(`Ollama review failed: ${message}`);
    return null;
  }

  if (!output.trim()) {
    console.log("Ollama produced no review output.");
    return null;
  }

  const parsed = parseModelResponse(output);
  if (!parsed) {
    console.log("Unable to parse Ollama output. Raw response:");
    console.log(output.trim());
    return null;
  }

  return {
    raw: output,
    review: parsed,
  };
}

function spawnWithInput(cmd, args, inputText) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: process.env });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        const message = stderr.trim() || `Command "${cmd}" exited with code ${code}`;
        reject(new Error(message));
        return;
      }

      resolve(stdout);
    });

    child.stdin.end(inputText);
  });
}

function parseModelResponse(rawOutput) {
  const trimmed = rawOutput.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
    return null;
  }

  const jsonSlice = trimmed.slice(jsonStart, jsonEnd + 1);

  try {
    const parsed = JSON.parse(jsonSlice);

    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.summary !== "string" ||
      !Array.isArray(parsed.comments)
    ) {
      return null;
    }

    parsed.comments = parsed.comments
      .filter(
        (comment) =>
          comment &&
          typeof comment.path === "string" &&
          Number.isFinite(comment.line) &&
          Number.parseInt(comment.line, 10) > 0 &&
          typeof comment.body === "string"
      )
      .map((comment) => ({
        path: comment.path.trim(),
        line: Number.parseInt(comment.line, 10),
        severity:
          typeof comment.severity === "string"
            ? comment.severity.trim()
            : "Minor",
        body: comment.body.trim(),
      }));

    return parsed;
  } catch {
    return null;
  }
}

function displayReviewSummary(review) {
  console.log("\nOllama review suggestions:\n");
  console.log(`Summary: ${review.summary || "No summary provided."}`);

  if (!review.comments.length) {
    console.log("No inline comments produced.");
  } else {
    for (const comment of review.comments) {
      const severity = comment.severity ?? "Minor";
      console.log(
        `[${severity}] ${comment.path}:${comment.line} -> ${comment.body}`
      );
    }
  }

  console.log("\n--- End Ollama review ---\n");
}

async function submitReview(ownerAndRepo, prNumber, diffText, review) {
  if (!review.comments.length) {
    console.log("No comments to submit.");
    return;
  }

  const diffIndex = buildDiffIndex(diffText);
  const validComments = [];
  const skipped = [];

  for (const comment of review.comments) {
    const availableLines = diffIndex.get(comment.path);
    if (!availableLines || !availableLines.has(comment.line)) {
      skipped.push(comment);
      continue;
    }

    validComments.push({
      path: comment.path,
      line: comment.line,
      side: "RIGHT",
      body: formatCommentBody(comment),
    });
  }

  if (!validComments.length) {
    console.log(
      "No comments matched diff lines, so nothing was submitted to GitHub."
    );
    if (skipped.length) {
      console.log("Skipped comments:");
      for (const comment of skipped) {
        console.log(`- ${comment.path}:${comment.line} (${comment.body})`);
      }
    }
    return;
  }

  const [owner, repo] = ownerAndRepo.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repository identifier: ${ownerAndRepo}`);
  }

  const payload = {
    event: "COMMENT",
    body: review.summary || "Automated review comments.",
    comments: validComments,
  };

  try {
    await spawnWithInput(
      "gh",
      [
        "api",
        "--method",
        "POST",
        `repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
        "--input",
        "-",
      ],
      JSON.stringify(payload, null, 2)
    );
    console.log(
      `Submitted ${validComments.length} inline comment(s) to GitHub for PR #${prNumber}.`
    );
    if (skipped.length) {
      console.log("Skipped comments (outside diff):");
      for (const comment of skipped) {
        console.log(`- ${comment.path}:${comment.line} (${comment.body})`);
      }
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown GitHub submission error";
    console.error(`Failed to submit GitHub review: ${message}`);
  }
}

function buildDiffIndex(diffText) {
  const files = new Map();

  const lines = diffText.split("\n");
  let currentPath = null;
  let headLine = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      currentPath = null;
      headLine = 0;
      continue;
    }

    if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim();
      if (path === "/dev/null") {
        currentPath = null;
        continue;
      }

      currentPath = path.startsWith("b/") ? path.slice(2) : path;
      if (!files.has(currentPath)) {
        files.set(currentPath, new Set());
      }
      continue;
    }

    if (!currentPath) {
      continue;
    }

    if (line.startsWith("@@")) {
      const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (match) {
        headLine = Number.parseInt(match[1], 10);
      }
      continue;
    }

    if (line.startsWith("\\ No newline at end of file")) {
      continue;
    }

    const fileLines = files.get(currentPath);
    if (!fileLines) {
      continue;
    }

    if (line.startsWith("+")) {
      fileLines.add(headLine);
      headLine += 1;
    } else if (line.startsWith(" ")) {
      fileLines.add(headLine);
      headLine += 1;
    } else if (line.startsWith("-")) {
      // removed line: do not advance head line
    }
  }

  return files;
}

async function promptYesNo(rl, message) {
  const answer = (await rl.question(message)).trim();
  return /^y(es)?$/i.test(answer);
}

function formatCommentBody(comment) {
  const severity = comment.severity ? comment.severity.trim() : "Minor";
  const prefix = `[Severity: ${severity}]`;
  if (!comment.body.startsWith(prefix)) {
    return `${prefix}\n\n${comment.body}`;
  }
  return comment.body;
}

function formatDate(isoString) {
  if (!isoString) return "unknown";

  const formatter = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  try {
    return formatter.format(new Date(isoString));
  } catch {
    return isoString;
  }
}
