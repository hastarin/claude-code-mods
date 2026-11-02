# claude-code-mods

Claude Code mods, published as a plugin marketplace.

```
/plugin marketplace add RichardJSun/claude-code-mods
/plugin install cache-keepalive@richardjsun-mods
/plugin install model-select@richardjsun-mods
```

## cache-keepalive

When Claude ends a turn while background tasks are still running or a wake-up is scheduled (`ScheduleWakeup`, `/loop`), the prompt cache can expire before the session wakes. The next request then re-writes the whole context into the cache at 2× the input price.

This mod pings the cache with a one-line fork of the conversation every 50 minutes while the session waits. A cache read costs 0.025–0.1× input, so a ping costs a few percent of a re-write. Pings stop when:

- a new turn starts
- the session ends, or `/clear` or `/resume` replaces it
- a ping misses the cache
- the pings have cost as much as one re-write would have

`/keepalive` pings now and reports the hit rate. It refuses when no wait is armed or the cache has expired, because a miss there re-writes the whole context. `/keepalive force` pings anyway. A manual ping leaves any wait as it is. The status line shows `armed`, `warm` or `stopped`. `armed` and `warm` end with the time the cache expires if no ping lands, so a line still on screen after that time is stale.

### Limitations

A task or wake-up further ahead than the budget lasts (about 17 hours, or 33 on Opus 5.5 and 67 on Fable) still arms the mod, so the session pays for the pings and then the re-write. A task that never wakes the session spends the whole budget for nothing. The mod assumes the 1h cache TTL. It cannot read the TTL, so it infers the 5m TTL from overage, which switches a session to it. It does not arm while the 5-hour or 7-day rate-limit window is at 100% or more, and it stops if one crosses 100% during the wait. Mods cannot see model-scoped limits such as Fable's weekly one, so the mod ignores them. When such a limit runs out, the first ping misses and the mod stops. Rate-limit readings arrive with this session's own responses, so the mod may not see overage that other sessions cause during a wait. When a 5m TTL slips past the check, the first ping misses, pays for a full re-cache itself and saves nothing, and the mod stops.

### Veto idle compaction

The built-in idle compaction can replace the context that the pings are keeping warm. About 54 minutes after the last main-thread request it summarizes a context of at least 200k tokens in the background, and the next prompt installs that summary, however warm the cache is. The `vetoIdleCompaction` setting (off by default) vetoes it during a wait. The veto shows only in the debug log, as `precomputed compact: skipped`.

This is a heuristic. Idle compaction reaches mods as `precompute` and `auto`, the same triggers as context-full compaction, so the mod cannot identify it and judges by circumstance. It vetoes only when a wait is armed, no main-loop turn is in progress, the compaction is the main conversation's, and the context is known to be under 80% full. Everything else goes ahead, because a wrong veto mid-turn would end in a prompt-too-long error. A context-full compaction that meets all of those conditions, such as one for a prompt submitted while the context is under 80%, would still be vetoed.

### Compact on cap

The `compactOnCap` setting (off by default) compacts the conversation when the ping budget runs out, while the cache is still warm. It compacts only when the compaction's cost plus re-caching the summary is less than re-caching the whole context. The mod records the cost and summary size of each compaction it runs and uses them for the next decision. Compaction loses context detail, which is why it is off by default.

A background notification that arrives during compaction waits until compaction finishes, then starts its turn as usual.

Compaction keeps the earlier messages in the session file. After each compaction it runs, the mod adds two lines to the transcript, each with a command that opens the conversation as it was before that compaction, as a new session. Mods cannot read the platform, so one line is for POSIX shells and needs `jq`, and the other is for PowerShell. The compacted session does not change. Both use `--resume-session-at`, a CLI flag that `claude --help` does not show. `/rewind` cannot go back past a compaction after the session is resumed.

## model-select

The Agent tool's `model` field takes only the aliases `sonnet`, `opus`, `haiku` and `fable`. This mod lets a subagent run on any model your account can use, such as `claude-mythos-5-1` or `claude-haiku-4-5-20251001`.

When the first line of an Agent call's prompt is `model: <model>`, the mod runs the subagent on that model and removes the line before the subagent sees the prompt. The line takes the same names as `/model`: a full model ID, or an alias such as `best` or `opus[1m]`. The mod passes the name on unchanged. A name that does not exist fails at the API with `model_not_found`.

At session start the mod gets the list of models your credential can use from `GET /v1/models`, and the Agent tool's description lists those IDs. The fetch sends no message, so it costs no tokens.

### Limitations

The list needs a first-party Anthropic credential. On Bedrock, Vertex or a gateway, or when the fetch fails, the mod writes one line to the transcript with the reason, and the description lists no IDs. The `model:` line still works. A fork always runs on the parent's model, so the mod refuses a fork that has a `model:` line. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` overrides the `model:` line.
