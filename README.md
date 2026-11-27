**English** · [简体中文](./README.zh.md)

# dsh-context-bridge

**Automatic** session handoff for DSH. When a session reaches **15 turns**
(`handoffRounds`, configurable), the plugin hands off on that turn's `turn/end`:
the old session's **complete context** (system prompt, user/assistant history,
tool results) is serialised into an archive JSON, a compact handoff document —
current goal, what is done, what is next, project facts — is delivered to a new
session, that session is registered on the session bus under **the name shown in
the sidebar**, and the old session is archived out of the active list. Manual
triggering (menu row / panel button) still works.

**Why rounds and not tokens**: token counts swing wildly with tool output, so one
threshold means very different amounts of work in two sessions; the turn number is
a sequence the host maintains itself (`turn/start`), stable and reproducible, and
the plugin needs no counter state of its own.

**Live threshold**: the config is re-read before every decision, with no caching,
so changing `handoffRounds` from 15 to 20 mid-session takes effect on the next
turn — no restart.

Default **on**: no config file means 15 rounds and `.dsh-archive`. To disable
automatic handoff in a project write `{"autoHandoff": false}`; to disable the
plugin entirely write `{"enabled": false}`.

---

## When it triggers

| Path | Trigger | Notes |
|---|---|---|
| Automatic | `turn/end` on `session/event`, current round ≥ `handoffRounds` | Only after a turn **finishes** — never mid-turn, which would swallow the reply to the message you just sent. The log shows `handoff triggered at round 15` |
| Manual | **上下文交接：生成并续接** in the session `…` menu / **立即交接** in the panel | Human judgement still wins: click to hand off early |

Each round is attempted **at most once** per session. If archiving fails the whole
handoff aborts (no session, no bus registration, the old session keeps running)
and the same disk error is not retried on every later turn.

## What a handoff does

1. **Archive the old context** (first, and fatal on failure):
   `<project>/.dsh-archive/<session_id>-<timestamp>.json` with `session_id`,
   `archive_time`, `context_snapshot` (every raw event: system prompt,
   user/assistant history, tool results). Atomic tmp + rename, never a half JSON.
2. **Create the new session**: `agents.create({ sessionId, agentOptions, meta: { cwd, parentSession } })`
   with **no seed** (a `user/message` in the seed occupies the protected surface
   head and writes an unreadable log).
3. **Register on the bus** under the **manually named sidebar title**
   (`session/title` with `source.kind === 'user'`), removing the old session's
   entry first; with no manual name it falls back to the new session id (UUID).
4. **Deliver the handoff document** via `agent.followup()` so the session starts
   working.
5. **Hide the old session**: `workspaceRegistry.archiveSession()` (retried with
   `{ stopActivity: true }` when it is still active). It leaves the active list
   but stays recoverable from the archive file.

The failure branches for each step live in `runHandoff` (`src/handoff-host.js`);
the order is not interchangeable.

## What it produces

A Markdown document, deliberately short, that quotes raw text only in the archive
pointer line — details are delegated to the archive file:

| Section | Content | Source |
|---|---|---|
| header | source title/id, bus name, **archive file path**, scale (turns / events) | archive result |
| 现在要做什么 | the in-progress todo, else the **user's last request verbatim** | `todo/write` → `user/message` |
| 用户最近的原始要求 | last 3 user messages verbatim (600 chars each) | `user/message` |
| 已经做到哪 | completed todos + compaction summary + tool-call trail (name + command/path) | `todo/write` / `compaction/summary` / `tool/call` |
| 下一步 | remaining todos; when there are none it says so and points at the last request | `todo/write` |
| 项目事实 | working directory and the last turns (ask → result) | turns derived from `turn/start` |
| 注意 | sections may be empty, read the archive for the full text, check the repo first | — |

Generated from the source session's own event log (`sessionQuery`, read-only), not
from a model call: it costs no tokens and cannot invent facts it was not given.

### Why it used to come out empty (a real v0.2.0 defect)

Three structural causes, none of them related to archiving:

1. **User messages were dropped entirely.** The host's real event shape is
   `user/message → { content: [...] }` — **no `turn` field**; turns live on
   `turn/start` / `turn/end` / `assistant/message` / `tool/call`. The old extractor
   only accepted a message's own `data.turn`, so every user message was filtered
   out: in one real 8,900-event log, **169 user messages, 0 of them carrying
   `data.turn`** — `ask` was therefore always empty and the document said only
   "(the source session left no current task)".
