import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  AGENTS,
  formatReport,
  opensSkillFile,
  parseClaude,
  parseCodex,
  positiveInteger,
  summarize,
  validateQueries,
} from "./run-trigger-evals.mjs";

const SKILL = "feature-sliced-design";
const SKILL_FILE = `/tmp/w/.agents/skills/${SKILL}/SKILL.md`;
const lines = (...events) => events.map((event) => JSON.stringify(event)).join("\n");

const init = (skills = [SKILL]) => ({ type: "system", subtype: "init", skills, model: "m" });
const tool = (name, input) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", name, input }] },
});
const done = { type: "result", subtype: "success", is_error: false };
const limit = { type: "result", subtype: "error_max_turns", is_error: true };

const started = (type, command) => ({ type: "item.started", item: { type, command } });
const said = { type: "item.completed", item: { type: "agent_message", text: "I will check" } };
const finished = { type: "turn.completed" };

test("the shipped query file is valid", () => {
  const url = new URL("../../feature-sliced-design/evals/trigger-evals.json", import.meta.url);
  validateQueries(JSON.parse(readFileSync(url, "utf8")));
});

test("validation rejects a label that contradicts the category", () => {
  const query = { id: "a", language: "en", category: "unrelated", query: "q", should_trigger: true };
  assert.throws(() => validateQueries([query]), /contradicts/);
});

test("the trigger rule covers the skill's files and nothing else", () => {
  assert.equal(opensSkillFile(`cat ${SKILL_FILE}`, SKILL), true);
  assert.equal(opensSkillFile(`sed -n 1,9p .claude/skills/${SKILL}/references/layer-structure.md`, SKILL), true);
  assert.equal(opensSkillFile("ls .agents/skills", SKILL), false);
  assert.equal(opensSkillFile("cat src/SKILL.md", SKILL), false);
  assert.equal(opensSkillFile(undefined, SKILL), false);
});

test("every agent has an adapter that needs only a prompt and a model", () => {
  for (const agent of Object.values(AGENTS)) {
    const [command, args] = agent.command("the prompt", "the model");
    assert.equal(typeof command, "string");
    assert.ok(args.includes("the prompt") && args.includes("the model"));
  }
});

test("claude, a call to this skill triggers, with or without a plugin prefix", () => {
  assert.equal(parseClaude(lines(init(), tool("Skill", { skill: SKILL }), limit), SKILL).triggered, true);
  assert.equal(parseClaude(lines(init(), tool("Skill", { skill: `fsd:${SKILL}` }), limit), SKILL).triggered, true);
});

test("claude, reading the skill file triggers, by Read or by Bash", () => {
  assert.equal(parseClaude(lines(init(), tool("Read", { file_path: SKILL_FILE }), limit), SKILL).triggered, true);
  assert.equal(parseClaude(lines(init(), tool("Bash", { command: `cat ${SKILL_FILE}` }), limit), SKILL).triggered, true);
});

test("claude, another skill or an unrelated command does not trigger but is a valid run", () => {
  const other = parseClaude(lines(init(), tool("Skill", { skill: "debug" }), limit), SKILL);
  assert.deepEqual([other.triggered, other.actions, other.failure], [false, ["Skill debug"], null]);
  const bash = parseClaude(lines(init(), tool("Bash", { command: "ls" }), limit), SKILL);
  assert.deepEqual([bash.triggered, bash.failure], [false, null]);
});

test("claude, a plain answer is a valid run that did not trigger", () => {
  const parsed = parseClaude(lines(init(), done), SKILL);
  assert.deepEqual([parsed.triggered, parsed.failure], [false, null]);
});

test("claude, failed sessions are errors and not misses", () => {
  const failed = { type: "result", subtype: "success", is_error: true, result: "bad model" };
  assert.equal(parseClaude(lines(init(), failed), SKILL).failure, "bad model");
  assert.match(parseClaude(lines(init()), SKILL).failure, /without a result/);
  assert.match(parseClaude(lines(init(["debug"]), done), SKILL).failure, /not listed/);
});

test("codex, a first command that opens the skill triggers", () => {
  const parsed = parseCodex(lines(said, started("command_execution", `/bin/bash -lc 'cat ${SKILL_FILE}'`)), SKILL);
  assert.deepEqual([parsed.triggered, parsed.failure], [true, null]);
});

test("codex, another first action does not trigger but is a valid run", () => {
  const parsed = parseCodex(lines(said, started("command_execution", "/bin/bash -lc 'ls'")), SKILL);
  assert.deepEqual([parsed.triggered, parsed.actions, parsed.failure], [false, ["command_execution"], null]);
  assert.equal(parseCodex(lines(started("web_search")), SKILL).triggered, false);
});

test("codex, a plain answer is a valid run that did not trigger", () => {
  const parsed = parseCodex(lines(said, finished), SKILL);
  assert.deepEqual([parsed.triggered, parsed.failure], [false, null]);
});

test("codex, failed sessions are errors and not misses", () => {
  const warning = { type: "item.completed", item: { type: "error", message: "fallback metadata" } };
  const failed = { type: "turn.failed", error: { message: "bad model" } };
  assert.equal(parseCodex(lines(warning, failed), SKILL).failure, "bad model");
  assert.equal(AGENTS.codex.decided(warning), false);
  assert.match(parseCodex(lines(said), SKILL).failure, /without a result/);
});

test("the codex adapter stops at the first action and not at a message", () => {
  assert.equal(AGENTS.codex.decided(said), false);
  assert.equal(AGENTS.codex.decided(started("command_execution", "ls")), true);
});

test("errored runs do not count as misses, and the report names the error", () => {
  const query = { id: "a", language: "en", category: "explicit", query: "q", should_trigger: true };
  const results = [
    { id: "a", triggered: true, error: null },
    { id: "a", triggered: false, error: "timed out" },
  ];
  const summary = summarize([query], results);
  const row = summary.rows[0];
  assert.deepEqual([row.hits, row.runs, row.errors, row.ok], [1, 1, 1, true]);
  assert.match(formatReport(summary, results), /timed out/);
});

test("run counts must be positive whole numbers", () => {
  assert.equal(positiveInteger("3", "runs"), 3);
  for (const bad of ["abc", "0", "-1", "1.5", ""]) assert.throws(() => positiveInteger(bad, "runs"));
});
