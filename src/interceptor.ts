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

/** pre-execute 的裁决：拦截修改类写入，其余放行。 */
export async function preExecute(exec: { name: string; arguments: unknown; agent?: unknown }): Promise<PreDecision> {
  if (!WRITE_TOOLS.has(exec.name)) return { kind: 'allow' }
  const args = (exec.arguments ?? {}) as Record<string, unknown>
  const target = extractPath(args)
  if (!target) return { kind: 'allow' }

  // 只管库内；库外的写入先放行，post 阶段归位副本
  if (!isInsideLibrary(target)) return { kind: 'allow' }

  // 读取类工具：固定修订引用（pin）
  if (READ_TOOLS.has(exec.name)) {
    const rel = relative(LIBRARY_ROOT, target).replaceAll('\\', '/')
    const outcome = await pinForRead(target, rel)
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

/** post-execute 的裁决：库外成功写入的文件，复制一份到 inbox/ 归位。 */
export async function postExecute(exec: { name: string; arguments: unknown; agent?: unknown }, failed: boolean): Promise<void> {
  if (failed || !WRITE_TOOLS.has(exec.name)) return
  const args = (exec.arguments ?? {}) as Record<string, unknown>
  const target = extractPath(args)
  if (!target || isInsideLibrary(target) || !existsSync(target)) return
  try {
    // v0.1 规则：库外产出统一归位到 inbox/<文件名>；重名文件加时间戳后缀
    // 源是目录（或无法 stat）时不归位——只搬文件
    const srcStat = await stat(target)
    if (!srcStat.isFile()) return
    const dest = await relocatedPath(basename(target))
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(target, dest)
    // 产物台账：会话 → 库内落点，供「会话产物」页签按会话列出
    await appendArtifact({
      sessionId: sessionIdOf(exec.agent),
      tool: exec.name,
      libPath: relative(LIBRARY_ROOT, dest).replaceAll('\\', '/'),
      sourcePath: target,
      kind: 'relocated',
    })
  } catch {
    // 归位失败不阻断原工具调用——生产物仍在原处，用户可手动迁移
  }
}

/** inbox 内的重名文件用时间戳后缀分开保存（wuzeno 的同名分存思路）。 */
async function relocatedPath(filename: string): Promise<string> {
  const primary = inLibrary(join('inbox', filename))
  try {
    await stat(primary)
  } catch {
    return primary
  }
  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const ext = dot > 0 ? filename.slice(dot) : ''
  return inLibrary(join('inbox', `${stem}-${Date.now()}${ext}`))
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
