const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);
const piGoal = jiti("../.pi/extensions/pi-goal/index.ts").default;
const { createGoalState } = jiti("../.pi/extensions/pi-goal/goal-state.ts");

function activeEntry(objective = "finish safely", tokenBudget = null) {
	return {
		type: "custom",
		customType: "pi-goal",
		data: {
			schemaVersion: 2,
			goal: createGoalState(objective, tokenBudget, 1, 0.5),
			preferences: { statusBarEnabled: true, widgetEnabled: true },
		},
	};
}

function createHarness(entries = [activeEntry()]) {
	const handlers = new Map();
	const sent = [];
	const appended = [];
	const tools = new Map();
	const commands = new Map();
	const statuses = new Map();
	const widgets = new Map();
	const notices = [];
	let selected;
	let confirmResult = true;
	let sendError = false;
	let activeTools = [];
	const pi = {
		registerMessageRenderer() {},
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand(name, command) { commands.set(name, command); },
		getActiveTools() { return activeTools; },
		setActiveTools(value) { activeTools = value; },
		appendEntry(customType, data) { appended.push({ customType, data }); },
		sendMessage(message, options) {
			if (sendError) throw new Error("send failed");
			sent.push({ message, options });
		},
		on(event, handler) { handlers.set(event, handler); },
	};
	piGoal(pi);
	const ctx = {
		mode: "rpc",
		hasUI: true,
		cwd: "/tmp",
		signal: undefined,
		sessionManager: { getBranch() { return entries; } },
		ui: {
			setStatus(key, text) { statuses.set(key, text); },
			setWidget(key, lines) { widgets.set(key, lines); },
			notify(message, type) { notices.push({ message, type }); },
			async select(_title, options) { return selected ?? options.at(-1); },
			async confirm() { return confirmResult; },
		},
		isIdle() { return true; },
		hasPendingMessages() { return false; },
	};
	return {
		handlers, sent, appended, tools, commands, statuses, widgets, notices, ctx,
		setSelected(value) { selected = value; },
		setConfirm(value) { confirmResult = value; },
		setSendError(value) { sendError = value; },
	};
}

async function flushMicrotasks() {
	await new Promise((resolve) => setImmediate(resolve));
}

test("2,000 quota errors append no goal state or continuation and recovery resumes once", async () => {
	const h = createHarness();
	h.handlers.get("session_start")({ reason: "resume" }, h.ctx);
	const quotaError = { role: "assistant", content: [], stopReason: "error", errorMessage: "429", usage: { totalTokens: 0 } };
	for (let attempt = 0; attempt < 2_000; attempt++) {
		h.handlers.get("turn_start")({}, h.ctx);
		h.handlers.get("turn_end")({ message: quotaError, toolResults: [] }, h.ctx);
	}
	assert.equal(h.appended.length, 0);
	assert.equal(h.sent.length, 0);
	assert.match(h.widgets.get("Goal")[0], /2K provider errors · context unchanged/);

	const recovered = { role: "assistant", content: [{ type: "text", text: "Recovered." }], stopReason: "stop", usage: { totalTokens: 20 } };
	h.handlers.get("turn_start")({}, h.ctx);
	h.handlers.get("turn_end")({ message: recovered, toolResults: [] }, h.ctx);
	assert.equal(h.appended.length, 1);
	assert.equal(h.appended[0].data.goal.tokensUsed, 20);
	assert.equal(h.appended[0].data.goal.turnsCompleted, 1);
	h.handlers.get("agent_settled")({}, h.ctx);
	await flushMicrotasks();
	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0].message.content, "Continue the active goal from the current state.");
	assert.equal(h.sent[0].message.display, false);
});

test("provider-level 429 retries update only the UI, not session history", () => {
	const h = createHarness();
	h.handlers.get("session_start")({ reason: "resume" }, h.ctx);
	h.handlers.get("turn_start")({}, h.ctx);
	for (let attempt = 0; attempt < 50; attempt++) {
		h.handlers.get("after_provider_response")({ status: 429 }, h.ctx);
	}
	assert.equal(h.appended.length, 0);
	assert.equal(h.sent.length, 0);
	assert.match(h.widgets.get("Goal")[0], /50 provider errors · context unchanged/);
});

