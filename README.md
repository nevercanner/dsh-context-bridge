**English** · [简体中文](./README.zh.md)

# dsh-context-bridge

**Manual** session handoff for DSH. When you decide a session has run out of
usable context, click one menu row: the plugin writes a compact handoff
document — current goal, what is done, what is next, project facts — creates a
new session seeded with it, and wakes that session so work continues. The new
session can inherit the session-bus name of the one it came from.

It is **not** automatic. There is no threshold, no timer, no listener on the
agent loop. This is deliberate: when context fills up the first move is to
compact, and only after several rounds of compaction stop helping is a handoff
the right last step. That judgement is yours, not a number's.

Default **off**. A project opts in by creating `.dsh-bridge.json` in its root.

---

## How it is triggered

One place only: the row **上下文交接：生成并续接** inside a session's `…` menu
(or the **立即交接** button in the sidebar panel). Nothing else in the plugin can
start a handoff.

## What it produces

A Markdown document with four sections — deliberately short, because a handoff
that repeats the whole conversation would hit the same wall:

| Section | Content |
|---|---|
| 现在要做什么 | the in-progress todo, or the last turn's request and its conclusion |
| 已经做到哪 | completed todos plus the latest compaction summary, clipped |
| 下一步 | remaining todos, in order |
| 项目事实 | working directory and the last few turns (ask → result) |

Generated from the source session's own event log (`sessionQuery.observeSession`,
read-only), not from a model call: it costs no tokens and cannot invent facts it
was not given.

## How the new session is started

1. The handoff event is built as a normal `user/message` (host rules only require
   an id, `role: "user"`, a non-empty `source.kind`, and an array `content`).
2. `agents.create({ sessionId, seed, inheritedEventCount, meta })` creates the
   session with that event as its first event — the host persists it.
3. The same text is then delivered through `agent.followup()` so the new session
   starts working instead of sitting there holding a document.

If the host has no `agents.create`, the run fails with an explicit message and
creates nothing.

## Inheriting the session-bus name

If the source session is registered in `dsh-session-send`'s roster
(`.dsh-bus/names.json`), the new session is registered as `<name>-handoff`
(or `-handoff-2`, `-3`, … if taken). The roster is read-only here; writing goes
through the bus's own registration entry when it exposes one. No existing name is
ever overwritten, and names are clipped to 64 characters.

## Enabling it

```json
// <project>/.dsh-bridge.json
{
  "enabled": true,
  "todoLimit": 12,
  "recentTurns": 3,
  "openNewSession": true
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | missing file or `false` = the menu row refuses to run and says how to enable it |
| `todoLimit` | `12` | todos listed in the document |
| `recentTurns` | `3` | turns summarised into the document |
| `openNewSession` | `true` | navigate the UI to the new session after it is created |

Turning the switch on does not make anything run by itself — it only decides
whether your click is allowed.

## UI

- The session `…` menu row and a sidebar panel icon.
- Both are registered through the official slot registry. The client half has
  **no DOM-mutation observer, no manual container manipulation, no layout
  measurement, no timers** — enforced by `tests/client-safety.test.mjs`, which
  fails if any of those reappear. (A sibling plugin's menu fallback once created
  an insert/re-render loop that locked the renderer main thread when the model
  menu opened; this plugin is shaped so that bug cannot be reproduced here.)

## Known limits

- The handoff covers what is **durable in the session log**. Work that only lives
  in your head is not in it.
- `agents.create` is a host API; on a host without it, the plugin reports the
  reason instead of pretending to succeed.
- The new session inherits the cwd and the source session as `parentSession`, not
  the full parent history.

## License

MIT
