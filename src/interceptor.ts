/**
 * 分级写入拦截器（需求文档 3.1 / 第 6 节）。
 *
 * 挂载 `tools/pre-execute`（waterfall）与 `tools/post-execute`：
 * - 库内已有文件的修改 → deny + 记入持久化待确认队列；
 * - 库内新文件 → allow（直落盘，这就是"啊哈时刻"）；
 * - �外写入 → allow 原流程，post 阶段按规则归位一份副本到 inbox/。
 *
 * 拦截的是工具调用而非裸 fs 写入；Agent 用 Bash 落盘拦不到，
 * 缓解策略见需求文档第 9 节。
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { inLibrary, isInsideLibrary, LIBRARY_ROOT } from './store.js'
import { enqueue, extractContent } from './pending.js'
import { pinForRead } from './pins.js'
import { appendArtifact, sessionIdOf } from './artifacts.js'
import { scheduleAutoPush } from './cloud.js'
import { resolvePlacementDir } from './config.js'
import { resolveSessionMeta } from './sessionmeta.js'
import { pushFileNotice } from './notices.js'

/** 常见写入类工具名（宿主 write/edit/create_file 系；可按宿主实际注册名扩展）。 */
const WRITE_TOOLS = new Set(['write', 'edit', 'create_file', 'multi_edit', 'str_replace_based_edit_tool'])

/** 常见读取类工具名：pin 固定修订引用的触发点（需求文档 3.3）。 */
const READ_TOOLS = new Set(['read', 'read_file', 'view', 'cat', 'open'])

/** 从宽松的工具参数里提取目标文件路径。 */
function extractPath(args: Record<string, unknown>): string | undefined {
  for (const key of ['path', 'file_path', 'filePath', 'target', 'targetPath', 'filename']) {
    if (typeof args[key] === 'string' && (args[key] as string).length > 0) {
      return args[key] as string
    }
  }
  return undefined
}

/** pre-execute 的裁决：读取类做 pin，修改类写入拦截，其余放行。 */
export async function preExecute(exec: { name: string; arguments: unknown; agent?: unknown }): Promise<PreDecision> {
  const args = (exec.arguments ?? {}) as Record<string, unknown>
  const target = extractPath(args)
  if (!target) return { kind: 'allow' }

  // 读取类工具：固定修订引用（pin），pin 记下会话以便到期自动清理
  if (READ_TOOLS.has(exec.name)) {
    if (!isInsideLibrary(target)) return { kind: 'allow' }
    const rel = relative(LIBRARY_ROOT, target).replaceAll('\\', '/')
    const outcome = await pinForRead(target, rel, sessionIdOf(exec.agent))
    if (!outcome) return { kind: 'allow' } // 文件不存在等异常，交给原流程报错
    if (!outcome.drifted) return { kind: 'allow' }
    // 已漂移：Agent 拿到的是 pin 时刻版本 + 漂移提示，而非磁盘上的新内容
    const pinned = outcome.pin.content.length > 48 * 1024
      ? outcome.pin.content.slice(0, 48 * 1024) + '\n…（固定版本内容过长已截断，完整内容在 .dsh-library/pins/）'
      : outcome.pin.content
    return {
      kind: 'deny',
      reason:
        `「${rel}」在你引用之后已被修改。本次读取按固定修订引用返回 pin 时刻的版本：\n\n${pinned}\n\n` +
        '如需基于最新内容工作，请提示用户在资料库面板「固定引用」中释放该文件的 pin 后重新读取。',
    }
  }

  if (!WRITE_TOOLS.has(exec.name)) return { kind: 'allow' }

  // 只管库内；库外的写入先放行，post 阶段归位副本
  if (!isInsideLibrary(target)) return { kind: 'allow' }

  if (existsSync(target)) {
    // 修改已有文件：内容进持久化待确认队列，不直接落盘
    const { content, summary } = extractContent(args)
    const change = await enqueue({
      tool: exec.name,
      targetPath: target,
      summary: summary || `(工具 ${exec.name} 的待确认修改)`,
      content,
    })
    await appendArtifact({
      sessionId: sessionIdOf(exec.agent),
      tool: exec.name,
      libPath: target,
      kind: 'pending',
    })
    return {
      kind: 'deny',
      reason:
        `对资料库内已有文件的修改已进入待确认队列（id: ${change.id.slice(0, 8)}），` +
        '不会直接覆盖原文件。用户接受后内容将写入；如需立即写入请提示用户在资料库面板确认。',
    }
  }

  // 库内新文件：免确认直落——这是核心差异点（需求文档 3.1）
  return { kind: 'allow' }
}

