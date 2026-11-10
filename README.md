**English** · [简体中文](./README.zh.md)

# dsh-context-bridge

Automatic handoff for DSH sessions. When a conversation approaches its context
window, this plugin writes a compact handoff document — current goal, what is
done, what is next, project facts — then **creates a new session and wakes it
with that document as its first turn**. The new session can inherit the session
bus name of the one it came from.

Default **off**. A project opts in by creating `.dsh-bridge.json` in its root.

---

## Why

A long session dies of context, not of work. Handing over by hand costs one more
conversation: you ask the old session to summarise itself, copy the answer, open
a new session, paste, re-explain the constraints. That is exactly the step this
plugin removes.

## What it produces

A Markdown document with four sections — deliberately short, because a handoff
that repeats the whole conversation would hit the same wall:

| Section | Content |
|---|---|
| 现在要做什么 | the in-progress todo, or the last turn's request and its conclusion |
| 已经做到哪 | completed todos plus the latest compaction summary, clipped |
| 下一步 | remaining todos, in order |
| 项目事实 | working directory and the last few turns (ask → result) |

It is generated from the source session's own event log
(`sessionQuery.observeSession`, read-only), not from a model call, so it costs no
tokens and cannot hallucinate facts it was not given.

## How the new session is started

1. The handoff event is built as a normal `user/message` (host rules only require
   an id, `role: "user"`, a non-empty `source.kind`, and an array `content`).
2. `agents.create({ sessionId, seed, inheritedEventCount, meta })` creates the
   session with that event as its own first event — the host persists it.
3. The same text is then delivered through `agent.followup()` so the new session
   actually starts working instead of sitting there holding a document.

If the host has no `agents.create`, the run fails with an explicit message and
creates nothing.

## Inheriting the session-bus name

If the source session is registered in `dsh-session-send`'s roster
(`.dsh-bus/names.json`), the new session is registered as `<name>-handoff`
(or `-handoff-2`, `-3`, … if taken). Rules:

- The roster is **read-only** for this plugin; writing goes through the bus's own
  registration entry when it exposes one.
- No collision is ever overwritten.
- Names are clipped to 64 characters.

## Enabling it

```json
// <project>/.dsh-bridge.json
{
  "enabled": true,
  "autoContinue": true,
  "thresholdTokens": 262144,
  "todoLimit": 12,
  "recentTurns": 3,
  "minIntervalMs": 600000
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | missing file or `false` = the plugin does nothing |
| `autoContinue` | `true` | `false` = generate only, do not open a session |
| `thresholdTokens` | `262144` | measured context that triggers a handoff |
| `todoLimit` | `12` | todos listed in the document |
| `recentTurns` | `3` | turns summarised into the document |
| `minIntervalMs` | `600000` | per-session cooldown against repeated handoffs |

The trigger is checked at `agent/turn-stopping`, never mid-turn: a half-finished
turn would be written down as a conclusion.

## UI

- A row inside the session `…` menu: **上下文交接：生成并续接** — runs a handoff now.
- A sidebar panel icon: shows project, switch state, threshold and bus name.

Both are registered through the official slot registry. The client half has **no
DOM-mutation observer, no manual container manipulation, no layout measurement,
no timers** — enforced by `tests/client-safety.test.mjs`, which fails the build if
any of those reappear. (A sibling plugin's menu-row fallback once created an
insert/re-render loop that locked the renderer main thread when the model menu
opened; this plugin is shaped so that bug cannot be reproduced here.)

## Known limits

- The handoff covers what is **durable in the session log**. Work that only lives
  in the user's head is not in it.
- `agents.create` is a host API; on a host that does not provide it, the plugin
  reports the reason instead of pretending to succeed.
- The new session inherits the cwd and the source session as `parentSession`,
  not the full parent history.

## License

MIT
