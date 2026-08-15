import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_PREFERENCES,
	STATE_ENTRY_TYPE,
	TRIGGER_MESSAGE_TYPE,
	TRIGGER_TEXT,
	type GoalPreferences,
} from "./constants";
import { ContinuationScheduler } from "./continuation-scheduler";
import { filterProviderContext, type ContextMessageSnapshot } from "./context-policy";
import {
	accountGoalTurn,
	accountGoalUsage,
	completeGoal,
	createGoalState,
	goalUsage,
	normalizeTokenBudget,
	parseTokenBudget,
	pauseGoal,
	restoreGoalState,
	resumeGoal,
	statusLine,
	truncateObjective,
	type GoalPauseReason,
	type GoalState,
} from "./goal-state";
import { activeGoalSystemPrompt } from "./prompts";
import {
	isAssistantAbortMessage,
	isAssistantErrorMessage,
	isEmptySuccessfulAssistantTurn,
	type AssistantMessageSnapshot,
} from "./retry-context";
import { tokenDeltaFromUsage, type UsageSnapshot } from "./usage";
import {
	goalControlOptions,
	renderGoalUi,
	type GoalControlAction,
	type RuntimePhase,
} from "./ui";

type PersistedRuntimeState = {
	schemaVersion?: number;
	goal?: unknown;
	preferences?: Partial<GoalPreferences>;
	statusBarEnabled?: boolean;
	widgetEnabled?: boolean;
};

type ActiveTurn = {
	goalId: string;
	startedAt: number;
};

const ACTIVE_GOAL_TOOL_NAMES = ["get_goal", "update_goal"];

function restoreRuntimeState(ctx: ExtensionContext): { goal: GoalState | null; preferences: GoalPreferences } {
	const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & {
		getBranch?: () => unknown[];
		getEntries?: () => unknown[];
	};
	const entries = sessionManager.getBranch?.() ?? sessionManager.getEntries?.() ?? [];
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as { type?: unknown; customType?: unknown; data?: PersistedRuntimeState };
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
		const data = entry.data ?? {};
		return {
			goal: restoreGoalState(data.goal),
			preferences: {
				statusBarEnabled: data.preferences?.statusBarEnabled ?? data.statusBarEnabled ?? true,
				widgetEnabled: data.preferences?.widgetEnabled ?? data.widgetEnabled ?? true,
			},
		};
	}
	return { goal: null, preferences: { ...DEFAULT_PREFERENCES } };
}

export class GoalRuntime {
	private goal: GoalState | null = null;
	private preferences: GoalPreferences = { ...DEFAULT_PREFERENCES };
	private phase: RuntimePhase = "idle";
	private retryErrors = 0;
	private lastTurnWasError = false;
	private activeTurn: ActiveTurn | null = null;
	private pendingErrorTokens = 0;
	private pendingErrorSeconds = 0;
	private observedAbortSignal: AbortSignal | null = null;
	private removeAbortListener: (() => void) | null = null;
	private finalErrorNoticeShown = false;
	private providerErrorSeenThisTurn = false;
	private readonly continuation = new ContinuationScheduler();

	constructor(private readonly pi: ExtensionAPI) {}

	register(): void {
		this.registerTools();
		this.registerCommand();
		this.registerEvents();
	}

	private view() {
		return { phase: this.phase, retryErrors: this.retryErrors };
	}

	private render(ctx: ExtensionContext): void {
		renderGoalUi(ctx, this.goal, this.preferences, this.view());
	}

	private syncGoalTools(): void {
		const active = new Set(this.pi.getActiveTools());
		active.add("create_goal");
		for (const name of ACTIVE_GOAL_TOOL_NAMES) {
			if (this.goal?.status === "active") active.add(name);
			else active.delete(name);
		}
		this.pi.setActiveTools([...active]);
	}

	private snapshot() {
		return {
			schemaVersion: 2,
			goal: this.goal,
			preferences: this.preferences,
		};
	}

