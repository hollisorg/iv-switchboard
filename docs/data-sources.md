# Data sources

How IV Switchboard reads each app's own files. These are the log formats as observed on 2026-11-17 (Codex,
Claude Code and Hermes v0.22.5). None of them is a documented API, so a client update can change them; the readers
report a problem with the file and byte offset (never the content) rather than guess.

## Codex

- Files: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and `~/.codex/archived_sessions`. `CODEX_HOME` moves the folder.
- Each line has an increasing `ordinal`; the first line is always `session_meta`.
- One completed reply per `token_usage_record` line for the session's own thread (`payload.thread_id`), keyed by
  `response_id`, with a `usage` object.
- Allowance: `event_msg` / `token_count` lines carry `rate_limits` (`primary` and `secondary`, each with
  `used_percent`, `window_minutes` and `resets_at` in epoch seconds; also `credits` and `plan_type`). Often null.
- A sub-agent's log starts with a copy of its parent's history. Lines with an `ordinal` below
  `subagent_history_start_ordinal` are skipped. Logs without that marker count from the first `task_started` whose
  `started_at` (whole seconds) is at or after the second the sub-agent was created: that first task can be logged up to
  half a second "before" creation, so a millisecond comparison misses it.
- Each usage record is followed by a `token_count` line repeating it, so `token_count` usage is only counted in older
  logs that have no usage records.
- Codex `input_tokens` includes `cached_input_tokens`, so uncached input is input minus cached.

## Claude Code

- Files: `~/.claude/projects/<project>/<session>.jsonl` and `<session>/subagents/agent-*.jsonl`. `CLAUDE_CONFIG_DIR`
  moves the folder. Other files in session folders are ignored.
- A reply is an assistant line with `message.usage`, keyed by `message.id` + `"|"` + `requestId` (a few lines have no
  `requestId`; their key ends in `|`).
- A reply's line repeats once per content block, and early copies can carry a partial `output_tokens`, so the largest
  of each count is kept.
- A resumed session copies earlier replies into its own file; the shared key counts them once.
- Sub-agent lines carry the parent's `sessionId`, so they roll up into it.
- `<synthetic>` and all-zero lines are not replies.
- `input_tokens` excludes cache reads (`cache_read_input_tokens`) and cache writes (`cache_creation_input_tokens`,
  split into `cache_creation.ephemeral_1h_input_tokens` and `ephemeral_5m_input_tokens`).
- Transcripts can pass 500 MB with single lines over 2 MB, so files are read in 4 MB chunks (`src/core/lines.js`) and
  lines without a marker are skipped before decoding.

### Claude allowance

Claude Code only shares the five-hour and weekly allowance with a `statusLine` command: its input has
`rate_limits.five_hour` and `rate_limits.seven_day` (`used_percentage`, `resets_at` in epoch seconds) for Pro, Max and
Ultra plans, after a session's first reply.

On Windows Claude Code runs the status line through Git Bash, or PowerShell when Git Bash is absent, so the command is
`node "<data>/statusline.cjs" --data "<data>"`: a bare first word with quoted forward-slash paths runs in both. Connect
copies the tap into the data folder because Node can't read inside the app's asar.

Connect (`src/core/claude-connect.js`) backs up `settings.json` next to itself, then changes only the `statusLine`
key. An earlier status line is remembered and run by the tap with the same input, so the person's own line still
shows. The record keeps SHA-256 fingerprints, never settings text. Disconnect restores the backup exactly when nothing
else changed; otherwise it undoes only its own change, or refuses if the status line was changed by hand.

The Claude desktop app's Code tab doesn't run status lines, and a Claude Code started inside the desktop app's
Terminal panel runs as a nested session that skips them too.

## Hermes

- File: `%LOCALAPPDATA%\hermes\state.db` (SQLite in WAL mode). The reader copies `state.db` and `state.db-wal` to a
  temporary folder and reads the copy, so Hermes is never locked or changed.
- Table `session_model_usage` keeps running totals per session, model, billing provider, base URL, billing mode and
  task (Hermes' own title generation is a separate task row), so rows are added up per session, model, provider and
  mode.
- `first_seen`, `last_seen` and `sessions.started_at` are epoch seconds with a fraction.
- `input_tokens` excludes cache reads.
- A cost of 0 means not priced, so Hermes' own cost is used only when positive; otherwise the model's API price is used.
- Hermes has no allowance of its own. The `openai-codex` provider with `subscription_included` billing draws on the
  same Codex weekly allowance.

## Prices

`src/core/prices.js` lists USD per million tokens from each provider's own published API price page, with the pages
and the date read in `PRICE_SOURCES`. A model without a published price shows its tokens and "no price on file",
never a guess.
