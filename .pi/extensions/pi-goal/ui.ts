import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import { STATUS_KEY, TRIGGER_MESSAGE_TYPE, WIDGET_KEY, type GoalPreferences } from "./constants";
import { formatTokens, goalUsage, statusLine, truncateObjective, type GoalState } from "./goal-state";

export type RuntimePhase = "idle" | "running" | "retrying" | "waiting";

export type GoalUiView = {
	phase: RuntimePhase;
	retryErrors: number;
};

export type GoalControlAction = "pause" | "resume" | "complete" | "clear" | "close";

export type GoalControlOption = {
	action: GoalControlAction;
	label: string;
};

function statusLabel(state: GoalState): string {
	if (state.status === "active") return "ACTIVE";
	if (state.status === "paused") return "PAUSED";
	if (state.status === "budget_limited") return "BUDGET REACHED";
	return "COMPLETE";
}

export function goalControlOptions(state: GoalState, phase: RuntimePhase = "idle"): GoalControlOption[] {
	if (state.status === "complete") {
		return [
			{ action: "resume", label: "Reopen goal" },
			{ action: "clear", label: "Clear goal" },
			{ action: "close", label: "Close" },
		];
	}

	const primary: GoalControlOption = state.status === "active"
		? phase === "waiting"
			? { action: "resume", label: "Retry now" }
			: { action: "pause", label: "Pause goal" }
		: { action: "resume", label: state.status === "budget_limited" ? "Resume without token budget" : "Resume goal" };
	return [
		primary,
		{ action: "complete", label: "Mark complete" },
		{ action: "clear", label: "Clear goal" },
		{ action: "close", label: "Close" },
	];
}

export function goalWidgetLines(state: GoalState, view: GoalUiView): string[] {
	const liveStatus = view.phase === "retrying" && state.status === "active"
		? `RETRYING · ${formatTokens(view.retryErrors)} provider error${view.retryErrors === 1 ? "" : "s"} · context unchanged`
		: view.phase === "waiting" && state.status === "active"
			? `WAITING · retry window ended · /goal resume starts another`
		: `${statusLabel(state)} · ${state.turnsCompleted} turn${state.turnsCompleted === 1 ? "" : "s"} · ${goalUsage(state)}`;
	const reason = state.status === "paused" && state.pauseReason
		? `Paused by: ${state.pauseReason.replace("_", " ")}`
		: null;
	return [
		liveStatus,
		`Objective: ${truncateObjective(state.objective, 180)}`,
		...(reason ? [reason] : []),
		"Controls: /goal opens Retry / Pause / Resume / Complete / Clear controls",
	];
}

function runtimeStatusLine(state: GoalState | null, view: GoalUiView): string | undefined {
	if (!state) return undefined;
	if (view.phase === "retrying" && state.status === "active") {
		return `Goal retrying (${formatTokens(view.retryErrors)} errors, context unchanged)`;
	}
	if (view.phase === "waiting" && state.status === "active") return "Goal waiting (/goal resume retries)";
	if (view.phase === "running" && state.status === "active") return `Pursuing goal · ${goalUsage(state)}`;
	return statusLine(state);
}

export function renderGoalUi(
	ctx: ExtensionContext,
	state: GoalState | null,
	preferences: GoalPreferences,
	view: GoalUiView,
): void {
	ctx.ui.setStatus(STATUS_KEY, preferences.statusBarEnabled ? runtimeStatusLine(state, view) : undefined);
	ctx.ui.setWidget(
		WIDGET_KEY,
		preferences.widgetEnabled && state ? goalWidgetLines(state, view) : undefined,
		{ placement: "aboveEditor" },
	);
}

function eventLabel(kind: string, state: GoalState | null): string {
	if (kind === "continuation") return "continuing";
	if (kind === "resumed") return "resumed";
	if (kind === "active") return "active";
	return state?.status ?? kind;
}

export function registerGoalMessageRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(TRIGGER_MESSAGE_TYPE, (message, { expanded }, theme) => {
		const details = message.details as { kind?: string; goal?: GoalState | null } | undefined;
		const state = details?.goal ?? null;
		const label = eventLabel(details?.kind ?? "continuation", state);
		const box = new Box(1, 1, (value) => theme.bg("customMessageBg", value));
		box.addChild(new Text(theme.fg("customMessageLabel", theme.bold("Goal")), 0, 0));
		box.addChild(new Spacer(1));
		if (!expanded || !state) {
			box.addChild(new Text(theme.fg("customMessageText", label), 0, 0));
			return box;
		}
		box.addChild(new Text([
			`${theme.fg("dim", "Status: ")}${theme.fg("customMessageText", label)}`,
			`${theme.fg("dim", "Goal: ")}${theme.fg("customMessageText", state.objective)}`,
			`${theme.fg("dim", "Usage: ")}${theme.fg("customMessageText", goalUsage(state))}`,
		].join("\n"), 0, 0));
		return box;
	});
}