test("a settled retry window folds failed usage once and honors a token budget", () => {
	const h = createHarness([activeEntry("bounded retries", 10)]);
	h.handlers.get("session_start")({ reason: "resume" }, h.ctx);
	h.handlers.get("turn_start")({}, h.ctx);
	h.handlers.get("turn_end")({
		message: { role: "assistant", stopReason: "error", content: [], usage: { totalTokens: 10 } },
		toolResults: [],
	}, h.ctx);
	assert.equal(h.appended.length, 0);
	h.handlers.get("agent_settled")({}, h.ctx);
	assert.equal(h.appended.length, 1);
	assert.equal(h.appended[0].data.goal.status, "budget_limited");
	assert.equal(h.appended[0].data.goal.tokensUsed, 10);
	assert.equal(h.sent.length, 0);
});

test("provider context removes errors and collapses legacy goal prompts", () => {
	const h = createHarness();
	h.handlers.get("session_start")({ reason: "resume" }, h.ctx);
	const goalId = createGoalState("x", null, 1, 0.5).id;
	const branchGoalId = "1-8";
	const user = { role: "user", content: "continue" };
	const error = { role: "assistant", stopReason: "error", errorMessage: "429" };
	const old = { role: "custom", customType: "pi-goal-event", content: "huge prompt", details: { goal: { id: branchGoalId } } };
	const latest = { ...old, content: "another huge prompt" };
	const result = h.handlers.get("context")({ messages: [user, error, old, latest] }, h.ctx);
	assert.equal(result.messages.length, 2);
	assert.equal(result.messages[0], user);
	assert.equal(result.messages[1].content, "Continue the active goal from the current state.");
	assert.equal(goalId, branchGoalId);
});

test("active goal instructions append to rather than replace Pi's system prompt", () => {
	const h = createHarness();
	h.handlers.get("session_start")({ reason: "resume" }, h.ctx);
	const result = h.handlers.get("before_agent_start")({ systemPrompt: "PI CORE PROMPT" }, h.ctx);
	assert.match(result.systemPrompt, /^PI CORE PROMPT/);
	assert.match(result.systemPrompt, /<untrusted_objective>\nfinish safely/);
});

test("AbortSignal pauses immediately and prevents continuation", async () => {
	const h = createHarness();
	h.handlers.get("session_start")({ reason: "resume" }, h.ctx);
	const controller = new AbortController();
	h.ctx.signal = controller.signal;
	h.handlers.get("turn_start")({}, h.ctx);
	controller.abort();
	assert.equal(h.appended.at(-1).data.goal.status, "paused");
	assert.equal(h.appended.at(-1).data.goal.pauseReason, "interrupt");
	h.handlers.get("turn_end")({ message: { role: "assistant", stopReason: "aborted", content: [], usage: { totalTokens: 3 } }, toolResults: [] }, h.ctx);
	h.handlers.get("agent_settled")({}, h.ctx);
	await flushMicrotasks();
	assert.equal(h.sent.length, 0);
});

test("streaming user steer pauses before the redirected prompt", () => {
	const h = createHarness();
	h.handlers.get("session_start")({ reason: "resume" }, h.ctx);
	const result = h.handlers.get("input")({ source: "rpc", text: "stop that", streamingBehavior: "steer" }, h.ctx);
	assert.deepEqual(result, { action: "continue" });
	assert.equal(h.appended.at(-1).data.goal.status, "paused");
	assert.equal(h.appended.at(-1).data.goal.pauseReason, "interrupt");
});

