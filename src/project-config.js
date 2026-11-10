/**
 * 项目级配置 —— 与 dsh-session-send 同款：每个项目自己的 .dsh-bridge.json。
 *
 * 默认关闭。开关只有三档语义：
 *   · 文件不存在 / enabled !== true  → 不工作，侧栏入口只显示「未开启」
 *   · enabled === true               → 打开后，在满足条件时生成交接文档并开新会话
 *   · autoContinue === false         → 只生成文档，不自动开新会话（让人自己决定）
 */

import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const CONFIG_FILE = '.dsh-bridge.json'

const DEFAULTS = {
  enabled: false,
  autoContinue: true,
  /** 触发阈值：上下文到达这个 token 数就在**回合结束时**做交接。 */
  thresholdTokens: 262144,
  /** 交接文档里最多列几条待办。 */
  todoLimit: 12,
  /** 最近几轮放进交接文档。 */
  recentTurns: 3,
  /** 同一会话两次自动交接的最小间隔（毫秒），防止连发。 */
  minIntervalMs: 600000,
}

export function normalizeRoot(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') throw new Error('缺少项目根目录')
  let normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '')
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

/** 把磁盘上的原始配置规范化；坏文件一律按「关闭」处理，绝不因为配置错就让插件抛。 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    enabled: source.enabled === true,
    autoContinue: source.autoContinue !== false,
    thresholdTokens: pickNumber(source.thresholdTokens, DEFAULTS.thresholdTokens, 8192, 10000000),
    todoLimit: pickNumber(source.todoLimit, DEFAULTS.todoLimit, 1, 50),
    recentTurns: pickNumber(source.recentTurns, DEFAULTS.recentTurns, 0, 10),
    minIntervalMs: pickNumber(source.minIntervalMs, DEFAULTS.minIntervalMs, 0, 86400000),
  }
}

/** 读一个项目的配置；文件缺失或损坏都返回默认（关闭）。 */
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
  if (config.present === false) return '未配置（文件不存在 = 关闭）'
  if (config.broken === true) return '配置文件无法解析，按关闭处理'
  if (config.enabled !== true) return '已关闭'
  return '已开启'
}

export const CONFIG_DEFAULTS = DEFAULTS
