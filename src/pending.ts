/**
 * 待确认队列（需求文档 3.1）：Agent 对库内已有文件的修改不直接落盘，
 * 先持久化到 .dsh-library/pending/，用户接受后才写入正文。
 *
 * 持久化是硬要求：DSH 重启/崩溃后队列不能丢——"Agent 产出丢失"
 * 恰恰是本产品要解决的原始痛点，队列自身不能成为新的丢失源。
 * 拒绝的内容也保留（移入 rejected.jsonl），可追溯找回。
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { PENDING_DIR } from './store.js'

/** 一条待确认的修改。 */
export interface PendingChange {
  id: string
  /** 创建时间（ISO 8601）。 */
  createdAt: string
  /** 来源工具名（write / edit / …）。 */
  tool: string
  /** 库内目标绝对路径。 */
  targetPath: string
  /** 用户可读的修改摘要（diff 或新内容截断）。 */
  summary: string
  /** 完整的待写入内容，接受时整体落盘。 */
  content: string
}

/** 队列文件命名：pending/<createdAt 时间戳>-<id前8位>.json */
function pendingFile(change: Pick<PendingChange, 'createdAt' | 'id'>): string {
  return join(PENDING_DIR, `${change.createdAt.replace(/[:.]/g, '-')}-${change.id.slice(0, 8)}.json`)
}

/** 新增一条待确认修改并立即持久化。 */
export async function enqueue(input: Omit<PendingChange, 'id' | 'createdAt'>): Promise<PendingChange> {
  await mkdir(PENDING_DIR, { recursive: true })
  const change: PendingChange = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...input,
  }
  await writeFile(pendingFile(change), JSON.stringify(change, null, 2), 'utf8')
  return change
}

/** 列出当前所有待确认修改（按创建时间升序）。 */
export async function listPending(): Promise<PendingChange[]> {
  const { readdir } = await import('node:fs/promises')
  await mkdir(PENDING_DIR, { recursive: true })
  const files = (await readdir(PENDING_DIR)).filter(f => f.endsWith('.json')).sort()
  const changes: PendingChange[] = []
  for (const f of files) {
    try {
      changes.push(JSON.parse(await readFile(join(PENDING_DIR, f), 'utf8')) as PendingChange)
    } catch {
      // 单条损坏不拖垮整个队列，跳过即可
    }
  }
  return changes
}

/** 处置一条待确认修改：接受则落盘，拒绝则归档。返回是否找到该条。 */
export async function resolvePending(
  id: string,
  action: 'accept' | 'reject',
): Promise<boolean> {
  const all = await listPending()
  const found = all.find(c => c.id === id || c.id.startsWith(id))
  if (!found) return false
  const file = pendingFile(found)
  if (action === 'accept') {
    await writeFile(found.targetPath, found.content, 'utf8')
    await rename(file, file + '.resolved')
  } else {
    await rename(file, file + '.rejected')
  }
  return true
}

/** 从工具参数中提取摘要与完整内容（不同工具参数名不同，宽松匹配）。 */
export function extractContent(args: Record<string, unknown>): { content: string; summary: string } {
  const content = typeof args.content === 'string'
    ? args.content
    : typeof args.new_string === 'string' ? args.new_string : ''
  const preview = content.length > 200 ? content.slice(0, 200) + '…' : content
  return { content, summary: preview }
}
