/**
 * dsh-wb-desk host 半。
 *
 * 挂载点（需求文档第 6 节，2026-11-18 已对宿主 0.2.2-rc.3 源码验证）：
 * - `tools/pre-execute`（waterfall）：写入分级裁决——库内修改转待确认，其余放行
 * - `tools/post-execute`：库外产出归位副本到 inbox/
 *
 * 启动即初始化库目录（原地收编，不覆盖已有内容）。
 */
import { initLibrary } from './store.js'
import { preExecute, postExecute, isFailure } from './interceptor.js'
import { registerRoutes } from './routes.js'
import { runMaintenance } from './maintenance.js'

/** cordis 插件身份；inject 声明依赖 tools 服务，缺失时插件不挂载。 */
export const name = 'dsh-wb-desk'
export const inject = ['tools']

/** 宿主注入的 context（宽松类型：不引入宿主包即可编译）。 */
interface HostContext {
  on(event: string, listener: (...args: any[]) => Promise<unknown>): unknown
  /** cordis 的依赖注入：webServer 存在时挂 HTTP 路由。 */
  inject?(deps: readonly string[], fn: (webCtx: any) => void): unknown
  /** cordis 的生命周期清理钩子：插件卸载时回收定时器。 */
  effect?(fn: () => (() => void) | void): unknown
}

interface PreToolDecision {
  kind: 'allow' | 'deny' | 'cancel' | 'ask'
  reason?: string
}

/** 定期维护间隔：回收站过期条目与 pin 快照。 */
const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000

export async function apply(ctx: HostContext): Promise<void> {
  await initLibrary()

  // 启动即清一次过期回收站条目 / pin；之后每 6 小时一次
  void runMaintenance().catch(() => {})
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const timer = setInterval(() => { void runMaintenance().catch(() => {}) }, MAINTENANCE_INTERVAL_MS)
      ;(timer as { unref?: () => void }).unref?.()
      return () => clearInterval(timer)
    })
  }

  // webServer 存在时挂资料库数据路由（headless 组合不受影响）
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => registerRoutes(webCtx))
  }

  // pre：分级写入裁决。deny 携带说明性 reason，Agent 与用户都能看懂发生了什么。
  ctx.on('tools/pre-execute', async (exec: { name: string; arguments: unknown }, next: () => Promise<PreToolDecision>) => {
    const decision = await preExecute(exec)
    if (decision.kind === 'deny') {
      return { kind: 'deny', reason: decision.reason }
    }
    return next()
  })

  // post：库外产出归位。失败结果直接接受，不做归位。
  ctx.on('tools/post-execute', async (
    exec: { name: string; arguments: unknown },
    result: unknown,
    next: () => Promise<unknown>,
  ) => {
    const accepted = await next()
    try {
      await postExecute(exec, isFailure(result))
    } catch {
      // 归位失败绝不影响原工具结果
    }
    return accepted
  })
}
