/**
 * 项目级配置 —— 与 dsh-session-send 同款：每个项目自己的 .dsh-bridge.json。
 *
 * **纯手动**：本插件没有任何按阈值自动触发。交接只在你于会话行菜单里点
 * 「上下文交接」时发生。原因：上下文快满时，第一件事应该是压缩；
 * 只有压缩多轮之后确实压不动了，交接才是最后一步 —— 那个判断只有人能做。
 *
 * 所以配置里不带任何自动触发参数：阈值、冷却、自动续接这类键在这里都不存在，
 * 因为手动模式下它们不该有。
 */

import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const CONFIG_FILE = '.dsh-bridge.json'

const DEFAULTS = {
  /**
   * 默认开启：没有配置文件 = 可用。
   *
   * 为什么改成默认开：插件是手动触发的（人点菜单才执行），自动触发已经删掉了，
   * 「没建文件就用不上」只会让新项目莫名其妙用不了。要关掉某个项目，
   * 显式写 {"enabled": false} —— 开关保留，但默认放行。
   */
  enabled: true,
  /** 交接文档里最多列几条待办。 */
  todoLimit: 12,
  /** 最近几轮放进交接文档。 */
  recentTurns: 3,
  /** 交接后是否自动把界面切到新会话（只是导航，不涉及任何后台触发）。 */
  openNewSession: true,
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

/** 把磁盘上的原始配置规范化；坏文件一律按默认（开启）处理，绝不因为配置错就让插件抛。 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    // 只有显式写 false 才关闭；没写、写坏、写别的都是开启。
    enabled: source.enabled !== false,
    todoLimit: pickNumber(source.todoLimit, DEFAULTS.todoLimit, 1, 50),
    recentTurns: pickNumber(source.recentTurns, DEFAULTS.recentTurns, 0, 10),
    openNewSession: source.openNewSession !== false,
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
  if (config.broken === true) return '配置文件无法解析，已按默认开启（手动触发）'
  if (config.present === false) return '已开启（默认，无配置文件）'
  return '已开启（手动触发）'
}

export const CONFIG_DEFAULTS = DEFAULTS
