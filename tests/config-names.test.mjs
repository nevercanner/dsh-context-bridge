import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CONFIG_DEFAULTS, configPathFor, normalizeConfig, readProjectConfig } from '../src/project-config.js'
import { nameIndex, nameOf, namesPathFor, pickInheritedName, readNames } from '../src/bus-names.js'

async function tempProject() {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-'))
  return dir
}

test('normalizeConfig 默认开启（未配置即可用）', () => {
  const config = normalizeConfig({})
  assert.equal(config.enabled, true)
  assert.equal(config.todoLimit, CONFIG_DEFAULTS.todoLimit)
  assert.equal(config.recentTurns, CONFIG_DEFAULTS.recentTurns)
})

test('只有显式 false 才关闭', () => {
  assert.equal(normalizeConfig({ enabled: false }).enabled, false)
  assert.equal(normalizeConfig({ enabled: 'false' }).enabled, true)
  assert.equal(normalizeConfig({ enabled: 0 }).enabled, true)
  assert.equal(normalizeConfig({}).enabled, true)
})

test('自动交接的开关与阈值有默认值（15 轮），且不是「猜 token」式的参数', () => {
  const config = normalizeConfig({ enabled: true, thresholdTokens: 1234, minIntervalMs: 5 })
  assert.equal(config.autoHandoff, true, '默认开启自动交接')
  assert.equal(config.handoffRounds, 15, '默认 15 轮')
  assert.equal('thresholdTokens' in config, false, '按轮次触发，不按 token 猜')
  assert.equal('minIntervalMs' in config, false, '没有冷却计时器')
  const custom = normalizeConfig({ handoffRounds: 20, autoHandoff: false })
  assert.equal(custom.handoffRounds, 20)
  assert.equal(custom.autoHandoff, false)
})

test('handoffRounds 越界被夹紧、垃圾值退回 15', () => {
  assert.equal(normalizeConfig({ handoffRounds: 0 }).handoffRounds, 1)
  assert.equal(normalizeConfig({ handoffRounds: 9999 }).handoffRounds, 500)
  assert.equal(normalizeConfig({ handoffRounds: 'x' }).handoffRounds, 15)
  assert.equal(normalizeConfig({ handoffRounds: 7.6 }).handoffRounds, 7)
})

test('normalizeConfig 夹紧越界条数', () => {
  assert.equal(normalizeConfig({ todoLimit: 0 }).todoLimit, 1)
  assert.equal(normalizeConfig({ todoLimit: 999 }).todoLimit, 50)
  assert.equal(normalizeConfig({ recentTurns: 99 }).recentTurns, 10)
})

test('normalizeConfig 对垃圾输入不抛，且按默认开启', () => {
  assert.equal(normalizeConfig(null).enabled, true)
  assert.equal(normalizeConfig([]).enabled, true)
  assert.equal(normalizeConfig('x').enabled, true)
})

test('readProjectConfig 文件不存在 = 默认开启', async () => {
  const dir = await tempProject()
  try {
    const config = await readProjectConfig(dir)
    assert.equal(config.enabled, true)
    assert.equal(config.present, false)
    assert.equal(config.path, configPathFor(dir))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readProjectConfig 读到 enabled=true', async () => {
  const dir = await tempProject()
  try {
    await writeFile(join(dir, '.dsh-bridge.json'), JSON.stringify({ enabled: true, todoLimit: 99 }))
    const config = await readProjectConfig(dir)
    assert.equal(config.enabled, true)
    assert.equal(config.todoLimit, 50)
    assert.equal(config.present, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readProjectConfig 坏 JSON 按默认开启且不抛', async () => {
  const dir = await tempProject()
  try {
    await writeFile(join(dir, '.dsh-bridge.json'), '{ not json')
    const config = await readProjectConfig(dir)
    assert.equal(config.enabled, true)
    assert.equal(config.broken, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readNames 缺文件返回空对象', async () => {
  const dir = await tempProject()
  try {
    assert.deepEqual(await readNames(dir), {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readNames 读取并清洗总线名册', async () => {
  const dir = await tempProject()
  try {
    await mkdir(join(dir, '.dsh-bus'), { recursive: true })
    await writeFile(
      join(dir, '.dsh-bus', 'names.json'),
      JSON.stringify({
        'session-a': { name: '管线维护', at: 1 },
        'session-b': { name: '  ', at: 2 },
        'session-c': null,
      }),
    )
    const names = await readNames(dir)
    assert.deepEqual(Object.keys(names), ['session-a'])
    assert.equal(nameOf(names, 'session-a'), '管线维护')
    assert.equal(nameOf(names, 'session-b'), undefined)
    assert.equal(namesPathFor(dir), join(dir, '.dsh-bus', 'names.json'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('pickInheritedName 无源名字时用默认后缀', () => {
  assert.equal(pickInheritedName({ index: new Map() }), 'handoff')
})

test('pickInheritedName 继承源名字并加后缀', () => {
  assert.equal(pickInheritedName({ index: new Map(), base: '管线维护' }), '管线维护-handoff')
})

test('pickInheritedName 冲突时递增后缀', () => {
  const index = new Map([
    ['管线维护-handoff', ['session-1']],
    ['管线维护-handoff-2', ['session-2']],
  ])
  assert.equal(pickInheritedName({ index, base: '管线维护' }), '管线维护-handoff-3')
})

test('pickInheritedName 不把新会话自己算成冲突', () => {
  const index = new Map([['管线维护-handoff', ['session-new']]])
  assert.equal(pickInheritedName({ index, base: '管线维护', sessionId: 'session-new' }), '管线维护-handoff')
})

test('pickInheritedName 限制最大长度', () => {
  const long = 'x'.repeat(200)
  const name = pickInheritedName({ index: new Map(), base: long })
  assert.ok(name.length <= 64)
})

test('nameIndex 按名字分组', () => {
  const index = nameIndex({ a: { name: 'n', at: 0 }, b: { name: 'n', at: 0 }, c: { name: 'm', at: 0 } })
  assert.deepEqual(index.get('n').sort(), ['a', 'b'])
  assert.deepEqual(index.get('m'), ['c'])
})
