/**
 * 会话产物索引：遍历 $DSH_HOME/sessions 下全部会话日志，
 * 解析每个会话里 write/edit 类工具调用的目标文件路径，产出
 * 「工作区 / 会话标题 / 产物文件」三级视图数据（本地产物的历史回填）。
 *
 * 性能：178+ 个会话、百 M 级 zstd，不能请求时同步扫——
 * 后台增量扫描（按日志文件 mtime 复用缓存），结果持久化到
 * .dsh-library/artifact-index.json；接口先返回已有缓存 + scanning 标记，
 * 前端轮询补齐。
 */
import { homedir } from 'node:os'
import { join, basename, dirname, resolve, isAbsolute } from 'node:path'
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import * as zlib from 'node:zlib'
import { META_DIR } from './store.js'

const zstdDecompress: ((buf: Buffer) => Buffer) | undefined =
  (zlib as unknown as { zstdDecompressSync?: (buf: Buffer) => Buffer }).zstdDecompressSync

const SESSIONS_ROOT = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
const INDEX_FILE = join(META_DIR, 'artifact-index.json')
const ZSTD_MAGIC = Buffer.from('28b52ffd', 'hex')
const STALE_MS = 60_000
/** 缓存结构版本：解析规则变化时 +1，旧缓存作废重扫。 */
const INDEX_VERSION = 2
const WRITE_TOOLS = new Set(['write', 'edit', 'create_file', 'multi_edit', 'str_replace_based_edit_tool', 'ops_write_file', 'ops_edit_file'])

export interface DerivedArtifact {
  sessionId: string
  ws: string
  title: string
  tool: string
  /** 产物文件的绝对路径（会话写入时的落点）。 */
  sourcePath: string
  /** 最后写入时间（ISO）。 */
  time: string
}

interface WriteRecord { path: string; tool: string; time: number }
interface SessionScan { sessionId: string; mtimeMs: number; cwd: string; title: string; writes: WriteRecord[] }
interface IndexData { version?: number; scannedAt: number; sessions: Record<string, SessionScan> }

let data: IndexData = { scannedAt: 0, sessions: {} }
let loaded = false
let scanning = false

async function loadIndex(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const parsed = JSON.parse(await readFile(INDEX_FILE, 'utf8')) as IndexData
    if (parsed && typeof parsed === 'object' && parsed.sessions && parsed.version === INDEX_VERSION) data = parsed
  } catch {
    // 没有缓存或缓存损坏：全量重扫
  }
}

async function saveIndex(): Promise<void> {
  try {
    await mkdir(META_DIR, { recursive: true })
    data.version = INDEX_VERSION
    await writeFile(INDEX_FILE, JSON.stringify(data), 'utf8')
  } catch {
    // 缓存写失败不影响展示
  }
}

/** 与 interceptor 同款：从宽松的工具参数里提取目标文件路径。 */
function extractPath(args: Record<string, unknown>): string | undefined {
  for (const key of ['path', 'file_path', 'filePath', 'target', 'targetPath', 'filename', 'outputPath', 'output_path', 'output']) {
    if (typeof args[key] === 'string' && (args[key] as string).length > 0) {
      return args[key] as string
    }
  }
  return undefined
}

/**
 * 一次工具调用产出的文件路径。
 * - present：Agent 主动「展示产物」，files[].path 就是交付给用户的文件（含脚本生成的表格）
 * - write/edit 系：参数里的目标路径
 */
function producedPaths(name: string, args: Record<string, unknown>): string[] {
  if (name === 'present') {
    const files = Array.isArray(args.files) ? args.files : []
    return files
      .map(f => (f && typeof f === 'object' && typeof (f as { path?: unknown }).path === 'string' ? (f as { path: string }).path : ''))
      .filter(p => p.length > 0)
  }
  const path = extractPath(args)
  return path ? [path] : []
}

