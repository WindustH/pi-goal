export type GoalStatus = "active" | "paused" | "budget_limited" | "complete";

export type GoalPauseReason = "user" | "interrupt" | "reload" | "empty_response" | null;

export type GoalState = {
	version: 2;
	id: string;
	objective: string;
	status: GoalStatus;
	pauseReason: GoalPauseReason;
	tokenBudget: number | null;
	tokensUsed: number;
	timeUsedSeconds: number;
	turnsCompleted: number;
	createdAt: number;
	updatedAt: number;
};

export function parseTokenBudget(input: string): { objective: string; tokenBudget: number | null; error?: string } {
	const match = input.match(/(?:^|\s)--tokens(?:=|\s+)(\S+\s*[kKmM]?)(?:\s|$)/);
	if (!match) return { objective: input.trim(), tokenBudget: null };

	const raw = match[1].replace(/\s+/g, "");
	const suffix = raw.slice(-1).toLowerCase();
	const numeric = suffix === "k" || suffix === "m" ? raw.slice(0, -1) : raw;
	const value = Number(numeric);
	if (!Number.isFinite(value) || value <= 0) {
		return { objective: input.trim(), tokenBudget: null, error: "Token budget must be positive." };
	}
	const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
	const tokenBudget = Math.round(value * multiplier);
	const objective = (input.slice(0, match.index) + " " + input.slice((match.index ?? 0) + match[0].length)).trim();
	return { objective, tokenBudget };
}

export function normalizeTokenBudget(value: unknown): { tokenBudget: number | null; error?: string } {
	if (value == null) return { tokenBudget: null };
	const tokenBudget = Math.round(Number(value));
	if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
		return { tokenBudget: null, error: "tokenBudget must be a positive number when provided." };
	}
	return { tokenBudget };
}

export function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
	if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
	return String(value);
}

export function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remMinutes = minutes % 60;
	return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

export function statusLine(state: GoalState | null): string | undefined {
	if (!state) return undefined;
	const budget = state.tokenBudget
		? ` (${formatTokens(state.tokensUsed)} / ${formatTokens(state.tokenBudget)})`
		: ` (${formatElapsed(state.timeUsedSeconds)})`;
	if (state.status === "active") return `Pursuing goal${budget}`;
	if (state.status === "paused") return "Goal paused (/goal resume)";
	if (state.status === "budget_limited") return state.tokenBudget ? `Goal budget reached${budget}` : "Goal stopped";
	return `Goal achieved${budget}`;
}

export function goalUsage(state: GoalState): string {
	if (state.tokenBudget != null) return `${formatTokens(state.tokensUsed)} / ${formatTokens(state.tokenBudget)} tokens`;
	return `${formatTokens(state.tokensUsed)} tokens · ${formatElapsed(state.timeUsedSeconds)}`;
}

export function truncateObjective(objective: string, max = 96): string {
	const singleLine = objective.replace(/\s+/g, " ").trim();
	return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

export function createGoalState(objective: string, tokenBudget: number | null, now = Date.now(), random = Math.random()): GoalState {
	return {
		version: 2,
		id: `${now}-${random.toString(16).slice(2)}`,
		objective,
		status: "active",
		pauseReason: null,
		tokenBudget,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		turnsCompleted: 0,
		createdAt: now,
		updatedAt: now,
	};
}

function finiteNonNegative(value: unknown): number {
	const numeric = Number(value);
	return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

export function restoreGoalState(value: unknown): GoalState | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.id !== "string" || !candidate.id) return null;
	if (typeof candidate.objective !== "string" || !candidate.objective.trim()) return null;
	if (!["active", "paused", "budget_limited", "complete"].includes(String(candidate.status))) return null;
	const tokenBudget = candidate.tokenBudget == null ? null : finiteNonNegative(candidate.tokenBudget);
	if (tokenBudget === 0 && candidate.tokenBudget != null) return null;
	const status = candidate.status as GoalStatus;
	const pauseReason = candidate.version === 2 && ["user", "interrupt", "reload", "empty_response", null].includes(candidate.pauseReason as GoalPauseReason)
		? (candidate.pauseReason as GoalPauseReason)
		: status === "paused" ? "user" : null;
	return {
		version: 2,
		id: candidate.id,
		objective: candidate.objective.trim(),
		status,
		pauseReason,
		tokenBudget,
		tokensUsed: finiteNonNegative(candidate.tokensUsed),
		timeUsedSeconds: finiteNonNegative(candidate.timeUsedSeconds),
		turnsCompleted: Math.floor(finiteNonNegative(candidate.turnsCompleted)),
		createdAt: finiteNonNegative(candidate.createdAt),
		updatedAt: finiteNonNegative(candidate.updatedAt),
	};
}

export function accountGoalUsage(
	state: GoalState,
	tokenDelta: number,
	elapsedSeconds: number,
	options: { completedTurn?: boolean; now?: number } = {},
): GoalState {
	let next: GoalState = {
		...state,
		tokensUsed: state.tokensUsed + Math.max(0, tokenDelta),
		timeUsedSeconds: state.timeUsedSeconds + Math.max(0, elapsedSeconds),
		turnsCompleted: state.turnsCompleted + (options.completedTurn ? 1 : 0),
		updatedAt: options.now ?? Date.now(),
	};
	if (next.status === "active" && next.tokenBudget != null && next.tokensUsed >= next.tokenBudget) {
		next = { ...next, status: "budget_limited", pauseReason: null };
	}
	return next;
}

export function accountGoalTurn(state: GoalState, tokenDelta: number, elapsedSeconds: number, now = Date.now()): GoalState {
	return accountGoalUsage(state, tokenDelta, elapsedSeconds, { completedTurn: true, now });
}

export function pauseGoal(state: GoalState, reason: Exclude<GoalPauseReason, null>, now = Date.now()): GoalState {
	if (state.status !== "active") return state;
	return { ...state, status: "paused", pauseReason: reason, updatedAt: now };
}

export function resumeGoal(state: GoalState, now = Date.now()): GoalState {
	const clearExhaustedBudget = state.tokenBudget != null && state.tokensUsed >= state.tokenBudget;
	return {
		...state,
		status: "active",
		pauseReason: null,
		tokenBudget: clearExhaustedBudget ? null : state.tokenBudget,
		updatedAt: now,
	};
}

export function completeGoal(state: GoalState, now = Date.now()): GoalState {
	return { ...state, status: "complete", pauseReason: null, updatedAt: now };
}
