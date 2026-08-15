const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);
const piGoal = jiti("../.pi/extensions/pi-goal/index.ts").default;

test("quota retries stay context-neutral and successful recovery resumes the goal", async () => {
	const handlers = new Map();
	const sent = [];
	const appended = [];
	const pi = {
		registerMessageRenderer() {},
		registerEntryRenderer() {},
		registerTool() {},
		registerCommand() {},
		getActiveTools() { return []; },
		setActiveTools() {},
		appendEntry(customType, data) { appended.push({ customType, data }); },
		sendMessage(message, options) { sent.push({ message, options }); },
		on(event, handler) { handlers.set(event, handler); },
	};
	piGoal(pi);

	const activeGoal = {
		version: 1,
		id: "goal-1",
		objective: "finish safely",
		status: "active",
		tokenBudget: null,
		tokensUsed: 10,
		timeUsedSeconds: 2,
		createdAt: 1,
		updatedAt: 1,
	};
	const ctx = {
		sessionManager: {
			getBranch() {
				return [{ type: "custom", customType: "pi-goal", data: { goal: activeGoal, statusBarEnabled: true } }];
			},
		},
		ui: { setStatus() {}, notify() {} },
		isIdle() { return true; },
		hasPendingMessages() { return false; },
	};

	handlers.get("session_start")({ reason: "resume" }, ctx);
	const quotaError = {
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: "429: quota exhausted",
		usage: { totalTokens: 0 },
	};

	for (let attempt = 0; attempt < 2_000; attempt++) {
		handlers.get("turn_start")({}, ctx);
		handlers.get("turn_end")({ message: quotaError }, ctx);
	}
	assert.equal(appended.length, 0, "error retries must not persist duplicate goal state");
	assert.equal(sent.length, 0, "error retries must not synthesize continuation messages");

	const userMessage = { role: "user", content: "continue", timestamp: 1 };
	const filtered = handlers.get("context")({ messages: [userMessage, quotaError, quotaError] }, ctx);
	assert.deepEqual(filtered.messages, [userMessage]);

	const recovered = {
		role: "assistant",
		content: [{ type: "text", text: "Quota recovered." }],
		stopReason: "stop",
		usage: { totalTokens: 20 },
	};
	handlers.get("turn_start")({}, ctx);
	handlers.get("turn_end")({ message: recovered }, ctx);
	assert.equal(appended.length, 1, "the first successful turn is accounted once");
	assert.equal(appended[0].data.goal.tokensUsed, 30);

	handlers.get("agent_settled")({}, ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(sent.length, 1, "the goal continues naturally after recovery settles");
	assert.equal(sent[0].message.customType, "pi-goal-event");
	assert.equal(sent[0].options.triggerTurn, true);
});
