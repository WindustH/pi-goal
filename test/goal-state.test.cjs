const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);
const {
	accountGoalTurn,
	accountGoalUsage,
	completeGoal,
	createGoalState,
	formatElapsed,
	formatTokens,
	goalUsage,
	normalizeTokenBudget,
	parseTokenBudget,
	pauseGoal,
	restoreGoalState,
	resumeGoal,
	statusLine,
	truncateObjective,
} = jiti("../.pi/extensions/pi-goal/goal-state.ts");

test("token budgets parse and validate without corrupting the objective", () => {
	assert.deepEqual(parseTokenBudget("  finish the migration  "), { objective: "finish the migration", tokenBudget: null });
	assert.deepEqual(parseTokenBudget("--tokens=50k finish migration"), { objective: "finish migration", tokenBudget: 50_000 });
	assert.deepEqual(parseTokenBudget("finish --tokens 1.5m migration"), { objective: "finish migration", tokenBudget: 1_500_000 });
	assert.equal(parseTokenBudget("ship --tokens nope").error, "Token budget must be positive.");
	assert.deepEqual(normalizeTokenBudget(undefined), { tokenBudget: null });
	assert.deepEqual(normalizeTokenBudget("1500.6"), { tokenBudget: 1501 });
	assert.match(normalizeTokenBudget(0).error, /positive/);
});

test("formatters keep UI state compact and useful", () => {
	assert.equal(formatTokens(12_340), "12.3K");
	assert.equal(formatTokens(1_250_000), "1.3M");
	assert.equal(formatElapsed(5_460), "1h 31m");
	const goal = { ...createGoalState("ship it", null, 42, 0.5), tokensUsed: 250, timeUsedSeconds: 99 };
	assert.equal(goalUsage(goal), "250 tokens · 1m");
	assert.equal(statusLine(goal), "Pursuing goal (1m)");
	assert.equal(truncateObjective("  one\n two\tthree  "), "one two three");
});

test("new goals use schema v2 and track completed turns", () => {
	const goal = createGoalState("ship it", 100, 42, 0.5);
	assert.deepEqual(goal, {
		version: 2,
		id: "42-8",
		objective: "ship it",
		status: "active",
		pauseReason: null,
		tokenBudget: 100,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		turnsCompleted: 0,
		createdAt: 42,
		updatedAt: 42,
	});
	const next = accountGoalTurn(goal, 70, 5, 50);
	assert.equal(next.tokensUsed, 70);
	assert.equal(next.timeUsedSeconds, 5);
	assert.equal(next.turnsCompleted, 1);
	assert.equal(next.status, "active");
	assert.equal(accountGoalTurn(next, 30, 1, 51).status, "budget_limited");
});

test("error usage can be folded without counting error attempts as turns", () => {
	const goal = createGoalState("ship it", null, 42, 0.5);
	const next = accountGoalUsage(goal, 25, 7, { now: 55 });
	assert.equal(next.tokensUsed, 25);
	assert.equal(next.timeUsedSeconds, 7);
	assert.equal(next.turnsCompleted, 0);
});

test("pause, resume, budget reset, and completion are explicit transitions", () => {
	const goal = createGoalState("ship it", 100, 42, 0.5);
	const paused = pauseGoal(goal, "interrupt", 50);
	assert.equal(paused.status, "paused");
	assert.equal(paused.pauseReason, "interrupt");
	assert.equal(resumeGoal(paused, 60).status, "active");
	const limited = { ...goal, status: "budget_limited", tokensUsed: 100 };
	assert.equal(resumeGoal(limited, 70).tokenBudget, null);
	const pausedAfterLimit = { ...limited, status: "paused", pauseReason: "user" };
	assert.equal(resumeGoal(pausedAfterLimit, 75).tokenBudget, null);
	assert.equal(completeGoal(goal, 80).status, "complete");
});

test("v1 session state migrates and malformed state is rejected", () => {
	const legacy = {
		version: 1,
		id: "legacy",
		objective: " keep working ",
		status: "paused",
		tokenBudget: null,
		tokensUsed: 10,
		timeUsedSeconds: 2,
		createdAt: 1,
		updatedAt: 2,
	};
	assert.deepEqual(restoreGoalState(legacy), {
		...legacy,
		version: 2,
		objective: "keep working",
		pauseReason: "user",
		turnsCompleted: 0,
	});
	assert.equal(restoreGoalState({ ...legacy, objective: "" }), null);
	assert.equal(restoreGoalState({ ...legacy, status: "broken" }), null);
});
