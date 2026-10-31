#!/usr/bin/env node
// Measures how often an agent uses a skill for the queries in
// <skill>/evals/trigger-evals.json. It reports rates and does not judge answers.
//
// Queries, scoring and the trigger rule are shared. Each agent has an adapter
// that starts a one-off session and reads its log. A run records the agent's
// first decision, so it stops at the first action the agent takes.

import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CATEGORIES = ["explicit", "context", "unrelated"];
const TIMEOUT_MS = 180_000;
const SKILLS_CLI = "skills@1.5.20";

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

// The shared trigger rule. Opening the skill's files counts, whichever tool did it.
export function opensSkillFile(text, skillName) {
  return new RegExp(`skills/${skillName}/(SKILL\\.md|references/)`).test(text ?? "");
}

function parseEvents(output) {
  const events = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Agents can print plain text between events.
    }
  }
  return events;
}

// A run only counts when the session finished or took an action, so a failed
// model call is an error and not a miss. A one-turn Claude run that calls a tool
// ends in error_max_turns, which is expected. Other failures can report subtype
// "success" with is_error set, so the subtype alone is not enough.
export function parseClaude(output, skillName) {
  let listed = false;
  let model = null;
  let result = null;
  let triggered = false;
  const actions = [];
  for (const event of parseEvents(output)) {
    if (event.type === "system" && event.subtype === "init") {
      listed = (event.skills ?? []).includes(skillName);
      model = event.model ?? null;
    }
    if (event.type === "result") result = event;
    if (event.type !== "assistant") continue;
    for (const block of event.message?.content ?? []) {
      if (block.type !== "tool_use") continue;
      const input = block.input ?? {};
      const label = block.name === "Skill" ? `Skill ${input.skill ?? ""}` : block.name;
      actions.push(label);
      const skill = input.skill ?? "";
      if (block.name === "Skill" && (skill === skillName || skill.endsWith(`:${skillName}`))) triggered = true;
      if (opensSkillFile(input.file_path ?? input.command, skillName)) triggered = true;
    }
  }
  let failure = null;
  if (!listed) {
    failure = "skill was not listed in the session";
  } else if (!result) {
    failure = "session ended without a result";
  } else if (result.is_error && result.subtype !== "error_max_turns") {
    failure = String(result.result ?? result.errors ?? result.subtype);
  }
  return { model, triggered, actions, failure };
}

const CODEX_ACTIONS = new Set(["command_execution", "web_search", "file_change", "mcp_tool_call", "collab_tool_call"]);

function isCodexAction(event) {
  return (event.type === "item.started" || event.type === "item.completed") && CODEX_ACTIONS.has(event.item?.type);
}

// Codex has no skill tool and no skill list in its log. It opens SKILL.md with a
// command, so the first command is what decides the run.
export function parseCodex(output, skillName) {
  let finished = false;
  let failure = null;
  let triggered = false;
  const actions = [];
  for (const event of parseEvents(output)) {
    if (event.type === "turn.completed") finished = true;
    if (event.type === "turn.failed") failure = String(event.error?.message ?? "turn failed");
    if (event.type === "error") failure = String(event.message ?? "error");
    if (!isCodexAction(event)) continue;
    if (event.type === "item.started" || !actions.length) actions.push(event.item.type);
    if (opensSkillFile(event.item.command, skillName)) triggered = true;
  }
  if (!actions.length && !finished && !failure) failure = "session ended without a result";
  return { model: null, triggered, actions, failure: actions.length ? null : failure };
}

export const AGENTS = {
  claude: {
    installName: "claude-code",
    // User settings stay out so the user's own skills and permissions do not
    // change the result. Built-in skills are still listed and can compete.
    command: (prompt, model) => [
      "claude",
      [
        "-p", prompt,
        "--model", model,
        "--output-format", "stream-json",
        "--verbose",
        "--setting-sources", "project",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--max-turns", "1",
      ],
    ],
    parse: parseClaude,
    decided: () => false,
  },
  codex: {
    installName: "codex",
    command: (prompt, model) => [
      "codex",
      [
        "exec",
        "--json",
        "--ignore-user-config",
        "--skip-git-repo-check",
        "--ephemeral",
        "--sandbox", "workspace-write",
        "--model", model,
        prompt,
      ],
    ],
    parse: parseCodex,
    decided: isCodexAction,
  },
};

