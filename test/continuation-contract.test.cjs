const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const indexSource = readFileSync(join(__dirname, "../.pi/extensions/pi-goal/index.ts"), "utf8");

test("persisting a non-active goal cancels any queued continuation", () => {
	assert.match(
		indexSource,
		/if \(next\?\.status !== "active"\) \{\s*continuationQueued = false;\s*\}/,
	);
});

test("continuations are dispatched only after Pi has fully settled", () => {
	assert.match(indexSource, /pi\.on\("agent_settled"/);
	assert.doesNotMatch(indexSource, /pi\.on\("agent_end"/);
	assert.match(indexSource, /lastTurnWasError \|\| !ctx\.isIdle\(\) \|\| ctx\.hasPendingMessages\(\)/);
});

test("error turns skip persistence and synthetic continuations", () => {
	assert.match(indexSource, /if \(isAssistantErrorMessage\(message\)\) \{[\s\S]*?lastTurnWasError = true;[\s\S]*?return;\s*\}/);
	assert.match(indexSource, /pi\.on\("context"[\s\S]*?filterAssistantErrorMessages\(event\.messages\)/);
});

test("a user abort pauses instead of silently continuing", () => {
	assert.match(indexSource, /if \(isAssistantAbortMessage\(message\)\) \{[\s\S]*?status: "paused"[\s\S]*?Goal paused after abort/);
});
