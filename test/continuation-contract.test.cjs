const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);
const { ContinuationScheduler } = jiti("../.pi/extensions/pi-goal/continuation-scheduler.ts");

test("scheduler coalesces duplicate continuation requests", async () => {
	const scheduler = new ContinuationScheduler();
	let dispatches = 0;
	assert.equal(scheduler.request("goal-1", () => dispatches++), true);
	assert.equal(scheduler.request("goal-1", () => dispatches++), false);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(dispatches, 1);
	assert.equal(scheduler.pending, true);
});

test("cancel invalidates queued microtasks, including pause-resume races", async () => {
	const scheduler = new ContinuationScheduler();
	const sent = [];
	scheduler.request("goal-1", () => sent.push("stale"));
	scheduler.cancel();
	scheduler.request("goal-1", () => sent.push("fresh"));
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(sent, ["fresh"]);
});

test("turn start releases the dispatched guard for the next settled boundary", async () => {
	const scheduler = new ContinuationScheduler();
	let dispatches = 0;
	scheduler.request("goal-1", () => dispatches++);
	await new Promise((resolve) => setImmediate(resolve));
	scheduler.turnStarted();
	scheduler.request("goal-1", () => dispatches++);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(dispatches, 2);
});