/** 解析单个会话日志：cwd（工作区）、最后的标题、全部写入调用。 */
function parseSession(sessionId: string, mtimeMs: number, buf: Buffer): SessionScan | null {
  if (!zstdDecompress) return null
  const offsets: number[] = [0]
  for (let i = buf.indexOf(ZSTD_MAGIC, 4); i !== -1; i = buf.indexOf(ZSTD_MAGIC, i + 4)) {
    offsets.push(i)
  }
  let cwd = ''
  let title = ''
  const writes = new Map<string, WriteRecord>()
  for (let k = 0; k < offsets.length; k++) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    let out: Buffer
    try {
      out = zstdDecompress(buf.subarray(offsets[k], end))
    } catch {
      continue
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
        continue
      }
      if (!line.startsWith('{"type":"tool/call"')) continue
      try {
        const ev = JSON.parse(line) as { time?: number; data?: { name?: string; arguments?: string } }
        const name = ev.data?.name
        if (!name || (!WRITE_TOOLS.has(name) && name !== 'present') || typeof ev.data?.arguments !== 'string') continue
        const args = JSON.parse(ev.data.arguments) as Record<string, unknown>
        const time = typeof ev.time === 'number' ? ev.time : 0
        for (const raw of producedPaths(name, args)) {
          const abs = (isAbsolute(raw) ? raw : resolve(cwd || '.', raw)).replaceAll('\\', '/')
          // 只收文件系统路径；明显是 URL/占位的不收
          if (!/^[A-Za-z]:\//.test(abs) && !abs.startsWith('/')) continue
          const prev = writes.get(abs)
          if (!prev || time >= prev.time) writes.set(abs, { path: abs, tool: name, time })
        }
      } catch { /* 参数不是 JSON / 半截行 */ }
    }
  }
  if (!cwd && writes.size === 0) return null
  return { sessionId, mtimeMs, cwd, title, writes: [...writes.values()] }
}

/** 收集全部会话日志文件路径。 */
async function listSessionFiles(): Promise<{ file: string; sessionId: string }[]> {
  const out: { file: string; sessionId: string }[] = []
  let wsDirs
  try {
    wsDirs = await readdir(SESSIONS_ROOT, { withFileTypes: true })
  } catch {
    return out
  }
  for (const wsDir of wsDirs) {
    if (!wsDir.isDirectory()) continue
    let sessions
    try {
      sessions = await readdir(join(SESSIONS_ROOT, wsDir.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue
      const file = join(SESSIONS_ROOT, wsDir.name, s.name, 'session.v4.jsonl.zstd')
      out.push({ file, sessionId: s.name })
    }
  }
  return out
}

/** 后台增量扫描：mtime 不变的会话直接复用缓存。 */
async function scan(): Promise<void> {
  if (scanning) return
  scanning = true
  try {
    await loadIndex()
    const files = await listSessionFiles()
    const alive = new Set(files.map(f => f.file))
    // 清掉已删除会话的缓存
    for (const key of Object.keys(data.sessions)) {
      if (!alive.has(key)) delete data.sessions[key]
    }
    const todo: { file: string; sessionId: string; mtimeMs: number }[] = []
    for (const f of files) {
      let mtimeMs: number
      try {
        mtimeMs = (await stat(f.file)).mtimeMs
      } catch {
        continue
      }
      const cached = data.sessions[f.file]
      if (cached && cached.mtimeMs === mtimeMs) continue
      todo.push({ ...f, mtimeMs })
    }
    const CONCURRENCY = 4
    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      await Promise.all(todo.slice(i, i + CONCURRENCY).map(async t => {
        try {
          const parsed = parseSession(t.sessionId, t.mtimeMs, await readFile(t.file))
          if (parsed) data.sessions[t.file] = parsed
        } catch {
          // 单个会话坏了不拖垮整轮扫描
        }
      }))
    }
    data.scannedAt = Date.now()
    await saveIndex()
  } finally {
    scanning = false
  }
}

/**
 * cwd → 展示用工作区名。主目录（没选工作区直接启动的会话）不叫
 * 用户名目录，显示为「主目录」，与 DSH 侧的认知对齐。
 */
function wsNameOf(cwd: string): string {
  if (!cwd) return ''
  const norm = cwd.replaceAll('\\', '/').replace(/\/+$/, '')
  if (norm.toLowerCase() === homedir().replaceAll('\\', '/').toLowerCase()) return '主目录'
  return basename(norm)
}

/**
 * 取当前派生产物（缓存视图）；缓存过期时踢后台扫描，不阻塞返回。
 * entries 不做存在性过滤——调用方按需 stat。
 */
export async function getDerivedArtifacts(): Promise<{ entries: DerivedArtifact[]; scanning: boolean }> {
  await loadIndex()
  if (!scanning && Date.now() - data.scannedAt > STALE_MS) {
    void scan()
  }
  const entries: DerivedArtifact[] = []
  for (const s of Object.values(data.sessions)) {
    const ws = wsNameOf(s.cwd)
    for (const w of s.writes) {
      entries.push({
        sessionId: s.sessionId,
        ws,
        title: s.title,
        tool: w.tool,
        sourcePath: w.path,
        time: w.time ? new Date(w.time).toISOString() : '',
      })
    }
  }
  return { entries, scanning }
}