// Installs the skill the way users get it. The installer also copies evals/,
// which would hand the agent the expected answers, so that folder is removed.
function prepareWorkspace(skillName, agent) {
  const workspace = mkdtempSync(path.join(tmpdir(), "trigger-eval-"));
  execFileSync("git", ["init", "-q", "."], { cwd: workspace });
  execFileSync(
    "npx",
    ["--yes", SKILLS_CLI, "add", ROOT, "--skill", skillName, "--agent", agent.installName, "--copy", "--yes"],
    { cwd: workspace, stdio: "ignore" },
  );
  const installed = [".claude", ".agents"].map((dir) => path.join(workspace, dir, "skills", skillName));
  for (const dir of installed) rmSync(path.join(dir, "evals"), { recursive: true, force: true });
  return workspace;
}

function runOnce(agent, template, prompt, skillName, model) {
  const workspace = mkdtempSync(path.join(tmpdir(), "trigger-eval-"));
  cpSync(template, workspace, { recursive: true });
  const [command, args] = agent.command(prompt, model);

  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let pending = "";
    let failure = null;
    const timer = setTimeout(() => {
      failure = "timed out";
      child.kill();
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const event of parseEvents(lines.join("\n"))) {
        if (agent.decided(event)) child.kill();
      }
    });
    child.stderr.resume();
    child.on("error", (error) => (failure = error.message));
    child.on("close", () => {
      clearTimeout(timer);
      rmSync(workspace, { recursive: true, force: true });
      const { failure: parsedFailure, ...parsed } = agent.parse(output, skillName);
      resolve({ ...parsed, error: failure ?? parsedFailure });
    });
  });
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

export function formatReport({ rows }, results = []) {
  const lines = ["| query | expected | triggered | result |", "| --- | --- | --- | --- |"];
  for (const row of rows) {
    const result = row.ok === null ? "error" : row.ok ? "as expected" : "differs";
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
  const errors = [...new Set(results.map((result) => result.error).filter(Boolean))];
  if (errors.length) lines.push("", "errors:", ...errors.map((error) => `- ${error}`));
  return lines.join("\n");
}

export function positiveInteger(value, name) {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`--${name} must be a positive whole number`);
  return Number(value);
}

async function main() {
  const { values } = parseArgs({
    options: {
      agent: { type: "string" },
      model: { type: "string" },
      skill: { type: "string", default: "feature-sliced-design" },
      runs: { type: "string", default: "3" },
      concurrency: { type: "string", default: "3" },
      only: { type: "string" },
      out: { type: "string" },
    },
  });
  const agent = AGENTS[values.agent];
  if (!agent) throw new Error(`--agent must be one of ${Object.keys(AGENTS).join(", ")}`);
  if (!values.model) throw new Error("--model is required, because rates only compare within one model");
  const runs = positiveInteger(values.runs, "runs");
  const concurrency = positiveInteger(values.concurrency, "concurrency");

  const file = path.join(ROOT, values.skill, "evals", "trigger-evals.json");
  const queries = validateQueries(JSON.parse(readFileSync(file, "utf8"))).filter(
    (query) => !values.only || query.id.includes(values.only),
  );
  const template = prepareWorkspace(values.skill, agent);

  const jobs = queries.flatMap((query) => Array.from({ length: runs }, () => query));
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const query = jobs[next++];
      const run = await runOnce(agent, template, query.query, values.skill, values.model);
      results.push({ id: query.id, ...run });
      process.stderr.write(`\r${results.length}/${jobs.length} runs`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  process.stderr.write("\n");
  rmSync(template, { recursive: true, force: true });

  const summary = summarize(queries, results);
  console.log(formatReport(summary, results));
  if (values.out) {
    const report = { agent: values.agent, model: values.model, runs, ...summary, results };
    writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (results.some((result) => result.error)) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
