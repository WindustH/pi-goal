const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const runtime = readFileSync(join(__dirname, "../.pi/extensions/pi-goal/runtime.ts"), "utf8");
const index = readFileSync(join(__dirname, "../.pi/extensions/pi-goal/index.ts"), "utf8");

test("entrypoint owns no mutable cross-session goal state", () => {
	assert.match(index, /new GoalRuntime\(pi\)\.register\(\)/);
	assert.doesNotMatch(index, /let goal|let activeTurn|let continuation/);
});

test("runtime uses all user-interrupt signals to pause", () => {
	assert.match(runtime, /signal\.addEventListener\("abort"/);
	assert.match(runtime, /isAssistantAbortMessage/);
	assert.match(runtime, /streamingBehavior === "steer"/);
	assert.match(runtime, /"interrupt"/);
});

test("budget and empty-turn stops never synthesize a wrap-up request", () => {
	assert.match(runtime, /isEmptySuccessfulAssistantTurn/);
	assert.match(runtime, /No extra wrap-up turn was started/);
	assert.doesNotMatch(runtime, /budgetLimitPrompt|"budget_limited".*triggerTurn/s);
});

test("continuation dispatch stays on agent_settled, never agent_end", () => {
	assert.match(runtime, /this\.pi\.on\("agent_settled"/);
	assert.doesNotMatch(runtime, /this\.pi\.on\("agent_end"/);
});
