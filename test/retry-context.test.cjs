const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);
const {
	filterAssistantErrorMessages,
	isAssistantAbortMessage,
	isAssistantErrorMessage,
} = jiti("../.pi/extensions/pi-goal/retry-context.ts");

test("isAssistantErrorMessage recognizes only assistant error turns", () => {
	assert.equal(isAssistantErrorMessage({ role: "assistant", stopReason: "error", errorMessage: "429" }), true);
	assert.equal(isAssistantErrorMessage({ role: "assistant", stopReason: "length" }), false);
	assert.equal(isAssistantErrorMessage({ role: "toolResult", stopReason: "error" }), false);
	assert.equal(isAssistantErrorMessage(undefined), false);
});

test("abort detection remains separate from retry errors", () => {
	assert.equal(isAssistantAbortMessage({ role: "assistant", stopReason: "aborted" }), true);
	assert.equal(isAssistantAbortMessage({ role: "assistant", stopReason: "error" }), false);
});

test("filterAssistantErrorMessages removes retry diagnostics without mutating input", () => {
	const user = { role: "user", content: "work" };
	const error1 = { role: "assistant", stopReason: "error", errorMessage: "429 quota exhausted" };
	const error2 = { role: "assistant", stopReason: "error", errorMessage: "429 quota exhausted" };
	const success = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall" }] };
	const messages = [user, error1, error2, success];

	assert.deepEqual(filterAssistantErrorMessages(messages), [user, success]);
	assert.equal(messages.length, 4);
});

test("thousands of retry errors add zero messages to the next provider context", () => {
	const user = { role: "user", content: "continue" };
	const errors = Array.from({ length: 2_000 }, () => ({
		role: "assistant",
		stopReason: "error",
		errorMessage: "429 usage limit",
	}));
	assert.deepEqual(filterAssistantErrorMessages([user, ...errors]), [user]);
});
