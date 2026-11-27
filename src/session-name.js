/**
 * 「侧边栏里手动命名的会话名」—— 交接后注册到会话总线时用的那个名字。
 *
 * 字段到底叫什么（这一条是扫宿主源码确认的，不是猜的）：
 *   · 侧边栏渲染会话行用的是 **`session.title`**：
 *     `@deepseek-ai/dsh-client-ui-workspace/lib/client.js:999`
 *     `return session.blank ? "" : session.title?.trim() ?? ""`
 *     （`:1803` 同样是 `node.title || t("session.untitled")`）。宿主里**没有**
 *     `displayName` / `customName` 这两个字段 —— 用户示例里的 `session.displayName`
 *     只是示意，真实字段是 `title`。
 *   · 手动改名走 `@deepseek-ai/dsh-session-title` 的 `rename(session, title)`，
 *     它 append 一条 `session/title` 事件，`source: { kind: 'user' }`。
 *     自动生成的标题（provider 生成 / fallback 截断）source.kind 分别是
 *     `provider` / `fallback`。
 *
 * 所以「用户手动命名过」的判定只有一条可靠依据：**取最新 title 快照，看
 * source.kind === 'user'**。只有这种情况才把它当总线注册名；自动标题不算
 * （否则每个会话都会拿到一个随机的、用户根本不知道的名字去注册总线）。
 *
 * 读取顺序：
 *   1. `sessionQuery.readTitleSnapshot(sessionId)` —— 活会话/历史会话都能读，
 *      从日志 fold，最准（会话不在本进程激活时也只有它能用）；
 *   2. `sessionTitle.get(session)` —— 活会话上的同源快照（宿主没有 `current`，
 *      历史版本里这里写错成 `current` 拿不到任何东西，v0.2.0 修）；
 *   3. 都没有 → undefined（调用方回退成 session id / UUID）。
 */

import { resolve } from './ctx-services.js'

/** title 快照里取「名字 + 来源」；宿主两种形态（字符串 / 快照对象）都吃。 */
function titleOf(value) {
  if (typeof value === 'string') return { title: value.trim(), kind: undefined }
  if (value === null || typeof value !== 'object') return undefined
  const title = typeof value.title === 'string' ? value.title.trim() : ''
  const kind = value.source !== null && typeof value.source === 'object' ? value.source.kind : undefined
  return { title, kind: typeof kind === 'string' ? kind : undefined }
}

/**
 * 这个 title 快照是不是「用户手动命名」。
 * @param {unknown} value 快照对象或字符串
 * @returns {boolean}
 */
export function isManualTitle(value) {
  const parsed = titleOf(value)
  if (parsed === undefined || parsed.title === '') return false
  return parsed.kind === 'user'
}

/** 任意来源的标题文本（不要求是手动命名）。 */
export function titleTextOf(value) {
  const parsed = titleOf(value)
  return parsed === undefined || parsed.title === '' ? undefined : parsed.title
}

/**
 * 读侧边栏手动命名的会话名。没有手动命名时返回 undefined（调用方回退 UUID）。
 *
 * @param {object} ctx 宿主 context
 * @param {object} input
 * @param {string} input.sessionId 会话 id
 * @param {object} [input.agent] 活会话的 agent（能拿到 session 就走 sessionTitle.get）
 * @returns {Promise<string|undefined>}
 */
export async function readManualSessionName(ctx, { sessionId, agent }) {
  const id = String(sessionId ?? '').trim()
  if (id !== '') {
    try {
      const query = resolve(ctx, 'sessionQuery')
      if (query !== undefined && typeof query.readTitleSnapshot === 'function') {
        const snapshot = await query.readTitleSnapshot(id)
        if (isManualTitle(snapshot?.title)) return titleOf(snapshot.title).title
      }
    } catch {
      // 读不到就继续退；读标题失败不该阻断交接
    }
  }
  try {
    const titles = resolve(ctx, 'sessionTitle')
    const session = agent?.session
    if (session !== undefined && typeof titles?.get === 'function') {
      const snapshot = titles.get(session)
      if (isManualTitle(snapshot)) return titleOf(snapshot).title
    }
  } catch {
    // 同上
  }
  return undefined
}
