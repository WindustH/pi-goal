const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);
const { createGoalState, pauseGoal } = jiti("../.pi/extensions/pi-goal/goal-state.ts");
const { goalControlOptions, goalWidgetLines, renderGoalUi } = jiti("../.pi/extensions/pi-goal/ui.ts");

test("shared string widget renders in both TUI and pi-web RPC mode", () => {
	const goal = createGoalState("finish the robust UI", null, 42, 0.5);
	const calls = [];
	const ctx = { ui: {
		setStatus(key, text) { calls.push({ method: "status", key, text }); },
		setWidget(key, lines, options) { calls.push({ method: "widget", key, lines, options }); },
	} };
	renderGoalUi(ctx, goal, { statusBarEnabled: true, widgetEnabled: true }, { phase: "running", retryErrors: 0 });
	assert.equal(calls[0].key, "pi-goal");
	assert.equal(calls[1].key, "Goal");
	assert.equal(calls[1].options.placement, "aboveEditor");
	assert.match(calls[1].lines.join("\n"), /Objective: finish the robust UI/);
	assert.match(calls[1].lines.join("\n"), /\/goal opens Retry \/ Pause \/ Resume \/ Complete \/ Clear controls/);
});

test("retry widget makes context neutrality visible", () => {
	const goal = createGoalState("wait for quota", null, 42, 0.5);
	assert.match(goalWidgetLines(goal, { phase: "retrying", retryErrors: 17 })[0], /17 provider errors · context unchanged/);
});

test("control model exposes complete lifecycle actions for web buttons", () => {
	const active = createGoalState("ship", null, 42, 0.5);
	assert.deepEqual(goalControlOptions(active).map(({ action }) => action), ["pause", "complete", "clear", "close"]);
	assert.equal(goalControlOptions(active, "waiting")[0].label, "Retry now");
	const paused = pauseGoal(active, "user", 50);
	assert.deepEqual(goalControlOptions(paused).map(({ action }) => action), ["resume", "complete", "clear", "close"]);
});
