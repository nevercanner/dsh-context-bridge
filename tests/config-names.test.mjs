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

test('normalizeConfig 默认关闭', () => {
  const config = normalizeConfig({})
  assert.equal(config.enabled, false)
  assert.equal(config.todoLimit, CONFIG_DEFAULTS.todoLimit)
  assert.equal(config.recentTurns, CONFIG_DEFAULTS.recentTurns)
})

test('配置里没有自动触发参数（纯手动）', () => {
  const config = normalizeConfig({ enabled: true, thresholdTokens: 1234, autoContinue: true, minIntervalMs: 5 })
  assert.equal('thresholdTokens' in config, false, '手动模式下不应有阈值参数')
  assert.equal('autoContinue' in config, false, '手动模式下不应有 autoContinue')
  assert.equal('minIntervalMs' in config, false, '手动模式下不应有冷却参数')
})

test('normalizeConfig 夹紧越界条数', () => {
  assert.equal(normalizeConfig({ todoLimit: 0 }).todoLimit, 1)
  assert.equal(normalizeConfig({ todoLimit: 999 }).todoLimit, 50)
  assert.equal(normalizeConfig({ recentTurns: 99 }).recentTurns, 10)
})

test('normalizeConfig 对垃圾输入不抛', () => {
  assert.equal(normalizeConfig(null).enabled, false)
  assert.equal(normalizeConfig([]).enabled, false)
  assert.equal(normalizeConfig('x').enabled, false)
})

test('readProjectConfig 文件不存在 = 关闭', async () => {
  const dir = await tempProject()
  try {
    const config = await readProjectConfig(dir)
    assert.equal(config.enabled, false)
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

test('readProjectConfig 坏 JSON 按关闭且不抛', async () => {
  const dir = await tempProject()
  try {
    await writeFile(join(dir, '.dsh-bridge.json'), '{ not json')
    const config = await readProjectConfig(dir)
    assert.equal(config.enabled, false)
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
