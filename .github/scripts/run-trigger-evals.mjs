#!/usr/bin/env node
// Measures how often an agent invokes a skill for the queries in
// <skill>/evals/trigger-evals.json. It reports rates and does not judge answers.
// Only Claude Code is supported so far. Each agent needs its own detection.

import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CATEGORIES = ["explicit", "context", "unrelated"];
const TIMEOUT_MS = 180_000;

export function validateQueries(queries) {
  if (!Array.isArray(queries) || queries.length === 0) {
    throw new Error("trigger evals must be a non-empty array");
  }
  const ids = new Set();
  for (const query of queries) {
    for (const field of ["id", "language", "category", "query"]) {
      if (typeof query[field] !== "string" || query[field].length === 0) {
        throw new Error(`query ${query.id ?? "?"} is missing "${field}"`);
      }
    }
    if (typeof query.should_trigger !== "boolean") {
      throw new Error(`query ${query.id} needs a boolean should_trigger`);
    }
    if (!CATEGORIES.includes(query.category)) {
      throw new Error(`query ${query.id} has unknown category ${query.category}`);
    }
    if (query.should_trigger !== (query.category !== "unrelated")) {
      throw new Error(`query ${query.id} has should_trigger that contradicts its category`);
    }
    if (ids.has(query.id)) throw new Error(`query id ${query.id} is duplicated`);
    ids.add(query.id);
  }
  return queries;
}

// Reads Claude Code stream-json output. A run only counts when the skill was
// listed and the session finished, so a failed model call is an error and not
// a miss. A one-turn run that calls any skill ends in error_max_turns, which is
// the expected ending. Other failures can report subtype "success" with
// is_error set, so the subtype alone is not enough.
export function detectClaudeTrigger(output, skillName) {
  let listed = false;
  let model = null;
  let result = null;
  const invoked = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "system" && event.subtype === "init") {
      listed = (event.skills ?? []).includes(skillName);
      model = event.model ?? null;
    }
    if (event.type === "assistant") {
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_use" && block.name === "Skill") invoked.push(block.input?.skill ?? "");
      }
    }
    if (event.type === "result") result = event;
  }
  const triggered = invoked.some((skill) => skill === skillName || skill.endsWith(`:${skillName}`));
  let failure = null;
  if (!listed) {
    failure = "skill was not listed in the session";
  } else if (!result) {
    failure = "session ended without a result";
  } else if (result.is_error && result.subtype !== "error_max_turns") {
    failure = String(result.result ?? result.errors ?? result.subtype);
  }
  return { model, triggered, invoked, failure };
}

export function summarize(queries, results) {
  const rows = queries.map((query) => {
    const runs = results.filter((result) => result.id === query.id);
    const valid = runs.filter((run) => !run.error);
    const hits = valid.filter((run) => run.triggered).length;
    const rate = valid.length ? hits / valid.length : null;
    const ok = rate === null ? null : query.should_trigger ? rate >= 0.5 : rate < 0.5;
    return { ...query, runs: valid.length, errors: runs.length - valid.length, hits, rate, ok };
  });
  return { rows };
}

function formatRate(hits, runs) {
  return runs ? `${hits}/${runs}` : "no valid runs";
}

export function formatReport({ rows }) {
  const lines = ["| query | expected | triggered | result |", "| --- | --- | --- | --- |"];
  for (const row of rows) {
    const result = row.ok === null ? "error" : row.ok ? "ok" : "MISMATCH";
    const expected = row.should_trigger ? "yes" : "no";
    lines.push(`| ${row.id} | ${expected} | ${formatRate(row.hits, row.runs)} | ${result} |`);
  }
  lines.push("");
  for (const category of CATEGORIES) {
    const picked = rows.filter((row) => row.category === category);
    const hits = picked.reduce((sum, row) => sum + row.hits, 0);
    const runs = picked.reduce((sum, row) => sum + row.runs, 0);
    lines.push(`${category}: triggered ${formatRate(hits, runs)}`);
  }
  return lines.join("\n");
}

function runClaude(prompt, skillDirectory, skillName, model) {
  const workspace = mkdtempSync(path.join(tmpdir(), "trigger-eval-"));
  const target = path.join(workspace, ".claude", "skills", skillName);
  mkdirSync(target, { recursive: true });
  cpSync(path.join(skillDirectory, "SKILL.md"), path.join(target, "SKILL.md"));
  cpSync(path.join(skillDirectory, "references"), path.join(target, "references"), { recursive: true });

  // One turn with only the Skill tool records the first decision and cannot
  // touch files. User settings stay out so other skills cannot compete.
  const args = [
    "-p", prompt,
    "--model", model,
    "--output-format", "stream-json",
    "--verbose",
    "--setting-sources", "project",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--tools", "Skill",
    "--allowedTools", "Skill",
    "--max-turns", "1",
  ];

  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let failure = null;
    const timer = setTimeout(() => {
      failure = "timed out";
      child.kill();
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.resume();
    child.on("error", (error) => (failure = error.message));
    child.on("close", () => {
      clearTimeout(timer);
      rmSync(workspace, { recursive: true, force: true });
      const { failure: detectedFailure, ...detected } = detectClaudeTrigger(output, skillName);
      resolve({ ...detected, error: failure ?? detectedFailure });
    });
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      skill: { type: "string", default: "feature-sliced-design" },
      model: { type: "string" },
      runs: { type: "string", default: "3" },
      concurrency: { type: "string", default: "3" },
      out: { type: "string" },
    },
  });
  if (!values.model) throw new Error("--model is required, because rates only compare within one model");

  const skillDirectory = path.join(ROOT, values.skill);
  const file = path.join(skillDirectory, "evals", "trigger-evals.json");
  const queries = validateQueries(JSON.parse(readFileSync(file, "utf8")));
  const runs = Number(values.runs);

  const jobs = queries.flatMap((query) => Array.from({ length: runs }, () => query));
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const query = jobs[next++];
      const run = await runClaude(query.query, skillDirectory, values.skill, values.model);
      results.push({ id: query.id, ...run });
      process.stderr.write(`\r${results.length}/${jobs.length} runs`);
    }
  };
  await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));
  process.stderr.write("\n");

  const summary = summarize(queries, results);
  console.log(formatReport(summary));
  if (values.out) {
    const models = [...new Set(results.map((result) => result.model).filter(Boolean))];
    writeFileSync(values.out, `${JSON.stringify({ agent: "claude-code", models, runs, ...summary, results }, null, 2)}\n`);
  }
  if (results.some((result) => result.error)) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
