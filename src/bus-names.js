/**
 * 会话总线注册名读/写。
 *
 * 为什么直接读/写"会话总线"的项目文件而不调它的服务：
 *   · 总线的注册名是「项目级事实」，存在 `<项目>/.dsh-bus/names.json`，
 *     形状固定（{ [sessionId]: { name, at } }）—— 总线自己的 dsh_bus_register
 *     工具最终也就是写这个文件（registry/names.js 的 writeName）；
 *   · 两个插件独立安装/卸载，直接读写文件不会因为对方没装或没暴露服务而失败；
 *   · 写入必须与总线同款原子写（tmp + rename），且只动本项目自己的文件；
 *     为避免误写，仅当目标 session 确实属于本 projectRoot 时写入。
 *
 * 新会话要「继承注册名」时，本插件按下面的规则给新会话起名并核验：
 *   1. 源会话有名字 → 新会话继承 `<名>-handoff` （第一次）、`<名>-handoff-2`（第二次）……
 *   2. 若该名字在名册里被别的会话占用，继续往后找空位，绝不覆盖
 *   3. 选中名字后调 writeName 写进名册 —— 与总线同一份文件、同一种写盘
 */

import { existsSync } from 'node:fs'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const BUS_DIR = '.dsh-bus'
export const NAMES_FILE = 'names.json'
export const SUFFIX = 'handoff'
export const MAX_NAME = 64

export function namesPathFor(projectRoot) {
  return join(projectRoot, BUS_DIR, NAMES_FILE)
}

/** 读名册；任何异常都当成「没有名册」。 */
export async function readNames(projectRoot) {
  const file = namesPathFor(projectRoot)
  if (!existsSync(file)) return {}
  try {
    const raw = await readFile(file, 'utf8')
    if (raw.trim() === '') return {}
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out = {}
    for (const [sessionId, entry] of Object.entries(parsed)) {
      if (typeof sessionId !== 'string' || sessionId.trim() === '') continue
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.name !== 'string' || entry.name.trim() === '') continue
      out[sessionId] = { name: entry.name.trim(), at: typeof entry.at === 'number' ? entry.at : 0 }
    }
    return out
  } catch {
    return {}
  }
}

export function nameOf(names, sessionId) {
  const entry = names[String(sessionId ?? '').trim()]
  if (entry === undefined) return undefined
  return entry.name.trim() === '' ? undefined : entry.name
}

/** 反转索引：名字 → 占用它的 session id 集合。 */
export function nameIndex(names) {
  const index = new Map()
  for (const [sessionId, entry] of Object.entries(names)) {
    const list = index.get(entry.name) ?? []
    list.push(sessionId)
    index.set(entry.name, list)
  }
  return index
}

/**
 * 为交接会话挑一个不冲突的名字。
 *
 * @param {object} input
 * @param {Map<string,string[]>} input.index 见 {@link nameIndex}
 * @param {string} [input.base] 源会话的注册名
 * @param {string} [input.sessionId] 新会话 id（用于判断「这个名字是不是已经是我的」）
 * @returns {string} 挑好的名字
 */
export function pickInheritedName({ index, base, sessionId }) {
  const stem = (() => {
    const raw = typeof base === 'string' ? base.trim() : ''
    if (raw === '') return SUFFIX
    return raw.length + SUFFIX.length + 1 > MAX_NAME ? raw.slice(0, MAX_NAME - SUFFIX.length - 1) : raw
  })()
  const first = stem === SUFFIX ? SUFFIX : `${stem}-${SUFFIX}`
  const candidate = (n) => (n === 1 ? first : `${first}-${n}`)
  for (let n = 1; n <= 200; n += 1) {
    const name = candidate(n).slice(0, MAX_NAME)
    const owners = index.get(name) ?? []
    if (owners.length === 0) return name
    if (sessionId !== undefined && owners.length === 1 && owners[0] === sessionId) return name
  }
  // 极端情况：200 个都占了，用时间戳兜底
  return `${first}-${Date.now().toString(36)}`.slice(0, MAX_NAME)
}

/**
 * 把某个 session 登记进项目名册（与总线 dsh_bus_register 同款写盘）。
 * 只写 `<projectRoot>/.dsh-bus/names.json`，原子写（tmp + rename），绝不覆盖别的会话。
 *
 * @param {string} projectRoot 项目根
 * @param {string} sessionId 要登记的会话 id
 * @param {string} name 新名字；空字符串 = 清除该会话的登记
 * @returns {Promise<Record<string, {name:string, at:number}>>} 写盘后的完整名册
 */
export async function writeName(projectRoot, sessionId, name) {
  const id = String(sessionId ?? '').trim()
  if (id === '') throw new Error('缺少 session id')
  const registry = await readNames(projectRoot)
  const trimmed = String(name ?? '').trim()
  if (trimmed === '') {
    delete registry[id]
  } else {
    registry[id] = { name: trimmed, at: Date.now() }
  }
  const file = namesPathFor(projectRoot)
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await mkdir(dirname(file), { recursive: true })
  await writeFile(temporary, JSON.stringify(registry, null, 2) + '\n', 'utf8')
  await rename(temporary, file)
  return registry
}