	private persist(ctx: ExtensionContext, next: GoalState | null): void {
		this.goal = next;
		if (next?.status !== "active") {
			this.continuation.cancel();
			this.phase = "idle";
			this.retryErrors = 0;
			this.lastTurnWasError = false;
			this.finalErrorNoticeShown = false;
			this.providerErrorSeenThisTurn = false;
			this.pendingErrorTokens = 0;
			this.pendingErrorSeconds = 0;
		}
		this.pi.appendEntry(STATE_ENTRY_TYPE, this.snapshot());
		this.syncGoalTools();
		this.render(ctx);
	}

	private persistPreferences(ctx: ExtensionContext): void {
		this.pi.appendEntry(STATE_ENTRY_TYPE, this.snapshot());
		this.render(ctx);
	}

	private foldPendingErrors(state: GoalState, now = Date.now()): GoalState {
		if (this.pendingErrorTokens === 0 && this.pendingErrorSeconds === 0) return state;
		const next = accountGoalUsage(state, this.pendingErrorTokens, this.pendingErrorSeconds, { now });
		this.pendingErrorTokens = 0;
		this.pendingErrorSeconds = 0;
		return next;
	}

	private pause(ctx: ExtensionContext, reason: Exclude<GoalPauseReason, null>, message?: string): boolean {
		if (!this.goal || this.goal.status !== "active") return false;
		const accounted = this.foldPendingErrors(this.goal);
		const next = pauseGoal(
			accounted.status === "active" ? accounted : { ...accounted, status: "active" },
			reason,
		);
		this.persist(ctx, next);
		if (message) ctx.ui.notify(message, "info");
		return true;
	}

	private resume(ctx: ExtensionContext): void {
		if (!this.goal) {
			ctx.ui.notify("No goal is set.", "warning");
			return;
		}
		if (this.goal.status === "active") {
			const accounted = this.foldPendingErrors(this.goal);
			if (accounted.status !== "active") {
				this.persist(ctx, accounted);
				ctx.ui.notify("Goal token budget reached. No retry turn was started.", "warning");
				return;
			}
			this.phase = "idle";
			this.lastTurnWasError = false;
			this.retryErrors = 0;
			this.finalErrorNoticeShown = false;
			this.providerErrorSeenThisTurn = false;
			this.continuation.cancel();
			if (accounted !== this.goal) this.persist(ctx, accounted);
			else this.render(ctx);
			if (ctx.isIdle()) this.queueContinuation(ctx);
			return;
		}
		const next = resumeGoal(this.foldPendingErrors(this.goal));
		this.retryErrors = 0;
		this.persist(ctx, next);
		if (ctx.isIdle()) this.queueContinuation(ctx);
	}

	private clear(ctx: ExtensionContext): void {
		if (!this.goal) {
			ctx.ui.notify("No goal is set.", "info");
			return;
		}
		this.pendingErrorTokens = 0;
		this.pendingErrorSeconds = 0;
		this.retryErrors = 0;
		this.persist(ctx, null);
		ctx.ui.notify("Goal cleared.", "info");
	}

	private startGoal(ctx: ExtensionContext, objective: string, tokenBudget: number | null): GoalState {
		this.continuation.cancel();
		this.pendingErrorTokens = 0;
		this.pendingErrorSeconds = 0;
		this.retryErrors = 0;
		this.lastTurnWasError = false;
		this.finalErrorNoticeShown = false;
		this.providerErrorSeenThisTurn = false;
		this.phase = ctx.isIdle() ? "idle" : "running";
		const next = createGoalState(objective, tokenBudget);
		this.persist(ctx, next);
		return next;
	}

	private complete(ctx: ExtensionContext, message?: string): boolean {
		if (!this.goal || this.goal.status === "complete") return false;
		this.persist(ctx, completeGoal(this.foldPendingErrors(this.goal)));
		if (message) ctx.ui.notify(message, "info");
		return true;
	}

