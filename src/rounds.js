/**
 * 轮次计数与触发判定 —— 自动交接的「什么时候交接」全部集中在这里，纯函数。
 *
 * 为什么数 `turn/start` 的 turn 号而不是数消息：
 *   · 宿主 AgentLoop 在每一轮开始时 append `turn/start`（{turn: n}），一轮里可能有
 *     几十条 user/assistant/tool 事件；按消息数算会让「15 轮」变成 3 轮，提前跑掉。
 *   · turn 号是宿主自己递增的序号，取最大值即可，不需要自己维护计数器，
 *     崩溃/重放/日志压缩都不会数错。
 *
 * 兜底：老日志或测试夹具里可能只有 `user/message`（带 data.turn），此时退到
 * 「最大的 user/message turn 号」—— 仍然按轮而非按条计。
 */

/** 默认交接阈值（轮）。配置项 handoffRounds 的默认值也来自这里。 */
export const DEFAULT_HANDOFF_ROUNDS = 15

function turnNumberOf(event) {
  const raw = event?.data?.turn
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/**
 * 数一个会话已经跑过多少轮。
 *
 * @param {Array<object>} [events] 会话事件（升序；乱序也不影响，取最大值）
 * @returns {number} 轮次（无事件 = 0）
 */
export function countTurns(events) {
  const list = Array.isArray(events) ? events : []
  let fromTurns = 0
  let starts = 0
  let fromMessages = 0
  for (const event of list) {
    const type = event?.type
    if (type !== 'turn/start' && type !== 'turn/end') continue
    if (type === 'turn/start') starts += 1
    const turn = turnNumberOf(event)
    if (turn !== undefined && turn > fromTurns) fromTurns = turn
  }
  if (fromTurns > 0) return fromTurns
  if (starts > 0) return starts
  for (const event of list) {
    if (event?.type !== 'user/message') continue
    const turn = turnNumberOf(event)
    if (turn !== undefined && turn > fromMessages) fromMessages = turn
  }
  return fromMessages
}

/**
 * 是否该自动交接。
 *
 * 每次判断都用**刚刚读到的配置**（调用方不缓存），所以用户在会话中途改
 * `.dsh-bridge.json` 的 handoffRounds，下一轮就按新值判断，不需要重启。
 *
 * 语义是「**过了阈值就一直该交**」，不是「只在等于阈值那一轮交一次」。
 * 这条曾经写错过：早期实现把某次失败记进 lastAttempt 后，同一个会话在
 * 阈值轮之后每一轮都因为 `rounds !== 记录值` 而重新尝试，看起来像「每轮都试、
 * 但每轮都失败」；反过来一旦把「已尝试」当成终态，转轮次继续涨就再也不会
 * 触发第二次。正确做法是：判定只看 rounds >= threshold，防重试交给
 * auto-handoff 的「同一轮只尝试一次 + 失败后指数退避」。
 *
 * @param {object} input
 * @param {object} [input.config] 项目配置（readProjectConfig 的结果）
 * @param {number} input.rounds 当前轮次
 * @returns {boolean}
 */
export function shouldAutoHandoff({ config, rounds }) {
  if (config === undefined || config === null) return false
  if (config.enabled !== true) return false
  if (config.autoHandoff !== true) return false
  const threshold = Number(config.handoffRounds)
  if (!Number.isFinite(threshold) || threshold <= 0) return false
  const current = Number(rounds)
  // NaN / 负数一律视为「还早」，而不是交给 >= 的隐式转换去误判
  if (!Number.isFinite(current) || current <= 0) return false
  return current >= threshold
}