2. **Todos were always empty.** They only come from `todo/write`, and this host has
   the `tool-todo` plugin disabled — the same log has 0 `todo/write` events.
3. **Summaries were mostly missing.** `compaction-basic` is often off too, so
   `compaction/summary` may never appear.

Since v0.3.0 turns are derived from `turn/start` (`turnMap`) and messages are
stamped with the turn they belong to; two materials that **always** exist are added
(verbatim requests, tool-call trail) plus the archive path in the header, so the new
session can `read` the archive for full text. Archiving alone never solved this:
the archive is write-only, and without that header line the new session does not
even know the file exists.

## How the new session is started

1. `agents.create({ sessionId, agentOptions, meta })` creates an **empty** session,
   persisted by the host.
2. The session is attached to the workspace (the host does not auto-attach sessions
   created through `agents.create`, and without it the sidebar project group never
   shows it).
3. The handoff document is then delivered through `agent.followup()` so the
   session starts working.

If the host has no `agents.create`, the run fails with an explicit message and
creates nothing (the old context is already archived; its path is in the detail).

## Bus name: the manual sidebar title, otherwise the UUID

The field is **`session.title`** — confirmed by reading the host source:
`@deepseek-ai/dsh-client-ui-workspace/lib/client.js:999` renders session rows from
`session.title?.trim()`; there is no `displayName` / `customName`. Renaming goes
through `sessionTitle.rename()`, which appends a `session/title` event with
`source: { kind: 'user' }`; generated titles are `provider` / `fallback`.

So the only reliable test for "the user named this" is
**`source.kind === 'user'` on the latest title snapshot**. Generated titles do not
count (otherwise every session would register a name the user never chose).

- Read path: `sessionQuery.readTitleSnapshot(sessionId)` (works for live and
  historical sessions) → `sessionTitle.get(session)` → fall back to the new
  session id (UUID);
- With a manual name: register `<name>` itself, dropping the old session's entry
  (name transfer);
- If another session holds that name: fall back to `<name>-2`, `-3`, … and never
  overwrite someone else's registration; names are clipped to 64 characters.

## Enabling it

```json
// <project>/.dsh-bridge.json
{
  "enabled": true,
  "autoHandoff": true,
  "handoffRounds": 15,
  "archiveDir": ".dsh-archive",
  "todoLimit": 12,
  "recentTurns": 3,
  "openNewSession": true
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | missing file counts as enabled; `false` stops both automatic and manual handoff |
| `autoHandoff` | `true` | `false` keeps manual triggering only |
| `handoffRounds` | `15` | hand off at this round (1–500); **re-read before every decision, so a change applies on the next turn** |
| `archiveDir` | `.dsh-archive` | archive directory, relative to the project root or absolute |
| `todoLimit` | `12` | todos listed in the document |
| `recentTurns` | `3` | turns summarised into the document |
| `openNewSession` | `true` | navigate the UI to the new session after it is created |

No restart is needed after a config change: the file is re-read before every
`turn/end` decision.

## UI

- The session `…` menu row and a sidebar panel icon; the panel shows project /
  switch / trigger mode / current round / archive dir / bus name.
- Both are registered through the official slot registry. The client half has
  **no DOM-mutation observer, no manual container manipulation, no layout
  measurement, no timers** — enforced by `tests/client-safety.test.mjs`, which
  fails if any of those reappear. (A sibling plugin's menu fallback once created
  an insert/re-render loop that locked the renderer main thread when the model
  menu opened; this plugin is shaped so that bug cannot be reproduced here.)

## Known limits

- The handoff covers what is **durable in the session log**. Work that only lives
  in your head is not in it.
- `agents.create` / `workspaceRegistry.archiveSession` are host APIs; on a host
  without them the plugin reports the reason instead of pretending to succeed
  (the archive file is still written).
- The new session inherits the cwd and the source session as `parentSession`, not
  the full parent history — that lives in the archive JSON.
- Automatic handoff swaps sessions at a turn boundary and makes no compaction
  judgement. To keep "compact first, hand off only if that stops helping", set
  `autoHandoff: false` and click when you decide.

## License

MIT