	private restoreSession(ctx: ExtensionContext): void {
		const restored = restoreRuntimeState(ctx);
		this.goal = restored.goal;
		this.preferences = restored.preferences;
		this.phase = "idle";
		this.retryErrors = 0;
		this.lastTurnWasError = false;
		this.activeTurn = null;
		this.pendingErrorTokens = 0;
		this.pendingErrorSeconds = 0;
		this.finalErrorNoticeShown = false;
		this.providerErrorSeenThisTurn = false;
		this.continuation.cancel();
		this.clearAbortObserver();
		this.syncGoalTools();
	}

	private queueContinuation(ctx: ExtensionContext): void {
		const state = this.goal;
		if (!state || state.status !== "active" || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		this.continuation.request(state.id, () => {
			if (!this.goal || this.goal.id !== state.id || this.goal.status !== "active") return;
			try {
				this.pi.sendMessage(
					{
						customType: TRIGGER_MESSAGE_TYPE,
						content: TRIGGER_TEXT,
						display: false,
						details: { kind: "continuation", goal: this.goal, timestamp: Date.now() },
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			} catch {
				this.continuation.cancel();
				this.phase = "waiting";
				this.render(ctx);
				ctx.ui.notify("Goal continuation could not be queued. No model turn was started; use /goal resume to retry.", "warning");
			}
		});
	}

	private observeAbort(ctx: ExtensionContext): void {
		const signal = ctx.signal ?? null;
		if (signal === this.observedAbortSignal) return;
		this.removeAbortListener?.();
		this.removeAbortListener = null;
		this.observedAbortSignal = signal;
		if (!signal) return;
		const onAbort = () => {
			this.pause(
				ctx,
				"interrupt",
				`Goal paused after user interrupt: ${truncateObjective(this.goal?.objective ?? "")}`,
			);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		this.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
	}

	private clearAbortObserver(): void {
		this.removeAbortListener?.();
		this.removeAbortListener = null;
		this.observedAbortSignal = null;
	}

	private async showControls(ctx: ExtensionContext): Promise<void> {
		if (!this.goal) {
			ctx.ui.notify("Usage: /goal [--tokens 50k] <objective>", "info");
			return;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify(`${statusLine(this.goal)}\nObjective: ${this.goal.objective}`, "info");
			return;
		}
		const options = goalControlOptions(this.goal, this.phase);
		const selected = await ctx.ui.select(
			`Goal · ${this.goal.status} · ${goalUsage(this.goal)}\n${truncateObjective(this.goal.objective, 120)}`,
			options.map((option) => option.label),
		);
		const action = options.find((option) => option.label === selected)?.action;
		if (!action || action === "close") return;
		await this.applyControl(action, ctx);
	}

	private async applyControl(action: GoalControlAction, ctx: ExtensionContext): Promise<void> {
		if (action === "pause") {
			this.pause(ctx, "user", "Goal paused.");
			return;
		}
		if (action === "resume") {
			this.resume(ctx);
			return;
		}
		if (action === "complete") {
			this.complete(ctx, "Goal marked complete.");
			return;
		}
		if (action === "clear") {
			if (!this.goal) return;
			const confirmed = await ctx.ui.confirm("Clear goal?", this.goal.objective);
			if (confirmed) this.clear(ctx);
		}
	}

	private registerTools(): void {
		this.pi.registerTool({
			name: "get_goal",
			label: "Get Goal",
			description: "Read the current active thread goal, progress, and remaining budget.",
			promptSnippet: "Read the current pi-goal state only when the injected goal prompt is insufficient",
			promptGuidelines: ["Avoid calling get_goal every turn; active goal state is already injected."],
			parameters: { type: "object", properties: {}, additionalProperties: false } as any,
			execute: async () => {
				return { content: [{ type: "text", text: JSON.stringify({ goal: this.goal }, null, 2) }], details: { goal: this.goal } };
			},
		});

		this.pi.registerTool({
			name: "create_goal",
			label: "Create Goal",
			description: "Create or replace a durable thread goal only when explicitly requested by the user or system.",
			promptSnippet: "Create a pi-goal only when goal mode was explicitly requested",
			promptGuidelines: [
				"Do not infer goals from ordinary coding tasks or one-off prompts.",
				"Write an evidence-checkable objective covering outcome, verification surface, constraints, boundaries, iteration policy, and blocked stop condition.",
				"Prefer a self-contained objective that survives continuation turns and context compaction.",
				"Set tokenBudget only when the user explicitly requested one.",
			],
			parameters: {
				type: "object",
				properties: {
					objective: { type: "string", description: "Concrete, evidence-checkable objective." },
					tokenBudget: { type: "number", description: "Optional positive token budget, only when explicitly requested." },
				},
				required: ["objective"],
				additionalProperties: false,
			} as any,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				const args = params as { objective?: unknown; tokenBudget?: unknown };
				const objective = typeof args.objective === "string" ? args.objective.trim() : "";
				if (!objective) return { content: [{ type: "text", text: "objective is required." }], details: { goal: this.goal }, isError: true };
				const parsedBudget = normalizeTokenBudget(args.tokenBudget);
				if (parsedBudget.error) return { content: [{ type: "text", text: parsedBudget.error }], details: { goal: this.goal }, isError: true };
				const next = this.startGoal(ctx, objective, parsedBudget.tokenBudget);
				return { content: [{ type: "text", text: JSON.stringify({ goal: next }, null, 2) }], details: { goal: next } };
			},
		});

		this.pi.registerTool({
			name: "update_goal",
			label: "Complete Goal",
			description: "Mark the active goal complete after a strict evidence audit. Only status=complete is accepted.",
			promptSnippet: "Mark the current goal complete only after every requirement is verified",
			promptGuidelines: [
				"Use update_goal only when the current objective is fully achieved and verified.",
				"Do not use update_goal to pause, resume, abandon, or budget-limit a goal.",
			],
			parameters: {
				type: "object",
				properties: { status: { type: "string", enum: ["complete"] } },
				required: ["status"],
				additionalProperties: false,
			} as any,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				const args = params as { status?: unknown };
				if (args.status !== "complete") return { content: [{ type: "text", text: "update_goal only accepts status=complete." }], details: { goal: this.goal }, isError: true };
				if (!this.goal) return { content: [{ type: "text", text: "No goal is set." }], details: { goal: null }, isError: true };
				const next = completeGoal(this.foldPendingErrors(this.goal));
				this.persist(ctx, next);
				return { content: [{ type: "text", text: JSON.stringify({ goal: next }, null, 2) }], details: { goal: next } };
			},
		});
	}

	private registerCommand(): void {
		this.pi.registerCommand("goal", {
			description: "Open goal controls, or set, view, pause, resume, clear, and configure a goal",
			getArgumentCompletions: (prefix) => {
				const values = ["status", "pause", "resume", "complete", "clear", "ui", "ui on", "ui off", "statusbar", "statusbar on", "statusbar off"];
				const filtered = values.filter((value) => value.startsWith(prefix));
				return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
			},
			handler: async (args, ctx) => {
				const trimmed = args.trim();
				if (!trimmed) {
					await this.showControls(ctx);
					return;
				}
				if (trimmed === "status") {
					if (!this.goal) ctx.ui.notify("No goal is set.", "info");
					else ctx.ui.notify(`${statusLine(this.goal)}\nObjective: ${this.goal.objective}\nUsage: ${goalUsage(this.goal)}`, "info");
					return;
				}
				if (trimmed === "pause") {
					if (!this.pause(ctx, "user", "Goal paused.")) ctx.ui.notify("No active goal is running.", "info");
					return;
				}
				if (trimmed === "resume") {
					this.resume(ctx);
					return;
				}
				if (trimmed === "complete") {
					if (!this.complete(ctx, "Goal marked complete.")) ctx.ui.notify("No incomplete goal is set.", "info");
					return;
				}
				if (trimmed === "clear") {
					this.clear(ctx);
					return;
				}
				if (/^(?:ui|statusbar)(?:\s+(?:on|off|toggle))?$/.test(trimmed)) {
					const [setting, rawValue] = trimmed.split(/\s+/, 2);
					const key = setting === "ui" ? "widgetEnabled" : "statusBarEnabled";
					const current = this.preferences[key];
					this.preferences = { ...this.preferences, [key]: rawValue === "on" ? true : rawValue === "off" ? false : !current };
					this.persistPreferences(ctx);
					ctx.ui.notify(`Goal ${setting === "ui" ? "widget" : "status bar"} ${this.preferences[key] ? "enabled" : "disabled"}.`, "info");
					return;
				}

				const parsed = parseTokenBudget(trimmed);
				if (parsed.error) {
					ctx.ui.notify(parsed.error, "warning");
					return;
				}
				if (!parsed.objective) {
					ctx.ui.notify("Usage: /goal [--tokens 50k] <objective>", "warning");
					return;
				}
				if (this.goal && this.goal.status !== "complete") {
					const confirmed = await ctx.ui.confirm("Replace goal?", `Current: ${this.goal.objective}\n\nNew: ${parsed.objective}`);
					if (!confirmed) return;
				}
				this.startGoal(ctx, parsed.objective, parsed.tokenBudget);
				if (ctx.isIdle()) this.queueContinuation(ctx);
			},
		});
	}

	private registerEvents(): void {
		this.pi.on("session_start", (event, ctx) => {
			this.restoreSession(ctx);
			if (this.goal?.status === "active" && event.reason === "reload") {
				const next = pauseGoal(this.goal, "reload");
				this.persist(ctx, next);
				ctx.ui.notify(`Goal paused after reload: ${truncateObjective(next.objective)}\nUse /goal to resume or clear it.`, "info");
				return;
			}
			this.render(ctx);
		});

		this.pi.on("session_tree", (_event, ctx) => {
			this.restoreSession(ctx);
			this.render(ctx);
		});

		this.pi.on("session_shutdown", (_event, ctx) => {
			this.continuation.cancel();
			this.clearAbortObserver();
			renderGoalUi(ctx, null, this.preferences, { phase: "idle", retryErrors: 0 });
		});

		this.pi.on("input", (event, ctx) => {
			if (event.source !== "extension" && event.streamingBehavior === "steer") {
				this.pause(ctx, "interrupt", "Goal paused because the user interrupted the active run.");
			}
			return { action: "continue" };
		});

		this.pi.on("before_agent_start", (event) => {
			if (!this.goal || this.goal.status !== "active") return;
			return { systemPrompt: `${event.systemPrompt}\n\n${activeGoalSystemPrompt(this.goal)}` };
		});

		this.pi.on("turn_start", (_event, ctx) => {
			this.continuation.turnStarted();
			this.observeAbort(ctx);
			this.phase = "running";
			this.providerErrorSeenThisTurn = false;
			this.activeTurn = this.goal?.status === "active" ? { goalId: this.goal.id, startedAt: Date.now() } : null;
			this.render(ctx);
		});

		this.pi.on("after_provider_response", (event, ctx) => {
			if (!this.goal || this.goal.status !== "active" || event.status < 400) return;
			this.providerErrorSeenThisTurn = true;
			this.retryErrors++;
			this.phase = "retrying";
			this.render(ctx);
		});

		this.pi.on("turn_end", (event, ctx) => {
			const message = event.message as AssistantMessageSnapshot;
			const activeTurn = this.activeTurn;
			this.activeTurn = null;
			const elapsed = activeTurn ? Math.max(0, Math.round((Date.now() - activeTurn.startedAt) / 1000)) : 0;
			const matchesGoal = Boolean(this.goal && activeTurn && activeTurn.goalId === this.goal.id);

			if (isAssistantErrorMessage(message)) {
				if (!matchesGoal) {
					this.phase = "idle";
					this.lastTurnWasError = false;
					this.providerErrorSeenThisTurn = false;
					this.render(ctx);
					return;
				}
				if (matchesGoal) {
					this.pendingErrorTokens += tokenDeltaFromUsage((message as { usage?: UsageSnapshot }).usage);
					this.pendingErrorSeconds += elapsed;
				}
				if (!this.providerErrorSeenThisTurn) this.retryErrors++;
				this.providerErrorSeenThisTurn = false;
				if (matchesGoal && this.goal && this.goal.status !== "active") {
					this.phase = "idle";
					this.lastTurnWasError = false;
					this.persist(ctx, this.foldPendingErrors(this.goal));
					return;
				}
				this.phase = "retrying";
				this.lastTurnWasError = true;
				this.render(ctx);
				return;
			}

			this.phase = "idle";
			this.lastTurnWasError = false;
			this.finalErrorNoticeShown = false;
			const previousRetryErrors = this.retryErrors;
			this.retryErrors = 0;
			if (!this.goal || !matchesGoal) {
				if (isAssistantAbortMessage(message) && this.goal?.status === "active") {
					this.pause(ctx, "interrupt", "Goal paused after user interrupt.");
				} else {
					this.render(ctx);
				}
				return;
			}

			const tokenDelta = this.pendingErrorTokens + tokenDeltaFromUsage((message as { usage?: UsageSnapshot }).usage);
			const elapsedTotal = this.pendingErrorSeconds + elapsed;
			this.pendingErrorTokens = 0;
			this.pendingErrorSeconds = 0;
			let next = accountGoalTurn(this.goal, tokenDelta, elapsedTotal);

			if (isAssistantAbortMessage(message) && next.status === "active") {
				next = pauseGoal(next, "interrupt");
				this.persist(ctx, next);
				ctx.ui.notify("Goal paused after user interrupt. Use /goal to resume or clear it.", "info");
				return;
			}

			if (next.status === "active" && isEmptySuccessfulAssistantTurn(message, event.toolResults)) {
				next = pauseGoal(next, "empty_response");
				this.persist(ctx, next);
				ctx.ui.notify("Goal paused because the provider returned an empty successful turn; no continuation was queued.", "warning");
				return;
			}

			this.persist(ctx, next);
			if (next.status === "budget_limited") {
				ctx.ui.notify("Goal token budget reached. No extra wrap-up turn was started. Use /goal to resume without the budget or clear it.", "warning");
			} else if (previousRetryErrors > 0) {
				ctx.ui.notify(`Provider recovered after ${previousRetryErrors} error${previousRetryErrors === 1 ? "" : "s"}; goal work resumed.`, "info");
			}
		});

		this.pi.on("context", (event) => {
			const activeGoalId = this.goal?.status === "active" ? this.goal.id : null;
			const originalMessages = event.messages as unknown as ContextMessageSnapshot[];
			const messages = filterProviderContext(originalMessages, activeGoalId);
			if (messages.length === originalMessages.length && messages.every((message, index) => message === originalMessages[index])) return;
			return { messages: messages as unknown as typeof event.messages };
		});

		this.pi.on("agent_settled", (_event, ctx) => {
			this.clearAbortObserver();
			if (!this.goal || this.goal.status !== "active") return;
			if (this.lastTurnWasError) {
				const hadPendingUsage = this.pendingErrorTokens > 0 || this.pendingErrorSeconds > 0;
				const accounted = this.foldPendingErrors(this.goal);
				if (accounted.status !== "active") {
					this.persist(ctx, accounted);
					ctx.ui.notify("Goal token budget reached while retrying. No continuation was queued.", "warning");
					return;
				}
				this.phase = "waiting";
				if (hadPendingUsage) this.persist(ctx, accounted);
				else this.render(ctx);
				if (!this.finalErrorNoticeShown) {
					this.finalErrorNoticeShown = true;
					ctx.ui.notify("Pi's configured retry window ended without recovery. No synthetic message was added; use /goal resume to start another retry window.", "warning");
				}
				return;
			}
			if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
			this.queueContinuation(ctx);
		});
	}
}
