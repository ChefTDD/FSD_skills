import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { detectClaudeTrigger, summarize, validateQueries } from "./run-trigger-evals.mjs";

const SKILL = "feature-sliced-design";
const init = (skills) => JSON.stringify({ type: "system", subtype: "init", skills, model: "m" });
const skillCall = (skill) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Skill", input: { skill } }] },
  });

test("the shipped query file is valid", () => {
  const url = new URL("../../feature-sliced-design/evals/trigger-evals.json", import.meta.url);
  validateQueries(JSON.parse(readFileSync(url, "utf8")));
});

test("validation rejects a label that contradicts the category", () => {
  const query = { id: "a", language: "en", category: "unrelated", query: "q", should_trigger: true };
  assert.throws(() => validateQueries([query]), /contradicts/);
});

test("detects a call to this skill, with or without a plugin prefix", () => {
  assert.equal(detectClaudeTrigger(`${init([SKILL])}\n${skillCall(SKILL)}`, SKILL).triggered, true);
  assert.equal(detectClaudeTrigger(`${init([SKILL])}\n${skillCall(`fsd:${SKILL}`)}`, SKILL).triggered, true);
});

test("reading the skill file counts as a trigger, and other reads do not", () => {
  const read = (file_path) =>
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: { file_path } }] },
    });
  const skillFile = `/tmp/w/.claude/skills/${SKILL}/SKILL.md`;
  assert.equal(detectClaudeTrigger(`${init([SKILL])}\n${read(skillFile)}`, SKILL).triggered, true);
  assert.equal(detectClaudeTrigger(`${init([SKILL])}\n${read("/tmp/w/src/a.ts")}`, SKILL).triggered, false);
});

test("a call to another skill is not a trigger", () => {
  assert.equal(detectClaudeTrigger(`${init([SKILL])}\n${skillCall("debug")}`, SKILL).triggered, false);
});

test("reports when the skill was not available to the session", () => {
  assert.match(detectClaudeTrigger(init(["debug"]), SKILL).failure, /not listed/);
});

test("a failed model call is an error and not a miss", () => {
  const failed = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "bad model" });
  const detected = detectClaudeTrigger(`${init([SKILL])}\n${failed}`, SKILL);
  assert.equal(detected.failure, "bad model");
});

test("a session with no result is an error", () => {
  assert.match(detectClaudeTrigger(init([SKILL]), SKILL).failure, /without a result/);
});

test("a plain answer is a valid run that did not trigger", () => {
  const done = JSON.stringify({ type: "result", subtype: "success", is_error: false });
  const detected = detectClaudeTrigger(`${init([SKILL])}\n${done}`, SKILL);
  assert.deepEqual([detected.triggered, detected.failure], [false, null]);
});

test("the one-turn limit after a skill call is a valid run", () => {
  const limit = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true });
  const detected = detectClaudeTrigger(`${init([SKILL])}\n${skillCall("debug")}\n${limit}`, SKILL);
  assert.deepEqual([detected.triggered, detected.invoked, detected.failure], [false, ["debug"], null]);
});

test("errored runs do not count as misses", () => {
  const query = { id: "a", language: "en", category: "explicit", query: "q", should_trigger: true };
  const { rows } = summarize([query], [
    { id: "a", triggered: true, error: null },
    { id: "a", triggered: false, error: "timed out" },
  ]);
  assert.deepEqual([rows[0].hits, rows[0].runs, rows[0].errors, rows[0].ok], [1, 1, 1, true]);
});
