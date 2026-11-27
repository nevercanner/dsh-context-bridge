/**
 * 旧上下文归档 —— 交接完成后把源会话的**完整**上下文落盘成一份 JSON。
 *
 * 为什么必须落盘而不只留在内存里：
 *   交接后源会话要从活跃列表里消失（workspaceRegistry.archiveSession），
 *   宿主也不会再把它的内存状态保留成「可续跑」的东西。用户要回看/恢复
 *   「交接前到底发生了什么」，唯一可靠的载体就是这份文件 —— 它自带
 *   system/message（系统提示）、user/assistant 历史、tool/result 原始事件。
 *
 * 文件形状（验收要求的三字段在前）：
 *   {
 *     "session_id": "...",
 *     "archive_time": "2026-11-27T00:00:00.000Z",
 *     "context_snapshot": { ...完整快照... }
 *   }
 *
 * 写盘规则：
 *   · 目录默认 `<项目>/.dsh-archive/`，可用配置 archiveDir 改；
 *   · tmp + rename 原子写：中途失败不会留下半个 JSON（半个 JSON 比没有更坏，
 *     它会让「按归档恢复」在解析阶段炸掉）；
 *   · **任何写盘失败都抛出去** —— 调用方据此中止交接（不建新会话、不注册总线）。
 */

import { existsSync, statSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

/** 归档目录默认值（相对项目根）。 */
export const DEFAULT_ARCHIVE_DIR = '.dsh-archive'

/** 归档文件格式标识，便于以后加字段而不破坏读取方。 */
export const ARCHIVE_SCHEMA = 'dsh-context-archive/1'

/** 把配置里的 archiveDir 解析成绝对目录；空/非法值退回默认。 */
export function archiveDirFor(projectRoot, archiveDir) {
  const raw = typeof archiveDir === 'string' ? archiveDir.trim().replace(/\\/g, '/') : ''
  const relative = raw === '' || raw === '.' ? DEFAULT_ARCHIVE_DIR : raw
  const trimmed = relative.replace(/\/+$/, '')
  if (isAbsolute(trimmed)) return trimmed
  return join(String(projectRoot).replace(/\\/g, '/'), trimmed)
}

/** 归档文件名：`<session>-<ISO 时间戳>.json`（冒号/点在 Windows 上是非法字符，替换掉）。 */
export function archiveFileFor(dirPath, sessionId, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const safe = String(sessionId ?? 'session').replace(/[^A-Za-z0-9._-]/g, '_')
  return join(dirPath, `${safe}-${stamp}.json`)
}

/**
 * 组装归档内容（纯函数，便于测试）。
 *
 * @param {object} input
 * @param {string} input.sessionId 源会话 id
 * @param {object} [input.context] 完整快照：{ session, inheritedEventCount, events }
 * @param {string} [input.title] 会话标题（有就带上，方便人肉检索）
 * @param {Date} [input.now] 注入时钟（测试用）
 */
export function archivePayload({ sessionId, context, title, now = new Date() }) {
  const snapshot = context !== null && typeof context === 'object' ? context : {}
  const events = Array.isArray(snapshot.events) ? snapshot.events : []
  return {
    session_id: String(sessionId ?? ''),
    archive_time: now.toISOString(),
    context_snapshot: {
      schema: ARCHIVE_SCHEMA,
      session: snapshot.session ?? null,
      inherited_event_count: typeof snapshot.inheritedEventCount === 'number' ? snapshot.inheritedEventCount : 0,
      event_count: events.length,
      events,
    },
    ...(typeof title === 'string' && title.trim() !== '' ? { title: title.trim() } : {}),
  }
}

/**
 * 写一份归档。失败即抛（调用方必须中止交接）。
 *
 * @param {object} input
 * @param {string} input.projectRoot 项目根（必须已存在）
 * @param {string} [input.archiveDir] 配置项 archiveDir
 * @param {string} input.sessionId 源会话 id
 * @param {object} [input.context] 完整快照
 * @param {string} [input.title] 会话标题
 * @param {Date} [input.now] 注入时钟
 * @returns {Promise<{file:string, dir:string, bytes:number, at:string, eventCount:number}>}
 */
export async function writeContextArchive(input) {
  const { projectRoot, archiveDir, sessionId, context, title, now } = input
  const root = String(projectRoot ?? '').trim()
  if (root === '') throw new Error('归档失败：缺少项目根')
  // 故意不 mkdir 项目根本身：写一个不存在的项目目录 = 把归档扔在不明位置，
  // 宁可报错也不要在错误的路径上悄悄制造目录。
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`归档失败：项目目录不存在：${root}`)
  }
  const dir = archiveDirFor(root, archiveDir)
  const file = archiveFileFor(dir, sessionId, now ?? new Date())
  const payload = archivePayload({ sessionId, context, title, now: now ?? new Date() })
  let text
  try {
    text = JSON.stringify(payload, null, 2) + '\n'
  } catch (error) {
    // 事件里混进不可序列化的东西（循环引用等）—— 明确报错，不写半截文件
    throw new Error(`归档失败：上下文无法序列化（${String(error)}）`)
  }
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await mkdir(dir, { recursive: true })
  await writeFile(temporary, text, 'utf8')
  try {
    await rename(temporary, file)
  } catch (error) {
    // rename 失败时至少把 tmp 清掉，别在归档目录里留垃圾
    try {
      const { unlink } = await import('node:fs/promises')
      await unlink(temporary)
    } catch {
      // 清理失败无所谓，主错误更重要
    }
    throw error
  }
  return {
    file,
    dir,
    bytes: Buffer.byteLength(text, 'utf8'),
    at: payload.archive_time,
    eventCount: payload.context_snapshot.event_count,
  }
}

/** 读一份归档（验收用：归档文件必须能被读回来）。 */
export async function readContextArchive(file) {
  const { readFile } = await import('node:fs/promises')
  const raw = await readFile(file, 'utf8')
  const parsed = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object') throw new Error(`归档文件不是对象：${file}`)
  for (const key of ['session_id', 'archive_time', 'context_snapshot']) {
    if (!(key in parsed)) throw new Error(`归档文件缺字段 ${key}：${file}`)
  }
  return parsed
}