/** post-execute 的裁决：库外成功写入的文件，复制一份按归位规则落库。 */
export async function postExecute(exec: { name: string; arguments: unknown; agent?: unknown }, failed: boolean): Promise<void> {
  if (failed || !WRITE_TOOLS.has(exec.name)) return
  const args = (exec.arguments ?? {}) as Record<string, unknown>
  const target = extractPath(args)
  if (!target || !existsSync(target)) return
  const sessionId = sessionIdOf(exec.agent)
  // 库内新建（已有文件的修改在 pre 阶段进了待确认，不会走到这里）：直接入库，弹气泡
  if (isInsideLibrary(target)) {
    const meta = await resolveSessionMeta(sessionId).catch(() => null)
    pushFileNotice({
      kind: 'saved',
      name: basename(target),
      libPath: relative(LIBRARY_ROOT, target).replaceAll('\\', '/'),
      sessionId,
      sessionTitle: meta?.title,
    })
    return
  }
  try {
    // 规则：会话前缀 → 工作区名 → 默认 inbox/（面板里可编辑，改完即时生效）
    // 源是目录（或无法 stat）时不归位——只搬文件
    const srcStat = await stat(target)
    if (!srcStat.isFile()) return
    const meta = await resolveSessionMeta(sessionId).catch(() => null)
    const dir = await resolvePlacementDir({ sessionId, wsName: meta?.wsName }).catch(() => 'inbox')
    const dest = await relocatedPath(dir, basename(target))
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(target, dest)
    // 产物台账：会话 → 库内落点，供「会话产物」页签按会话列出
    await appendArtifact({
      sessionId,
      tool: exec.name,
      libPath: relative(LIBRARY_ROOT, dest).replaceAll('\\', '/'),
      sourcePath: target,
      kind: 'relocated',
    })
    // 归位入库也触发云端镜像（防抖 5 秒，未配置/未开启时 no-op）
    scheduleAutoPush()
    pushFileNotice({
      kind: 'relocated',
      name: basename(dest),
      libPath: relative(LIBRARY_ROOT, dest).replaceAll('\\', '/'),
      sourcePath: target,
      sessionId,
      sessionTitle: meta?.title,
    })
  } catch {
    // 归位失败不阻断原工具调用——生产物仍在原处，用户可手动迁移
  }
}

/** 归位目标内的重名文件用时间戳后缀分开保存（wuzeno 的同名分存思路）。 */
async function relocatedPath(dir: string, filename: string): Promise<string> {
  const targetDir = dir || 'inbox'
  const primary = inLibrary(join(targetDir, filename))
  try {
    await stat(primary)
  } catch {
    return primary
  }
  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const ext = dot > 0 ? filename.slice(dot) : ''
  return inLibrary(join(targetDir, `${stem}-${Date.now()}${ext}`))
}

export interface PreDecision {
  kind: 'allow' | 'deny'
  reason?: string
}

/** 供 post-execute 判断失败与否（结果形状宽松匹配，失败才有 isError/error）。 */
export function isFailure(result: unknown): boolean {
  if (result == null || typeof result !== 'object') return false
  return ('isError' in result && result.isError === true) || 'error' in result
}

export { LIBRARY_ROOT, readFile }
