/**
 * 构建：src/** → lib/**（纯 JS 项目，不依赖 TypeScript 编译器）。
 *
 * 为什么拷贝而不是转译：本插件的 src 已经是可直接运行的 ESM JS，
 * 少一层工具链就少一种「装上但不生效」的失败模式。
 * 唯一特殊的是 src/ui/client.js —— 它必须同时出现在 lib/client.js
 * （package.json exports["./client"] 指这里）。
 */
import { readdir, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const srcDir = join(root, 'src')
const outDir = join(root, 'lib')

async function ensureDir(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (existsSync(dir)) return
    try {
      await mkdir(dir, { recursive: true })
      return
    } catch (error) {
      if (error?.code === 'EEXIST' || existsSync(dir)) return
      if (error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'ENOENT') {
        await new Promise((resolve) => setTimeout(resolve, 60))
        continue
      }
      throw error
    }
  }
  if (!existsSync(dir)) throw new Error(`无法创建目录：${dir}（权限被拒，可能是沙箱/杀软瞬时锁）`)
}

async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else out.push(full)
  }
  return out
}

async function main() {
  if (!existsSync(srcDir)) throw new Error(`缺少 src：${srcDir}`)
  await ensureDir(outDir)
  let copied = 0
  for (const file of await walk(srcDir)) {
    if (!file.endsWith('.js')) continue
    const rel = relative(srcDir, file)
    const target = join(outDir, rel)
    await ensureDir(dirname(target))
    await copyFile(file, target)
    copied += 1
    if (rel.endsWith('ui/client.js') || rel === join('ui', 'client.js')) {
      await copyFile(file, join(outDir, 'client.js'))
      copied += 1
    }
  }
  console.log(`[dsh-context-bridge] build 完成：${copied} 个文件 → lib/`)
}

await main()
