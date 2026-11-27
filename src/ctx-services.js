/**
 * 从宿主 ctx 上取服务的小工具。
 *
 * 为什么不用静态 import：本插件以 `link:` 本地包安装，宿主加载器解析
 * `@deepseek-ai/*` 的范围与插件自身不同；静态 import 会在某些 profile 下
 * 直接 import 失败，整个 entry 变 `failed`（dsh-session-send 在 2026-11-08 踩过）。
 *
 * 为什么先 ctx.get 再属性兜底：未声明 inject 时裸读 `ctx.xxx` 会被 Cordis 抛
 * （访问未注入的服务），而 `ctx.get(name)` 只会返回 undefined —— 两条都试，
 * 才能同时兼容「声明了 inject」与「纯兜底读取」两种宿主形态。
 */

export function resolve(ctx, name) {
  try {
    const viaGet = typeof ctx?.get === 'function' ? ctx.get(name) : undefined
    if (viaGet !== undefined) return viaGet
  } catch {
    // ctx.get 在个别宿主上会抛，继续走属性兜底
  }
  try {
    return ctx?.[name]
  } catch {
    return undefined
  }
}
