# pi-goal

![pi-goal](docs/assets/pi-goal-poster.png)

Persistent autonomous goals for [Pi](https://github.com/earendil-works/pi).

`pi-goal` adds a `/goal` command and goal tools so Pi can keep working toward a long-running, thread-scoped objective until the goal is complete, paused, cleared, or token-budget-limited.

This fork makes provider retries context-neutral. Quota and transient provider errors may still be retried by Pi, but failed assistant messages are removed from every later provider context, error turns do not persist duplicate goal state, and the extension does not inject another continuation while Pi's retry/compaction pipeline is active. When the provider succeeds and Pi fully settles, goal work continues naturally.

## Install

```bash
pi install npm:@windust/pi-goal
```

Or from git:

```bash
pi install git:github.com/WindustH/pi-goal
```

If the original unscoped package is installed, remove it first so only one extension owns `/goal`:

```bash
pi remove npm:pi-goal
```

## Usage

```text
/goal improve benchmark coverage until the suite has strong evidence
/goal --tokens 50k finish the migration and verify tests
/goal
/goal status
/goal pause
/goal resume
/goal clear
/goal statusbar off
```

When a goal is active, the extension shows compact visible lifecycle markers like `Goal active` and `Goal continuing`; expand them with `ctrl+o` to inspect the objective and usage. The full continuation instructions ride along as the content of that custom message, so the model always has the objective and audit guidance in the transcript while the renderer keeps the visible UI compact.

The same Pi agent keeps running normal turns in the same session context until it calls `update_goal({ status: "complete" })`, the user pauses/clears it, or the token budget is reached. Reloading Pi pauses an active goal instead of silently resuming it; use `/goal resume` to continue. Pi 0.80.6 or newer is required because safe continuation uses the `agent_settled` lifecycle boundary.

## What it adds

- `pi-goal-writer` skill: draft and review strong `/goal` objectives with evidence-based success criteria
- `/goal [--tokens 50k] <objective>`: set or replace a goal
- `/goal` or `/goal status`: show the current goal
- `/goal pause`: stop autonomous continuation without deleting the goal
- `/goal resume`: reactivate a paused goal
- `/goal clear`: remove the goal
- `/goal statusbar on|off`: show or hide the footer status line
- `create_goal` tool: model can set or replace the current goal only when explicitly requested
- `get_goal` tool: read current goal state
- `update_goal` tool: model can only mark the goal `complete`
- `get_goal` and `update_goal` are only exposed to the model while a goal is `active`; paused, cleared, complete, and budget-limited goals hide them so unrelated sessions are not tempted to call them
- footer status: `Pursuing goal`, `Goal paused`, `Goal achieved`, or `Goal unmet`

## Flow

```text
/goal <objective>
  -> persist goal in the current Pi session
  -> show compact Goal marker and footer status
  -> deliver continuation instructions as the marker's message content
  -> trigger an agent turn
  -> account time/tokens on turn_end
  -> provider errors: let Pi retry, filter errors from context, append no goal messages
  -> queue another continuation on agent_settled while active
  -> stop when update_goal marks complete, user pauses/clears, or budget is hit
```

## Retry behavior

- Provider `error` messages stay in the local JSONL transcript for diagnostics, but the `context` hook removes them before every later model request.
- Error turns do not append `pi-goal` state entries and do not add `pi-goal-event` continuation messages.
- Pi retains ownership of retry timing and backoff. The extension waits for `agent_settled`, which fires only after native retries, auto-compaction, and pending messages have drained.
- Once a retry succeeds, its real usage is accounted once and the next goal continuation is dispatched normally.
- A user abort is not treated as a retryable provider error: it pauses the goal immediately.
- There is no automatic-turn cap in this fork. Optional `/goal --tokens ...` budgets, manual pause/clear, reload pause, and verified completion keep their existing behavior.

## Completion behavior

The model is instructed to audit completion against real evidence before calling `update_goal`. The `update_goal` tool deliberately accepts only `status: "complete"`; pausing, resuming, clearing, and budget limiting are controlled by the user or extension runtime. The final turn is still accounted even when the model completes the goal mid-turn.

## State

Goal state is stored as Pi custom session entries with `customType: "pi-goal"`. It follows the active session branch, survives reloads, and does not require an external database.

## License

MIT
