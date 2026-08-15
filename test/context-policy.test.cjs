const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);
const { filterProviderContext } = jiti("../.pi/extensions/pi-goal/context-policy.ts");
const { TRIGGER_TEXT } = jiti("../.pi/extensions/pi-goal/constants.ts");

function trigger(id, content) {
	return { role: "custom", customType: "pi-goal-event", content, details: { goal: { id } } };
}

test("active context keeps only one compact current-goal trigger", () => {
	const user = { role: "user", content: "work" };
	const success = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] };
	const messages = [
		user,
		trigger("old-goal", "very long old prompt"),
		trigger("goal-1", "very long prompt 1"),
		success,
		trigger("goal-1", "very long prompt 2"),
	];
	const filtered = filterProviderContext(messages, "goal-1");
	assert.equal(filtered.length, 3);
	assert.equal(filtered[0], user);
	assert.equal(filtered[1], success);
	assert.equal(filtered[2].content, TRIGGER_TEXT);
	assert.notEqual(filtered[2], messages[4]);
});

test("paused context removes every goal trigger and provider error", () => {
	const user = { role: "user", content: "unrelated question" };
	const errors = Array.from({ length: 2_000 }, () => ({ role: "assistant", stopReason: "error", errorMessage: "429" }));
	const triggers = Array.from({ length: 2_000 }, () => trigger("goal-1", "large repeated prompt"));
	assert.deepEqual(filterProviderContext([user, ...errors, ...triggers], null), [user]);
});

test("filtering does not mutate the session message array", () => {
	const original = trigger("goal-1", "legacy full prompt");
	const messages = [original];
	filterProviderContext(messages, "goal-1");
	assert.equal(messages[0], original);
	assert.equal(original.content, "legacy full prompt");
});
