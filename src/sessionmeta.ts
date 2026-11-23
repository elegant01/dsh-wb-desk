/**
 * 会话元数据解析：把台账里的 sessionId 翻译成人类可读的
 * 「DSH 工作区名 + 会话标题」（本地产物按 工作区/会话/文件 三级分组）。
 *
 * 数据源：$DSH_HOME/sessions/<编码工作区>/<sessionId>/session.v4.jsonl.zstd
 *   - 第 1 帧第 1 行是 session 元信息（cwd → 工作区名）
 *   - 后续帧里的 session/title 事件给出标题，取最后一条（LLM 精修会覆盖兜底标题）
 *
 * 文件是多帧拼接的 zstd（按 magic 0xFD2FB528 切帧）；运行时不支持 zstd
 * 或文件缺失时返回 null，调用方走兜底展示。结果按文件 mtime 缓存。
 */
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { readdir, readFile, stat } from 'node:fs/promises'
import * as zlib from 'node:zlib'

/** Node ≥22.15 才有 zstd；运行时没有就整体降级为「解析不到」（兜底展示），不能拖垮插件加载。 */
const zstdDecompress: ((buf: Buffer) => Buffer) | undefined =
  (zlib as unknown as { zstdDecompressSync?: (buf: Buffer) => Buffer }).zstdDecompressSync

export interface SessionMeta {
  wsName: string
  title: string
}

const SESSIONS_ROOT = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
const ZSTD_MAGIC = Buffer.from('28b52ffd', 'hex')

interface CacheEntry { mtimeMs: number; meta: SessionMeta | null }
const metaCache = new Map<string, CacheEntry>()
/** sessionId → 会话目录绝对路径（目录清单按 TTL 缓存，避免每次全量扫） */
const dirCache = new Map<string, string | null>()
let dirListCache: { time: number; dirs: string[] } | null = null
const DIR_LIST_TTL = 60_000

async function workspaceDirs(): Promise<string[]> {
  if (dirListCache && Date.now() - dirListCache.time < DIR_LIST_TTL) return dirListCache.dirs
  let dirs: string[] = []
  try {
    dirs = (await readdir(SESSIONS_ROOT, { withFileTypes: true }))
      .filter(e => e.isDirectory())
      .map(e => join(SESSIONS_ROOT, e.name))
  } catch {
    dirs = []
  }
  dirListCache = { time: Date.now(), dirs }
  return dirs
}

/** 定位某个 sessionId 的日志文件；找不到返回 null。 */
async function locateSessionFile(sessionId: string): Promise<string | null> {
  const hit = dirCache.get(sessionId)
  if (hit) return hit
  for (const wsDir of await workspaceDirs()) {
    const file = join(wsDir, sessionId, 'session.v4.jsonl.zstd')
    try {
      await stat(file)
      dirCache.set(sessionId, file)
      return file
    } catch {
      // 不在这个工作区，继续找
    }
  }
  return null
}

/** 逐帧解压并提取 cwd（工作区名）与最后的会话标题。 */
function parseSessionFile(buf: Buffer): SessionMeta | null {
  if (!zstdDecompress) return null
  const offsets: number[] = [0]
  for (let i = buf.indexOf(ZSTD_MAGIC, 4); i !== -1; i = buf.indexOf(ZSTD_MAGIC, i + 4)) {
    offsets.push(i)
  }
  let cwd = ''
  let title = ''
  for (let k = 0; k < offsets.length; k++) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    let out: Buffer
    try {
      out = zstdDecompress(buf.subarray(offsets[k], end))
    } catch {
      continue // 半写的尾帧等，跳过
    }
    for (const line of out.toString('utf8').split('\n')) {
      if (!line) continue
      if (!cwd && line.startsWith('{"type":"session"')) {
        try {
          const meta = JSON.parse(line) as { cwd?: string }
          if (typeof meta.cwd === 'string') cwd = meta.cwd
        } catch { /* 半截行 */ }
        continue
      }
      if (line.startsWith('{"type":"session/title"')) {
        try {
          const ev = JSON.parse(line) as { data?: { title?: string } }
          if (typeof ev.data?.title === 'string' && ev.data.title) title = ev.data.title
        } catch { /* 半截行 */ }
      }
    }
  }
  if (!cwd && !title) return null
  const norm = cwd.replaceAll('\\', '/').replace(/\/+$/, '')
  // 主目录（没选工作区直接启动的会话）显示为「主目录」，不叫用户名目录
  const wsName = cwd
    ? (norm.toLowerCase() === homedir().replaceAll('\\', '/').toLowerCase() ? '主目录' : basename(norm))
    : ''
  return { wsName, title }
}

/**
 * 解析 sessionId → 工作区名 + 会话标题。
 * 任何一步失败都返回 null（调用方用 sessionId 截断展示兜底）。
 */
export async function resolveSessionMeta(sessionId: string): Promise<SessionMeta | null> {  if (!sessionId || sessionId === '未知会话') return null
  const file = await locateSessionFile(sessionId)
  if (!file) return null
  let mtimeMs: number
  try {
    mtimeMs = (await stat(file)).mtimeMs
  } catch {
    return null
  }
  const cached = metaCache.get(sessionId)
  if (cached && cached.mtimeMs === mtimeMs) return cached.meta
  let meta: SessionMeta | null = null
  try {
    meta = parseSessionFile(await readFile(file))
  } catch {
    meta = null
  }
  metaCache.set(sessionId, { mtimeMs, meta })
  return meta
}

/** 会话日志的最后活动时间（mtime）；会话结束后不再增长。定位不到返回 null。 */
export async function sessionLastActive(sessionId: string): Promise<number | null> {
  if (!sessionId || sessionId === '未知会话') return null
  const file = await locateSessionFile(sessionId)
  if (!file) return null
  try {
    return (await stat(file)).mtimeMs
  } catch {
    return null
  }
}
