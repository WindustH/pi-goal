# pi-goal

![pi-goal](docs/assets/pi-goal-poster.png)

Robust, context-neutral persistent goals for [Pi](https://github.com/earendil-works/pi), with shared TUI and pi-web status controls.

`pi-goal` keeps a thread-scoped objective running until it is completed, paused, cleared, or token-budget-limited. Provider failures do not create extension continuation loops, repeated goal prompts are collapsed before every model request, and each Pi/pi-web session owns an isolated runtime.

## Install

```bash
pi install npm:@windust/pi-goal
```

Or from GitHub:

```bash
pi install git:github.com/WindustH/pi-goal
```

Remove the original unscoped package if it is still installed, so only one extension owns `/goal`:

```bash
pi remove npm:pi-goal
```

Pi 0.80.6 or newer is required. The Web UI is tested with `@agegr/pi-web` 0.8.8.

## Usage and controls

```text
/goal improve benchmark coverage until every requirement has direct evidence
/goal --tokens 50k finish the migration and verify it
/goal                 # open interactive controls
/goal status
/goal pause
/goal resume
/goal complete
/goal clear
/goal ui on|off
/goal statusbar on|off
```

The persistent `Goal` widget shows lifecycle state, objective, completed turns, token/time usage, and retry state.

- In the TUI, `/goal` opens the native selector.
- In `@agegr/pi-web`, `/goal` opens native Retry/Pause, Resume/Reopen, Mark complete, Clear, and Close buttons. These are extension UI actions, not prompts, so clicking them spends no model tokens and adds no conversation message.
- The widget uses Pi's official string-array `setWidget` contract, which pi-web relays through its RPC extension UI protocol. No pi-web patch or fork is required.

`/goal ui off` hides the expanded widget. `/goal statusbar off` independently hides the compact footer status.

## Provider retry behavior

On an assistant `error` turn, the extension:

- appends no `pi-goal` state entry;
- sends no synthetic continuation;
- removes the error from every later provider context;
- leaves retry timing and cancellation to Pi;
- shows an in-memory `RETRYING · … · context unchanged` UI state.

Pi's agent-level retry window is finite by default. For the long quota-hold behavior—keep the same provider request retrying until quota returns, without finalizing more assistant messages—configure provider-level retries in `~/.pi/agent/settings.json`:

```json
{
  "retry": {
    "enabled": true,
    "provider": {
      "maxRetries": 1000000,
      "maxRetryDelayMs": 60000
    }
  }
}
```

Provider-level retry keeps the request in flight and can remain blocked until quota recovers. It is still abortable. If Pi's configured retry window does end, pi-goal enters a visible `WAITING` state without injecting a message; `/goal resume` starts another window.

There is no automatic goal-turn cap. An optional `--tokens` budget remains available only when the user explicitly requests one.

## Interrupt and token-safety behavior

- A user abort pauses the active goal immediately. The runtime observes Pi's `AbortSignal`, finalized `stopReason: "aborted"`, and mid-stream user steering, covering both TUI and RPC/pi-web paths.
- A successful but empty provider response pauses the goal instead of starting an empty continuation loop.
- Reaching a token budget stops immediately; pi-goal does not spend an extra model turn asking for a wrap-up.
- Pause, clear, completion, settings, and Web button actions are persisted as non-context custom entries. They do not inject lifecycle prose into the model conversation.
- Failed-attempt usage is accumulated in memory and folded into the next persisted state once, rather than writing one state entry per error.

## Context policy

The full active objective and completion contract are injected once per agent run through `before_agent_start`. Continuation messages are intentionally tiny and hidden.

Before every provider request, the context policy:

1. removes every assistant error message;
2. removes goal triggers from old/replaced/paused goals;
3. keeps at most the newest trigger for the active goal;
4. rewrites even a legacy full continuation prompt to the compact trigger text.

This is non-destructive: local JSONL may retain core Pi error diagnostics, but they are never sent back to a model. Thousands of historical errors and continuation prompts therefore contribute zero errors and at most one short trigger to paid input context.

## Goal tools

- `create_goal`: creates or replaces a goal only when the user or system explicitly requests goal mode.
- `get_goal`: reads the active goal when the injected state is insufficient.
- `update_goal`: accepts only `status: "complete"`, after an evidence-backed completion audit.

`get_goal` and `update_goal` are exposed only while a goal is active. `create_goal` stays available so an explicitly requested goal can be created or replaced.

## Architecture

The extension is split by responsibility:

- `runtime.ts`: one isolated controller per Pi AgentSession; lifecycle wiring and durable commits;
- `goal-state.ts`: validated schema migration and pure state transitions;
- `context-policy.ts`: provider-context error removal and trigger compaction;
- `continuation-scheduler.ts`: race-safe continuation coalescing and cancellation;
- `ui.ts`: shared status/widget view model and interactive control choices;
- `prompts.ts`: the active-goal system contract;
- `retry-context.ts` and `usage.ts`: provider outcome classification and accounting.

Schema v1 session state migrates to v2 on restore. Malformed state is ignored instead of crashing the extension. Module-global mutable goal state has been removed, preventing cross-session leakage when pi-web runs multiple AgentSession instances in one process.

## Development

```bash
npm test
npm run typecheck
npm run check
npm run pack:dry
```

## License

MIT
