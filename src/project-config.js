/**
 * 项目级配置 —— 与 dsh-session-send 同款：每个项目自己的 .dsh-bridge.json。
 *
 * 触发方式有两条，都在这里配：
 *   · **自动**（v0.2.0 起）：会话跑到 `handoffRounds` 轮（默认 15）就强制交接一次，
 *     交接完立刻把旧上下文归档、旧会话从活跃列表移除。
 *   · **手动**：会话行菜单 / 面板按钮随时可以交接。
 *   `autoHandoff: false` 可关掉自动那条，只留手动。
 *
 * 「下一轮就生效」：这些值**每次判断前都重新读盘**（见 index.js 的
 * installAutoHandoff），插件里没有任何缓存副本，所以会话中途改阈值不用重启。
 */

import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const CONFIG_FILE = '.dsh-bridge.json'

const DEFAULTS = {
  /**
   * 默认开启：没有配置文件 = 可用。
   */
  enabled: true,
  /** 交接文档里最多列几条待办。 */
  todoLimit: 12,
  /** 最近几轮放进交接文档。 */
  recentTurns: 3,
  /** 交接后是否自动把界面切到新会话（只是导航，不涉及别的副作用）。 */
  openNewSession: true,
  /** 自动交接：跑到 handoffRounds 轮就强制交接（默认开）。显式 false = 只留手动。 */
  autoHandoff: true,
  /** 自动交接阈值（轮）。默认 15 —— 用户要求的默认值；改它下一轮即生效，无需重启。 */
  handoffRounds: 15,
  /** 旧上下文归档目录（相对项目根）。 */
  archiveDir: '.dsh-archive',
}

export function normalizeRoot(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') throw new Error('缺少项目根目录')
  const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalized === '') throw new Error('项目根目录不合法')
  if (!existsSync(normalized)) throw new Error(`项目目录不存在：${normalized}`)
  if (!statSync(normalized).isDirectory()) throw new Error(`不是目录：${normalized}`)
  return normalized
}

export function configPathFor(projectRoot) {
  return join(projectRoot, CONFIG_FILE)
}

function pickNumber(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.floor(value)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

/** 归档目录：只接受非空字符串；空/非法一律回默认。 */
function pickPath(value) {
  const raw = typeof value === 'string' ? value.trim().replace(/\\/g, '/').replace(/\/+$/, '') : ''
  if (raw === '' || raw === '.') return DEFAULTS.archiveDir
  return raw
}

/** 把磁盘上的原始配置规范化；坏文件一律按默认（开启）处理，绝不因为配置错就让插件抛。 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    // 只有显式写 false 才关闭；没写、写坏、写别的都是开启。
    enabled: source.enabled !== false,
    todoLimit: pickNumber(source.todoLimit, DEFAULTS.todoLimit, 1, 50),
    recentTurns: pickNumber(source.recentTurns, DEFAULTS.recentTurns, 0, 10),
    openNewSession: source.openNewSession !== false,
    // 自动交接默认开；显式 false 只留手动。
    autoHandoff: source.autoHandoff !== false,
    // 1~500 轮之间夹紧：0 或负数会让「每轮都交接」，那等于把会话撕碎。
    handoffRounds: pickNumber(source.handoffRounds, DEFAULTS.handoffRounds, 1, 500),
    archiveDir: pickPath(source.archiveDir),
  }
}

/** 读一个项目的配置；文件缺失或损坏都返回默认（开启）。 */
export async function readProjectConfig(projectRoot) {
  const file = configPathFor(projectRoot)
  if (!existsSync(file)) return { ...DEFAULTS, path: file, present: false }
  try {
    const raw = await readFile(file, 'utf8')
    if (raw.trim() === '') return { ...DEFAULTS, path: file, present: true }
    return { ...normalizeConfig(JSON.parse(raw)), path: file, present: true }
  } catch {
    return { ...DEFAULTS, path: file, present: true, broken: true }
  }
}

export function describeConfig(config) {
  if (config.enabled !== true) return '已关闭（本项目写了 enabled: false）'
  const rounds = Number(config.handoffRounds) > 0 ? Number(config.handoffRounds) : DEFAULTS.handoffRounds
  const auto = config.autoHandoff === true ? `自动交接：${rounds} 轮` : '仅手动触发'
  if (config.broken === true) return `配置文件无法解析，已按默认开启（${auto}）`
  if (config.present === false) return `已开启（默认：${rounds} 轮自动交接）`
  return `已开启（${auto}）`
}

export const CONFIG_DEFAULTS = DEFAULTS
