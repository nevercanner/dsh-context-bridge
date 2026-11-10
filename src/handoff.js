/**
 * 交接文档构建 —— 纯函数，无宿主依赖，可单独测试。
 *
 * 输入是已经收集好的「事实」：
 *   · 项目根、当前会话标题
 *   · 未完成/进行中的待办（来自 todo/write 事件）
 *   · 上下文摘要（优先取宿主 compaction 的 summary，取不到就用轨迹提炼）
 *   · 最近若干轮的「用户要什么 / 助手做了什么」
 *   · 会话总线注册名（若有）
 *
 * 输出是一份 Markdown。设计目标：**新会话第一屏就有用**，而不是一大段复述。
 * 所以只保留三类信息：现在在哪、下一步做什么、别踩什么坑。
 */

const SECTION = {
  goal: '## 现在要做什么',
  state: '## 已经做到哪',
  todo: '## 下一步',
  facts: '## 项目事实',
  avoid: '## 注意',
}

function clip(text, limit) {
  const value = String(text ?? '').replace(/\r/g, '').trim()
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 1))}…`
}

function oneLine(text) {
  return String(text ?? '')
    .replace(/\r/g, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** 从 todo/write 事件的 data 里读待办（宿主形状：{ todos: [{content,status}] }）。 */
export function todosFromEvents(events) {
  let latest
  for (const row of events) {
    if (row?.type !== 'todo/write') continue
    const list = row.data?.todos
    if (Array.isArray(list)) latest = list
  }
  if (latest === undefined) return []
  return latest
    .filter((item) => item && typeof item.content === 'string')
    .map((item) => ({
      content: oneLine(item.content),
      status: ['completed', 'in_progress', 'pending'].includes(item.status) ? item.status : 'pending',
    }))
}

/** 取最后一条上下文摘要（compaction/summary 的 summary 是一个 content 数组）。 */
export function latestCompactionSummary(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const row = events[i]
    if (row?.type !== 'compaction/summary') continue
    const blocks = row.data?.summary
    if (!Array.isArray(blocks)) continue
    const text = blocks
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text !== '') return text
  }
  return undefined
}

/** 把一段摘要压成「目的 / 结论」两行，避免整段塞进交接文档。 */
export function digestSummary(summary, limit = 1200) {
  if (typeof summary !== 'string' || summary.trim() === '') return []
  const lines = summary
    .split('\n')
    .map((line) => oneLine(line.replace(/^[-*#>\s]+/, '')))
    .filter((line) => line !== '')
  if (lines.length === 0) return []
  const out = []
  let used = 0
  for (const line of lines) {
    if (used > limit) break
    out.push(line)
    used += line.length
  }
  return out
}

/**
 * 最近几轮的关键动作：每个 turn 取用户第一条文本 + 助手最后一条有内容的文本。
 * 只保留最后 `turns` 轮，防止交接文档自己变成大会话。
 */
export function recentTurns(events, turns = 3) {
  const byTurn = new Map()
  for (const row of events) {
    const turn = row?.data?.turn
    if (typeof turn !== 'number') continue
    if (row.type === 'user/message') {
      const message = row.data?.message ?? row.data
      const text = textOf(message)
      if (text !== '' && !byTurn.has(turn)) byTurn.set(turn, { turn, ask: oneLine(text), did: '' })
      else if (text !== '') {
        const slot = byTurn.get(turn)
        if (slot.ask === '') slot.ask = oneLine(text)
      }
    } else if (row.type === 'assistant/message') {
      const text = textOf(row.data?.message)
      if (text === '') continue
      const slot = byTurn.get(turn) ?? { turn, ask: '', did: '' }
      slot.did = oneLine(text)
      byTurn.set(turn, slot)
    }
  }
  return [...byTurn.values()]
    .sort((left, right) => left.turn - right.turn)
    .slice(-turns)
}

function textOf(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * 生成交接文档。
 *
 * @param {object} input
 * @param {string} input.projectRoot 项目根（只用于标题，不读盘）
 * @param {string} [input.title] 源会话标题
 * @param {string} [input.sourceSessionId] 源会话 id
 * @param {string} [input.busName] 会话总线注册名
 * @param {Array} input.todos 见 {@link todosFromEvents}
 * @param {string[]} input.summaryLines 见 {@link digestSummary}
 * @param {Array} input.recent 见 {@link recentTurns}
 * @param {number} [input.todoLimit] 最多列出几条待办
 * @returns {string}
 */
export function buildHandoff(input) {
  const {
    projectRoot = '',
    title = '',
    sourceSessionId = '',
    busName = '',
    todos = [],
    summaryLines = [],
    recent = [],
    todoLimit = 12,
  } = input ?? {}

  const name = String(projectRoot).split(/[\\/]/).filter(Boolean).pop() ?? ''
  const lines = []

  lines.push(`# 交接文档${name === '' ? '' : `：${name}`}`)
  lines.push('')
  const origin = []
  if (title !== '') origin.push(`来自会话「${clip(oneLine(title), 60)}」`)
  if (sourceSessionId !== '') origin.push(`\`${sourceSessionId}\``)
  if (busName !== '') origin.push(`总线名 \`${busName}\``)
  if (origin.length > 0) {
    lines.push(`> ${origin.join(' · ')}`)
    lines.push('')
  }

  const pending = todos.filter((item) => item.status !== 'completed')
  const done = todos.filter((item) => item.status === 'completed')

  lines.push(SECTION.goal)
  lines.push('')
  const inProgress = pending.find((item) => item.status === 'in_progress')
  const head = recent.length > 0 ? recent[recent.length - 1] : undefined
  if (inProgress !== undefined) lines.push(`- 正在做：${clip(inProgress.content, 200)}`)
  else if (head !== undefined && head.ask !== '') lines.push(`- 上一轮的要求：${clip(head.ask, 200)}`)
  else lines.push('- （源会话没有留下明确的当前任务，请看下面的项目事实）')
  if (head !== undefined && head.did !== '') lines.push(`- 上一轮的结论：${clip(head.did, 300)}`)
  lines.push('')

  lines.push(SECTION.state)
  lines.push('')
  if (done.length > 0) lines.push(`- 已完成 ${done.length} 项：${clip(done.slice(-5).map((item) => item.content).join('；'), 400)}`)
  if (summaryLines.length > 0) {
    for (const line of summaryLines.slice(0, 8)) lines.push(`- ${clip(line, 220)}`)
  } else if (done.length === 0) {
    lines.push('- （没有可提炼的摘要，建议先读一遍项目里的 README / 变更记录）')
  }
  lines.push('')

  lines.push(SECTION.todo)
  lines.push('')
  if (pending.length === 0) {
    lines.push('- （源会话的待办已全部完成；请按上一轮的结论继续，或向用户确认下一步）')
  } else {
    for (const item of pending.slice(0, todoLimit)) {
      lines.push(`- [${item.status === 'in_progress' ? '进行中' : '待办'}] ${clip(item.content, 200)}`)
    }
    if (pending.length > todoLimit) lines.push(`- ……另有 ${pending.length - todoLimit} 项，见源会话 todo 面板`)
  }
  lines.push('')

  lines.push(SECTION.facts)
  lines.push('')
  lines.push(`- 工作目录：\`${clip(projectRoot, 260)}\``)
  if (recent.length > 0) {
    lines.push('- 最近几轮：')
    for (const slot of recent) {
      const ask = slot.ask === '' ? '（无明确要求）' : clip(slot.ask, 120)
      const did = slot.did === '' ? '' : ` → ${clip(slot.did, 140)}`
      lines.push(`  - 第 ${slot.turn} 轮：${ask}${did}`)
    }
  }
  lines.push('')

  lines.push(SECTION.avoid)
  lines.push('')
  lines.push('- 这是**自动生成的交接文档**，不是完整对话；细节以源会话和仓库现状为准。')
  lines.push('- 动手前先确认仓库当前状态（`git status` / 测试），不要假设本文件写完就没变化。')
  lines.push('- 本文件由 dsh-context-bridge 生成，不需要回写给用户。')

  return `${lines.join('\n')}\n`
}