test("empty successful turn pauses and budget exhaustion spends no wrap-up turn", async () => {
	const empty = createHarness();
	empty.handlers.get("session_start")({ reason: "resume" }, empty.ctx);
	empty.handlers.get("turn_start")({}, empty.ctx);
	empty.handlers.get("turn_end")({ message: { role: "assistant", stopReason: "stop", content: [], usage: { totalTokens: 5 } }, toolResults: [] }, empty.ctx);
	empty.handlers.get("agent_settled")({}, empty.ctx);
	await flushMicrotasks();
	assert.equal(empty.appended.at(-1).data.goal.pauseReason, "empty_response");
	assert.equal(empty.sent.length, 0);

	const budget = createHarness([activeEntry("bounded", 10)]);
	budget.handlers.get("session_start")({ reason: "resume" }, budget.ctx);
	budget.handlers.get("turn_start")({}, budget.ctx);
	budget.handlers.get("turn_end")({ message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "work" }], usage: { totalTokens: 10 } }, toolResults: [] }, budget.ctx);
	budget.handlers.get("agent_settled")({}, budget.ctx);
	await flushMicrotasks();
	assert.equal(budget.appended.at(-1).data.goal.status, "budget_limited");
	assert.equal(budget.sent.length, 0);
});

test("/goal opens button-backed controls in pi-web and pauses without an LLM turn", async () => {
	const h = createHarness();
	h.handlers.get("session_start")({ reason: "resume" }, h.ctx);
	h.setSelected("Pause goal");
	await h.commands.get("goal").handler("", h.ctx);
	assert.equal(h.appended.at(-1).data.goal.status, "paused");
	assert.equal(h.sent.length, 0);
});

test("pi-web buttons can complete and retry a waiting goal without lifecycle prompts", async () => {
	const complete = createHarness();
	complete.handlers.get("session_start")({ reason: "resume" }, complete.ctx);
	complete.setSelected("Mark complete");
	await complete.commands.get("goal").handler("", complete.ctx);
	assert.equal(complete.appended.at(-1).data.goal.status, "complete");
	assert.equal(complete.sent.length, 0);

	const retry = createHarness();
	retry.handlers.get("session_start")({ reason: "resume" }, retry.ctx);
	retry.handlers.get("turn_start")({}, retry.ctx);
	retry.handlers.get("turn_end")({ message: { role: "assistant", stopReason: "error", content: [] }, toolResults: [] }, retry.ctx);
	retry.handlers.get("agent_settled")({}, retry.ctx);
	retry.setSelected("Retry now");
	await retry.commands.get("goal").handler("", retry.ctx);
	await flushMicrotasks();
	assert.equal(retry.sent.length, 1);
	assert.equal(retry.sent[0].message.content, "Continue the active goal from the current state.");
});

test("replacing a goal atomically invalidates its already queued continuation", async () => {
	const h = createHarness();
	h.handlers.get("session_start")({ reason: "resume" }, h.ctx);
	h.handlers.get("agent_settled")({}, h.ctx);
	await h.tools.get("create_goal").execute("call-1", { objective: "replacement objective" }, undefined, undefined, h.ctx);
	h.handlers.get("agent_settled")({}, h.ctx);
	await flushMicrotasks();
	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0].message.details.goal.objective, "replacement objective");
});

test("a continuation dispatch failure becomes a token-free waiting state", async () => {
	const h = createHarness();
	h.handlers.get("session_start")({ reason: "resume" }, h.ctx);
	h.setSendError(true);
	h.handlers.get("agent_settled")({}, h.ctx);
	await flushMicrotasks();
	assert.equal(h.sent.length, 0);
	assert.match(h.widgets.get("Goal")[0], /WAITING/);
	assert.match(h.notices.at(-1).message, /No model turn was started/);
});

test("multiple runtime instances do not leak goal state across pi-web sessions", async () => {
	const first = createHarness([activeEntry("first")]);
	const second = createHarness([activeEntry("second")]);
	first.handlers.get("session_start")({ reason: "resume" }, first.ctx);
	second.handlers.get("session_start")({ reason: "resume" }, second.ctx);
	const firstResult = await first.tools.get("get_goal").execute();
	const secondResult = await second.tools.get("get_goal").execute();
	assert.match(firstResult.content[0].text, /first/);
	assert.doesNotMatch(firstResult.content[0].text, /second/);
	assert.match(secondResult.content[0].text, /second/);
});
