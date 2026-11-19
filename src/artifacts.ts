/**
 * 产物台账（对标 WorkBuddy「本地产物」按会话列产物）：
 * Agent 每次产出被归位/确认入库时，记录会话、工具、来源与库内落点，
 * JSONL 追加写（.dsh-library/provenance.jsonl），供面板按会话分组展示。
 */
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { META_DIR } from './store.js'

const LEDGER = join(META_DIR, 'provenance.jsonl')

export interface ArtifactRecord {
  /** 记录时间（ISO 8601）。 */
  time: string
  /** 会话标识（从 exec.agent 防御式提取；取不到记"未知会话"）。 */
  sessionId: string
  /** 来源工具名。 */
  tool: string
  /** 库内相对落点（点击即可预览）。 */
  libPath: string
  /** 归位前的原始路径（库外写入时有）。 */
  sourcePath?: string
  /** 记录类型：relocated=库外归位 / pending=修改进待确认。 */
  kind: 'relocated' | 'pending'
}

/**
 * 从 exec.agent 防御式提取会话标识。
 * 宿主 Agent 类型未公开稳定字段，按常见命名逐个试探，取不到给"未知会话"。
 */
export function sessionIdOf(agent: unknown): string {
  if (agent && typeof agent === 'object') {
    const a = agent as Record<string, unknown>
    for (const key of ['sessionId', 'session_id', 'sessionKey', 'id', 'name']) {
      if (typeof a[key] === 'string' && (a[key] as string).length > 0) return a[key] as string
    }
    const session = a.session
    if (session && typeof session === 'object') {
      for (const key of ['id', 'sessionId', 'session_id']) {
        const v = (session as Record<string, unknown>)[key]
        if (typeof v === 'string' && v.length > 0) return v
      }
    }
  }
  return '未知会话'
}

/** 追加一条台账（失败静默：台账不能影响归位主流程）。 */
export async function appendArtifact(record: Omit<ArtifactRecord, 'time'>): Promise<void> {
  try {
    await appendFile(LEDGER, JSON.stringify({ ...record, time: new Date().toISOString() }) + '\n', 'utf8')
  } catch {
    // ignore
  }
}

/** 读取全部台账，最新在前。 */
export async function readArtifacts(): Promise<ArtifactRecord[]> {
  try {
    const text = await readFile(LEDGER, 'utf8')
    return text.trim()
      ? text.trim().split('\n')
          .map(line => { try { return JSON.parse(line) as ArtifactRecord } catch { return null } })
          .filter((r): r is ArtifactRecord => r !== null)
          .reverse()
      : []
  } catch {
    return []
  }
}
