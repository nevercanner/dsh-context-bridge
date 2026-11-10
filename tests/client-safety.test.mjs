/**
 * Client 半的静态安全检查 —— 这是本插件最重要的一组测试。
 *
 * 2026-11-09 的真实事故：dsh-session-send 用 MutationObserver 扫所有
 * role="menu" 再往 React 容器里 appendChild，形成「插入 → 重渲染 → 再插入」
 * 的自激，打开模型选择菜单就把渲染进程主线程锁死（实测 1.2 秒 4,446 个
 * 异步任务、87 次强制布局、无任何 JS 异常、CDP 全超时）。
 *
 * 所以这里用测试把红线钉死：Client 半出现以下任一模式就失败。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'src', 'ui', 'client.js')

const FORBIDDEN = [
  ['MutationObserver', '禁止任何 MutationObserver：会与 React 渲染互相触发'],
  ['appendChild', '禁止 appendChild 到宿主容器：插行只能走 slots.register'],
  ['insertBefore', '禁止 insertBefore 到宿主容器'],
  ['getBoundingClientRect', '禁止在渲染期读布局尺寸'],
  ['offsetWidth', '禁止读 offsetWidth（强制同步布局）'],
  ['offsetHeight', '禁止读 offsetHeight（强制同步布局）'],
  ['setInterval', '禁止轮询：状态只在挂载时读一次'],
  ['requestAnimationFrame', '禁止自续帧循环'],
  ['selectorsForTests', '占位，永不出现在生产代码里'],
]

test('client 半不含任何会与 React 自激的 DOM 模式', async () => {
  const source = await readFile(clientPath, 'utf8')
  for (const [needle, why] of FORBIDDEN) {
    if (needle === 'selectorsForTests') continue
    assert.equal(source.includes(needle), false, `client.js 不得包含 ${needle}：${why}`)
  }
})

test('client 半只通过 slots 注册 UI', async () => {
  const source = await readFile(clientPath, 'utf8')
  assert.ok(source.includes("inject: ['slots']"), '必须声明 inject: [\'slots\']')
  assert.ok(source.includes('slots.register'), '必须用 slots.register 注册界面')
})

test('client 半的菜单行是 role=menuitem 的普通 button', async () => {
  const source = await readFile(clientPath, 'utf8')
  assert.ok(source.includes("role: 'menuitem'"), '菜单行应声明 role=menuitem')
})

test('client 半用 __ModuleLoader__ 形态加载', async () => {
  const source = await readFile(clientPath, 'utf8')
  // 文件头顶有注释，所以比较「去掉注释后的第一行可执行代码」
  const code = source.replace(/^\/\*[\s\S]*?\*\/\s*/, '')
  assert.ok(code.startsWith('window.__ModuleLoader__.load('), '必须是单文件模块加载形态')
  assert.ok(source.includes("id: 'dsh-context-bridge'"), '模块 id 必须是插件名')
})

test('manifest 同时声明 dsh.bundle 与 dsh.client', async () => {
  const pkg = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'))
  assert.ok(pkg.dsh?.bundle?.patch, '缺少 dsh.bundle.patch —— 只声明 client 的插件装不上')
  assert.ok(pkg.dsh?.client?.platform === 'web', '缺少 dsh.client.platform')
  assert.ok(pkg.exports?.['./client'], '缺少 exports["./client"]')
  assert.equal(pkg.name, 'dsh-context-bridge')
})
