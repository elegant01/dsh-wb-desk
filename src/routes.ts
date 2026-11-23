/**
 * dsh-wb-desk host 半 HTTP 路由：/dsh-wb-desk/*（同源）。
 *
 * 挂载方式对齐 dsh-doclib 的 webServer.prefix 模式（2026-11-18 已验证其可用）。
 * 提供资料库面板所需的最小数据面：
 *   GET  /tree              递归目录树（跳过 .dsh-library）
 *   GET  /file?path=rel     读文本文件内容（限文本后缀与大小）
 *   GET  /pending           待确认队列
 *   POST /pending/resolve   接受/拒绝一条待确认修改
 *   GET  /root              库根绝对路径
 */
import { join, resolve, sep, extname, basename, dirname, relative } from 'node:path'
import { readdir, readFile, rename, writeFile, mkdir, stat, copyFile, rm } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { LIBRARY_ROOT, PENDING_DIR, TRASH_DIR } from './store.js'
import { listPending, resolvePending } from './pending.js'
import { listActivePins, releasePin } from './pins.js'
import { readArtifacts } from './artifacts.js'
import { resolveSessionMeta } from './sessionmeta.js'
import { getDerivedArtifacts } from './artifactindex.js'
import { loadCloudConfig, saveCloudConfig, syncNow, testCloud, scheduleAutoPush, pushFile, presignCosGet, type CloudConfig } from './cloud.js'
import { loadConfig, saveConfig } from './config.js'
import { runMaintenance } from './maintenance.js'

/** 页面内可预览的文本后缀；其余一律提示不支持预览（防二进制塞爆响应）。 */
const TEXT_EXT = new Set([
  '.md', '.txt', '.json', '.csv', '.html', '.htm', '.js', '.mjs', '.cjs', '.ts',
  '.tsx', '.jsx', '.css', '.yml', '.yaml', '.toml', '.xml', '.svg', '.py', '.rs',
  '.go', '.java', '.sh', '.ps1', '.bat', '.log', '.ini', '.sql', '.vue',
])
const MAX_PREVIEW_BYTES = 512 * 1024


/** 最小合法 Office 模板（stored zip）：新建 .docx/.xlsx/.pptx 时落盘为可打开的空文件。 */
const OFFICE_TEMPLATES = {
  docx: 'UEsDBBQAAAAAAAAAAAB5bjPXrQEAAK0BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz48VHlwZXMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvY29udGVudC10eXBlcyI+PERlZmF1bHQgRXh0ZW5zaW9uPSJyZWxzIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLXBhY2thZ2UucmVsYXRpb25zaGlwcyt4bWwiLz48RGVmYXVsdCBFeHRlbnNpb249InhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3dvcmQvZG9jdW1lbnQueG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LndvcmRwcm9jZXNzaW5nbWwuZG9jdW1lbnQubWFpbit4bWwiLz48L1R5cGVzPlBLAwQUAAAAAAAAAAAAm/036ikBAAApAQAACwAAAF9yZWxzLy5yZWxzPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/PjxSZWxhdGlvbnNoaXBzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L3JlbGF0aW9uc2hpcHMiPjxSZWxhdGlvbnNoaXAgSWQ9InJJZDEiIFR5cGU9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9uc2hpcHMvb2ZmaWNlRG9jdW1lbnQiIFRhcmdldD0id29yZC9kb2N1bWVudC54bWwiLz48L1JlbGF0aW9uc2hpcHM+UEsDBBQAAAAAAAAAAACZCVxZrgAAAK4AAAARAAAAd29yZC9kb2N1bWVudC54bWw8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+PHc6ZG9jdW1lbnQgeG1sbnM6dz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3dvcmRwcm9jZXNzaW5nbWwvMjAwNi9tYWluIj48dzpib2R5Pjx3OnAvPjwvdzpib2R5Pjwvdzpkb2N1bWVudD5QSwECFAAUAAAAAAAAAAAAeW4z160BAACtAQAAEwAAAAAAAAAAAAAAAAAAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUABQAAAAAAAAAAACb/TfqKQEAACkBAAALAAAAAAAAAAAAAAAAAN4BAABfcmVscy8ucmVsc1BLAQIUABQAAAAAAAAAAACZCVxZrgAAAK4AAAARAAAAAAAAAAAAAAAAADADAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAAAwADALkAAAANBAAAAAA=',
  xlsx: 'UEsDBBQAAAAAAAAAAABuYbgNLQIAAC0CAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz48VHlwZXMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvY29udGVudC10eXBlcyI+PERlZmF1bHQgRXh0ZW5zaW9uPSJyZWxzIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLXBhY2thZ2UucmVsYXRpb25zaGlwcyt4bWwiLz48RGVmYXVsdCBFeHRlbnNpb249InhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3hsL3dvcmtib29rLnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC5zcHJlYWRzaGVldG1sLnNoZWV0Lm1haW4reG1sIi8+PE92ZXJyaWRlIFBhcnROYW1lPSIveGwvd29ya3NoZWV0cy9zaGVldDEueG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LnNwcmVhZHNoZWV0bWwud29ya3NoZWV0K3htbCIvPjwvVHlwZXM+UEsDBBQAAAAAAAAAAACY2uuLJwEAACcBAAALAAAAX3JlbHMvLnJlbHM8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+PFJlbGF0aW9uc2hpcHMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvcmVsYXRpb25zaGlwcyI+PFJlbGF0aW9uc2hpcCBJZD0icklkMSIgVHlwZT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcy9vZmZpY2VEb2N1bWVudCIgVGFyZ2V0PSJ4bC93b3JrYm9vay54bWwiLz48L1JlbGF0aW9uc2hpcHM+UEsDBBQAAAAAAAAAAACdbEO9GwEAABsBAAAPAAAAeGwvd29ya2Jvb2sueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pjx3b3JrYm9vayB4bWxucz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3NwcmVhZHNoZWV0bWwvMjAwNi9tYWluIiB4bWxuczpyPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9yZWxhdGlvbnNoaXBzIj48c2hlZXRzPjxzaGVldCBuYW1lPSJTaGVldDEiIHNoZWV0SWQ9IjEiIHI6aWQ9InJJZDEiLz48L3NoZWV0cz48L3dvcmtib29rPlBLAwQUAAAAAAAAAAAAWv2CaygBAAAoAQAAGgAAAHhsL19yZWxzL3dvcmtib29rLnhtbC5yZWxzPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/PjxSZWxhdGlvbnNoaXBzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L3JlbGF0aW9uc2hpcHMiPjxSZWxhdGlvbnNoaXAgSWQ9InJJZDEiIFR5cGU9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9uc2hpcHMvd29ya3NoZWV0IiBUYXJnZXQ9IndvcmtzaGVldHMvc2hlZXQxLnhtbCIvPjwvUmVsYXRpb25zaGlwcz5QSwMEFAAAAAAAAAAAAJ6MqE6cAAAAnAAAABgAAAB4bC93b3Jrc2hlZXRzL3NoZWV0MS54bWw8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+PHdvcmtzaGVldCB4bWxucz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3NwcmVhZHNoZWV0bWwvMjAwNi9tYWluIj48c2hlZXREYXRhLz48L3dvcmtzaGVldD5QSwECFAAUAAAAAAAAAAAAbmG4DS0CAAAtAgAAEwAAAAAAAAAAAAAAAAAAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUABQAAAAAAAAAAACY2uuLJwEAACcBAAALAAAAAAAAAAAAAAAAAF4CAABfcmVscy8ucmVsc1BLAQIUABQAAAAAAAAAAACdbEO9GwEAABsBAAAPAAAAAAAAAAAAAAAAAK4DAAB4bC93b3JrYm9vay54bWxQSwECFAAUAAAAAAAAAAAAWv2CaygBAAAoAQAAGgAAAAAAAAAAAAAAAAD2BAAAeGwvX3JlbHMvd29ya2Jvb2sueG1sLnJlbHNQSwECFAAUAAAAAAAAAAAAnoyoTpwAAACcAAAAGAAAAAAAAAAAAAAAAABWBgAAeGwvd29ya3NoZWV0cy9zaGVldDEueG1sUEsFBgAAAAAFAAUARQEAACgHAAAAAA==',
  pptx: 'UEsDBBQAAAAAAAAAAACe0ypcsgEAALIBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz48VHlwZXMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvY29udGVudC10eXBlcyI+PERlZmF1bHQgRXh0ZW5zaW9uPSJyZWxzIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLXBhY2thZ2UucmVsYXRpb25zaGlwcyt4bWwiLz48RGVmYXVsdCBFeHRlbnNpb249InhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3BwdC9wcmVzZW50YXRpb24ueG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LnByZXNlbnRhdGlvbm1sLnByZXNlbnRhdGlvbi5tYWluK3htbCIvPjwvVHlwZXM+UEsDBBQAAAAAAAAAAAAbyrjuLAEAACwBAAALAAAAX3JlbHMvLnJlbHM8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+PFJlbGF0aW9uc2hpcHMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvcmVsYXRpb25zaGlwcyI+PFJlbGF0aW9uc2hpcCBJZD0icklkMSIgVHlwZT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcy9vZmZpY2VEb2N1bWVudCIgVGFyZ2V0PSJwcHQvcHJlc2VudGF0aW9uLnhtbCIvPjwvUmVsYXRpb25zaGlwcz5QSwMEFAAAAAAAAAAAAB9BM7yqAAAAqgAAABQAAABwcHQvcHJlc2VudGF0aW9uLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz48cDpwcmVzZW50YXRpb24geG1sbnM6cD0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3ByZXNlbnRhdGlvbm1sLzIwMDYvbWFpbiI+PHA6c2xkSWRMc3QvPjwvcDpwcmVzZW50YXRpb24+UEsDBBQAAAAAAAAAAADp+cGTmwAAAJsAAAAfAAAAcHB0L19yZWxzL3ByZXNlbnRhdGlvbi54bWwucmVsczw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz48UmVsYXRpb25zaGlwcyB4bWxucz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3BhY2thZ2UvMjAwNi9yZWxhdGlvbnNoaXBzIj48L1JlbGF0aW9uc2hpcHM+UEsBAhQAFAAAAAAAAAAAAJ7TKlyyAQAAsgEAABMAAAAAAAAAAAAAAAAAAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAAUAAAAAAAAAAAAG8q47iwBAAAsAQAACwAAAAAAAAAAAAAAAADjAQAAX3JlbHMvLnJlbHNQSwECFAAUAAAAAAAAAAAAH0EzvKoAAACqAAAAFAAAAAAAAAAAAAAAAAA4AwAAcHB0L3ByZXNlbnRhdGlvbi54bWxQSwECFAAUAAAAAAAAAAAA6fnBk5sAAACbAAAAHwAAAAAAAAAAAAAAAAAUBAAAcHB0L19yZWxzL3ByZXNlbnRhdGlvbi54bWwucmVsc1BLBQYAAAAABAAEAAkBAADsBAAAAAA=',
} as const

function sendJson(res: import('node:http').ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 只接受同源请求（对齐 doclib）。 */
function sameOrigin(req: import('node:http').IncomingMessage): boolean {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  const host = req.headers.host
  if (typeof host !== 'string') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

async function readBody(req: import('node:http').IncomingMessage, limitBytes = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > limitBytes) throw new Error('请求体超限')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 库内相对路径 → 绝对路径；拒绝 .. 与绝对路径注入。 */
function safeJoin(relative: string): string {
  const abs = resolve(LIBRARY_ROOT, '.' + sep + relative)
  if (!abs.startsWith(LIBRARY_ROOT.endsWith(sep) ? LIBRARY_ROOT : LIBRARY_ROOT + sep)) {
    throw new Error('非法路径')
  }
  return abs
}

interface TreeEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
  size?: number
  mtime?: number
  children?: TreeEntry[]
}

interface SearchHit {
  path: string
  lineNo: number
  line: string
}

/** 全文检索：递归扫库内文本文件，命中行按顺序返回（上限 50 条）。 */
async function searchAll(query: string): Promise<SearchHit[]> {
  const hits: SearchHit[] = []
  const needle = query.toLowerCase()
  async function walk(dir: string, rel: string): Promise<void> {
    if (hits.length >= 50) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // 无权限/已删除的子目录直接跳过
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue // .dsh-library 等隐藏目录不参与检索
      if (rel === '' && entry.name === 'inbox') continue // Agent 产物区不属于「我的资料」
      const abs = join(dir, entry.name)
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(abs, relPath)
        if (hits.length >= 50) return
        continue
      }
      if (!TEXT_EXT.has(extname(abs).toLowerCase())) continue
      let text: string
      try {
        text = await readFile(abs, 'utf8')
      } catch {
        continue
      }
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          hits.push({ path: relPath, lineNo: i + 1, line: lines[i].trim().slice(0, 200) })
          if (hits.length >= 50) return
        }
      }
    }
  }
  await walk(LIBRARY_ROOT, '')
  return hits
}

async function buildTree(absDir: string, relDir: string, depth: number): Promise<TreeEntry[]> {
  const entries = await readdir(absDir, { withFileTypes: true })
  const out: TreeEntry[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue // .dsh-library 等隐藏目录不进树
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name
    let meta: { size?: number; mtime?: number } = {}
    try {
      const st = await stat(join(absDir, entry.name))
      meta = { size: entry.isFile() ? st.size : undefined, mtime: st.mtimeMs }
    } catch {
      // 读不到元信息（权限/竞态删除）就不带，前端按未知展示
    }
    if (entry.isDirectory()) {
      const node: TreeEntry = { name: entry.name, path: rel, kind: 'directory', ...meta }
      if (depth > 0) node.children = await buildTree(join(absDir, entry.name), rel, depth - 1)
      out.push(node)
    } else if (entry.isFile()) {
      out.push({ name: entry.name, path: rel, kind: 'file', ...meta })
    }
  }
  out.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name, 'zh') : a.kind === 'directory' ? -1 : 1,
  )
  return out
}

interface WebContext {
  webServer: {
    register(options: { kind: string; path: string; handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void> | void }): unknown
  }
  effect(fn: () => unknown, label: string): unknown
}

/** 绝对路径是否为「会话日志里出现过的产物」（/read-abs、上传、分享共用的白名单）。 */
async function artifactAllowed(absPath: string): Promise<boolean> {
  const norm = absPath.replaceAll('\\', '/').toLowerCase()
  const { entries } = await getDerivedArtifacts()
  if (entries.some(e => e.sourcePath.toLowerCase() === norm)) return true
  const ledger = await readArtifacts()
  return ledger.some(i => typeof i.sourcePath === 'string' && i.sourcePath.replaceAll('\\', '/').toLowerCase() === norm)
}

/**
 * 解析上传目标：库内路径校验后原样返回（统一 / 分隔）；
 * 会话产物（abs=true）先复制进库根（同名加序号不覆盖），返回库内相对路径。
 */
async function resolveUploadTarget(rawPath: string | undefined, abs: boolean): Promise<string> {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') throw new Error('参数错误')
  if (!abs) {
    const absPath = safeJoin(rawPath)
    if (!existsSync(absPath)) throw new Error('文件不存在')
    if (!statSync(absPath).isFile()) throw new Error('只能上传单个文件')
    return rawPath.replaceAll('\\', '/').replace(/^\/+/, '')
  }
  const src = rawPath.replaceAll('\\', '/')
  if (!(await artifactAllowed(src))) throw new Error('路径不在会话产物白名单内')
  if (!existsSync(src)) throw new Error('源文件不存在，可能已被删除')
  const name = basename(src)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let rel = name
  for (let n = 1; existsSync(safeJoin(rel)); n++) {
    if (n > 500) throw new Error('同名文件过多')
    rel = `${stem}-${n}${ext}`
  }
  await copyFile(src, safeJoin(rel))
  scheduleAutoPush()
  return rel
}

/** 注册 /dsh-wb-desk/* 路由（webServer 存在时）。 */
export function registerRoutes(ctx: WebContext): void {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/dsh-wb-desk',
        handler: async (req, res) => {
          try {
            if (!sameOrigin(req)) {
              sendJson(res, 403, { error: '跨站请求已拒绝' })
              return
            }
            const url = new URL(req.url || '/', 'http://x')
            const route = url.pathname.replace(/^\/dsh-wb-desk/, '') || '/'

            if (route === '/root' && req.method === 'GET') {
              sendJson(res, 200, { root: LIBRARY_ROOT })
              return
            }

            // 自动化设置：归位规则 + pin 保留天数（保存后立即跑一次清理）
            if (route === '/config' && req.method === 'GET') {
              sendJson(res, 200, await loadConfig())
              return
            }
            if (route === '/config' && req.method === 'POST') {
              const body = JSON.parse(await readBody(req)) as { rules?: unknown; pinRetentionDays?: unknown }
              const cfg = await saveConfig(body)
              const maintenance = await runMaintenance().catch(() => ({ pins: 0, trash: 0 }))
              sendJson(res, 200, { ok: true, ...cfg, maintenance })
              return
            }

            if (route === '/tree' && req.method === 'GET') {
              if (!existsSync(LIBRARY_ROOT)) {
                sendJson(res, 200, { items: [] })
                return
              }
              // inbox 是 Agent 产物归位区，只在「本地产物」按会话展示，不进「我的资料」
              const items = (await buildTree(LIBRARY_ROOT, '', 8)).filter(e => e.name !== 'inbox')
              sendJson(res, 200, { items })
              return
            }

            // 库内全量文件元信息（含 inbox）：最近访问/我的收藏里不在 /tree 的条目靠它补大小与时间
            if (route === '/metas' && req.method === 'GET') {
              if (!existsSync(LIBRARY_ROOT)) {
                sendJson(res, 200, { items: {} })
                return
              }
              const flat: Record<string, { size?: number; mtime?: number }> = {}
              const walk = (nodes: Awaited<ReturnType<typeof buildTree>>) => {
                for (const n of nodes) {
                  flat[n.path] = { size: n.size, mtime: n.mtime }
                  if (n.children) walk(n.children)
                }
              }
              walk(await buildTree(LIBRARY_ROOT, '', 8))
              sendJson(res, 200, { items: flat })
              return
            }

            if (route === '/search' && req.method === 'GET') {
              const q = (url.searchParams.get('q') || '').trim()
              if (q === '') {
                sendJson(res, 200, { hits: [] })
                return
              }
              if (!existsSync(LIBRARY_ROOT)) {
                sendJson(res, 200, { hits: [] })
                return
              }
              sendJson(res, 200, { hits: await searchAll(q) })
              return
            }

            if (route === '/file' && (req.method === 'PUT' || req.method === 'POST')) {
              // 编辑保存：面板编辑模式写回（需求文档 3.1"人可管理"）
              const body = JSON.parse(await readBody(req, MAX_PREVIEW_BYTES)) as { path?: string; content?: string }
              if (typeof body.path !== 'string' || typeof body.content !== 'string') {
                sendJson(res, 400, { error: '参数错误' })
                return
              }
              const abs = safeJoin(body.path)
              if (!TEXT_EXT.has(extname(abs).toLowerCase())) {
                sendJson(res, 400, { error: '这个文件不支持在页面里编辑' })
                return
              }
              await writeFile(abs, body.content, 'utf8')
              scheduleAutoPush()
              sendJson(res, 200, { ok: true })
              return
            }

            if (route === '/file' && req.method === 'GET') {
              const rel = url.searchParams.get('path') || ''
              const abs = safeJoin(rel)
              if (!existsSync(abs)) {
                sendJson(res, 404, { error: '文件不存在' })
                return
              }
              if (!TEXT_EXT.has(extname(abs).toLowerCase())) {
                sendJson(res, 200, { path: rel, kind: 'binary', text: null })
                return
              }
              const stat = await (await import('node:fs/promises')).stat(abs)
              if (stat.size > MAX_PREVIEW_BYTES) {
                sendJson(res, 200, { path: rel, kind: 'too-large', text: null })
                return
              }
              sendJson(res, 200, { path: rel, kind: 'text', text: await readFile(abs, 'utf8') })
              return
            }

            if (route === '/pending' && req.method === 'GET') {
              sendJson(res, 200, { items: await listPending() })
              return
            }

            if (route === '/artifacts' && req.method === 'GET') {
              const items = await readArtifacts()
              // 按会话翻译工作区名 + 会话标题（本地产物按 工作区/会话/文件 分组）
              const metas = new Map<string, Awaited<ReturnType<typeof resolveSessionMeta>>>()
              for (const item of items) {
                if (!metas.has(item.sessionId)) metas.set(item.sessionId, await resolveSessionMeta(item.sessionId))
              }
              const ledgerPaths = new Set(
                items.filter(i => i.sourcePath).map(i => `${i.sessionId}|${(i.sourcePath as string).replaceAll('\\', '/').toLowerCase()}`),
              )
              const enriched = items.map(item => {
                const meta = metas.get(item.sessionId)
                // inbox 不进我的资料的树，大小/时间由这里直接补齐；没归位的产物退回读源文件
                let st
                try { st = statSync(join(LIBRARY_ROOT, item.libPath)) } catch { st = undefined }
                if (!st && typeof item.sourcePath === 'string') {
                  try { st = statSync(item.sourcePath) } catch { st = undefined }
                }
                return {
                  ...item,
                  ws: meta?.wsName || undefined,
                  title: meta?.title || undefined,
                  size: st?.isFile() ? st.size : undefined,
                  mtime: st?.mtimeMs,
                }
              })
              // 历史回填：遍历全部会话日志解析 write/edit 调用（后台增量索引，本次返回缓存视图）
              const { entries, scanning } = await getDerivedArtifacts()
              const derived = []
              for (const e of entries) {
                const normKey = `${e.sessionId}|${e.sourcePath.toLowerCase()}`
                if (ledgerPaths.has(normKey)) continue // 已被台账收录（有库内副本），不重复展示
                let st
                try { st = statSync(e.sourcePath) } catch { continue } // 文件已删的不展示
                if (!st.isFile()) continue
                derived.push({ ...e, kind: 'session-file' as const, size: st.size, mtime: st.mtimeMs })
              }
              sendJson(res, 200, { items: [...enriched, ...derived], scanning })
              return
            }

            if (route === '/read-abs' && req.method === 'GET') {
              // 会话产物预览：白名单制——只允许读「会话日志里出现过的产物路径」
              const p = (url.searchParams.get('path') || '').replaceAll('\\', '/')
              if (!p || !(await artifactAllowed(p))) {
                sendJson(res, 403, { error: '路径不在会话产物白名单内' })
                return
              }
              if (!TEXT_EXT.has(extname(p).toLowerCase())) {
                sendJson(res, 200, { path: p, kind: 'binary', text: null })
                return
              }
              let st
              try { st = await stat(p) } catch {
                sendJson(res, 404, { error: '文件不存在' })
                return
              }
              if (st.size > MAX_PREVIEW_BYTES) {
                sendJson(res, 200, { path: p, kind: 'too-large', text: null })
                return
              }
              sendJson(res, 200, { path: p, kind: 'text', text: await readFile(p, 'utf8') })
              return
            }

            // 二进制/超大文件的兜底：交给系统默认应用打开，或在资源管理器中定位
            if (route === '/open' && req.method === 'POST') {
              const body = JSON.parse(await readBody(req)) as { path?: string; abs?: boolean; action?: string }
              const p = String(body.path || '')
              const wantFolder = body.action === 'folder'
              let abs: string
              if (body.abs) {
                if (!p || !(await artifactAllowed(p))) {
                  sendJson(res, 403, { error: '路径不在会话产物白名单内' })
                  return
                }
                abs = p
              } else {
                try { abs = safeJoin(p) } catch {
                  sendJson(res, 400, { error: '非法路径' })
                  return
                }
              }
              if (!existsSync(abs)) {
                sendJson(res, 404, { error: '文件不存在，可能已被移动或删除' })
                return
              }
              const { spawn } = await import('node:child_process')
              const isDir = statSync(abs).isDirectory()
              const win = process.platform === 'win32'
              const cmd = win ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
              // explorer.exe 不认正斜杠：/select,F:/a/b 会静默失败，必须先转成反斜杠
              const target = win ? abs.replaceAll('/', '\\') : abs
              // 打开所在文件夹：Windows 用 /select 定位文件；其它平台打开父目录
              const args = wantFolder && !isDir
                ? win ? ['/select,', target] : [dirname(abs)]
                : [target]
              try {
                spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
              } catch {
                sendJson(res, 500, { error: '无法调起系统应用' })
                return
              }
              sendJson(res, 200, { ok: true })
              return
            }

            if (route === '/pins' && req.method === 'GET') {
              sendJson(res, 200, { items: await listActivePins() })
              return
            }

            if (route === '/pins/release' && req.method === 'POST') {
              const body = JSON.parse(await readBody(req)) as { path?: string }
              if (typeof body.path !== 'string' || body.path === '') {
                sendJson(res, 400, { error: '参数错误' })
                return
              }
              const ok = await releasePin(body.path)
              if (!ok) {
                sendJson(res, 404, { error: '该文件没有生效的固定引用' })
                return
              }
              sendJson(res, 200, { ok: true, items: await listActivePins() })
              return
            }

            if (route === '/pending/resolve' && req.method === 'POST') {
              const body = JSON.parse(await readBody(req)) as { id?: string; action?: string }
              if (typeof body.id !== 'string' || (body.action !== 'accept' && body.action !== 'reject')) {
                sendJson(res, 400, { error: '参数错误' })
                return
              }
              const ok = await resolvePending(body.id, body.action)
              if (!ok) {
                sendJson(res, 404, { error: '没有找到这条待确认修改' })
                return
              }
              sendJson(res, 200, { ok: true, items: await listPending() })
              return
            }

            if (route === '/mkdir' && req.method === 'POST') {
              const body = JSON.parse(await readBody(req)) as { path?: string }
              if (typeof body.path !== 'string' || body.path.trim() === '') {
                sendJson(res, 400, { error: '参数错误' })
                return
              }
              await mkdir(safeJoin(body.path), { recursive: true })
              scheduleAutoPush()
              sendJson(res, 200, { ok: true })
              return
            }

            if (route === '/newfile' && req.method === 'POST') {
              const body = JSON.parse(await readBody(req)) as { dir?: string; type?: string }
              const dir = body.dir && body.dir.trim() !== '' ? body.dir : ''
              const officeExt = body.type === 'docx' || body.type === 'xlsx' || body.type === 'pptx' ? body.type : null
              const isCsv = body.type === 'csv'
              const isHtml = body.type === 'html'
              const stem = officeExt
                ? { docx: '未命名文档', xlsx: '未命名表格', pptx: '未命名演示' }[officeExt]
                : isCsv ? '未命名表格' : isHtml ? '未命名网页' : '未命名文档'
              const ext = officeExt ? '.' + officeExt : isCsv ? '.csv' : isHtml ? '.html' : '.md'
              // 同名自动加序号：未命名文档-2.md、-3.md…
              let rel = ''
              let n = 1
              for (;;) {
                const candidate = join(dir, n === 1 ? stem + ext : `${stem}-${n}${ext}`)
                if (!existsSync(safeJoin(candidate))) { rel = candidate; break }
                n++
                if (n > 500) { sendJson(res, 400, { error: '同名文件过多' }); return }
              }
              await mkdir(dirname(safeJoin(rel)), { recursive: true })
              if (officeExt) {
                await writeFile(safeJoin(rel), Buffer.from(OFFICE_TEMPLATES[officeExt], 'base64'))
              } else {
                const template = isCsv
                  ? '名称,数值\n示例,1\n'
                  : isHtml
                    ? '<!DOCTYPE html>\n<html>\n<head><meta charset="utf-8"><title>未命名网页</title></head>\n<body>\n  <h1>未命名网页</h1>\n</body>\n</html>\n'
                    : '# 未命名文档\n\n'
                await writeFile(safeJoin(rel), template, 'utf8')
              }
              scheduleAutoPush()
              sendJson(res, 200, { ok: true, path: rel.replaceAll('\\', '/') })
              return
            }

            if (route === '/upload' && req.method === 'POST') {
              // 上传/导入：name 可带子路径（导入文件夹时保留结构），base64 落盘
              const body = JSON.parse(await readBody(req, 64 * 1024 * 1024)) as { dir?: string; name?: string; base64?: string }
              if (typeof body.name !== 'string' || body.name.trim() === '' || typeof body.base64 !== 'string') {
                sendJson(res, 400, { error: '参数错误' })
                return
              }
              if (body.name.includes('..')) {
                sendJson(res, 400, { error: '非法文件名' })
                return
              }
              const dir = body.dir && body.dir.trim() !== '' ? body.dir : ''
              // name 可带子路径（导入文件夹）；逐段净化，冲突策略对齐 WorkBuddy 默认 rename：同名加序号不覆盖
              const segs = body.name.split('/').map(s => s.replace(/[\\/:*?"<>|]/g, '_')).filter(s => s && s !== '.' && s !== '..')
              if (segs.length === 0) { sendJson(res, 400, { error: '非法文件名' }); return }
              const last = segs[segs.length - 1]
              const dot = last.lastIndexOf('.')
              const stemN = dot > 0 ? last.slice(0, dot) : last
              const extN = dot > 0 ? last.slice(dot) : ''
              let rel = ''
              let n = 1
              for (;;) {
                const candidate = join(dir, ...segs.slice(0, -1), n === 1 ? last : `${stemN}-${n}${extN}`)
                if (!existsSync(safeJoin(candidate))) { rel = candidate; break }
                n++
                if (n > 500) { sendJson(res, 400, { error: '同名文件过多' }); return }
              }
              const abs = safeJoin(rel)
              await mkdir(dirname(abs), { recursive: true })
              await writeFile(abs, Buffer.from(body.base64, 'base64'))
              scheduleAutoPush()
              sendJson(res, 200, { ok: true, path: rel.replaceAll('\\', '/') })
              return
            }

            if (route === '/rename' && req.method === 'POST') {
              const body = JSON.parse(await readBody(req)) as { path?: string; name?: string }
              if (typeof body.path !== 'string' || typeof body.name !== 'string'
                || body.name.trim() === '' || /[\\/:*?"<>|]/.test(body.name)) {
                sendJson(res, 400, { error: '名称为空或包含不允许的符号' })
                return
              }
              const from = safeJoin(body.path)
              if (!existsSync(from)) {
                sendJson(res, 404, { error: '文件或文件夹不存在' })
                return
              }
              const newRel = join(dirname(body.path), body.name.trim())
              await rename(from, safeJoin(newRel))
              sendJson(res, 200, { ok: true, path: newRel })
              return
            }

            if (route === '/delete' && req.method === 'POST') {
              const body = JSON.parse(await readBody(req)) as { path?: string }
              if (typeof body.path !== 'string' || body.path.trim() === '') {
                sendJson(res, 400, { error: '参数错误' })
                return
              }
              const from = safeJoin(body.path)
              if (!existsSync(from)) {
                sendJson(res, 404, { error: '文件或文件夹不存在' })
                return
              }
              // 编码原相对路径进回收站文件名，恢复时可还原位置（统一成正斜杠，Windows 传来的反斜杠路径也要能删）
              await mkdir(TRASH_DIR, { recursive: true })
              const trashName = body.path.replaceAll('\\', '/').replaceAll('/', '%2F') + '.' + Date.now() + '.trash'
              await rename(from, join(TRASH_DIR, trashName))
              scheduleAutoPush()
              sendJson(res, 200, { ok: true })
              return
            }

            if (route === '/trash' && req.method === 'GET') {
              if (!existsSync(TRASH_DIR)) {
                sendJson(res, 200, { items: [] })
                return
              }
              const raw = (await readdir(TRASH_DIR)).filter(f => f.endsWith('.trash'))
              const items = await Promise.all(raw.map(async f => {
                // 文件名形如 <url编码后的原路径>.<删除时间戳>.trash
                const base = f.slice(0, -'.trash'.length)
                const dot = base.lastIndexOf('.')
                const originalPath = base.slice(0, dot).replaceAll('%2F', '/')
                const deletedAt = Number(base.slice(dot + 1)) || 0
                let kind: 'file' | 'directory' = 'file'
                let size: number | undefined
                try {
                  const st = statSync(join(TRASH_DIR, f))
                  kind = st.isDirectory() ? 'directory' : 'file'
                  if (kind === 'file') size = st.size
                } catch {}
                return { name: f, originalPath, deletedAt, kind, size }
              }))
              items.sort((a, b) => b.deletedAt - a.deletedAt)
              sendJson(res, 200, { items })
              return
            }

            if (route === '/trash-restore' && req.method === 'POST') {
              const body = JSON.parse(await readBody(req)) as { name?: string; names?: string[] }
              const single = typeof body.name === 'string' && !Array.isArray(body.names)
              const raw = Array.isArray(body.names) ? body.names : single ? [body.name] : []
              const names = raw.filter((n): n is string => typeof n === 'string' && n.endsWith('.trash') && basename(n) === n)
              if (raw.length === 0 || names.length !== raw.length) {
                sendJson(res, 400, { error: '参数错误' })
                return
              }
              let ok = 0
              const failed: { name: string; error: string; status: number }[] = []
              for (const name of names) {
                try {
                  const trashFile = join(TRASH_DIR, name)
                  if (!existsSync(trashFile)) {
                    failed.push({ name, error: '回收站里没有这个文件', status: 404 })
                    continue
                  }
                  /* 文件名形如 <url编码后的原路径>.<删除时间戳>.trash，恢复时要一并剥掉时间戳 */
                  const base = basename(name, '.trash')
                  const dot = base.lastIndexOf('.')
                  const originalRel = (dot > 0 ? base.slice(0, dot) : base).replaceAll('%2F', '/')
                  const dest = safeJoin(originalRel)
                  if (existsSync(dest)) {
                    failed.push({ name, error: '原位置已有同名文件，请先改名或移走后再恢复', status: 409 })
                    continue
                  }
                  await mkdir(dirname(dest), { recursive: true })
                  await rename(trashFile, dest)
                  ok++
                } catch (e) {
                  failed.push({ name, error: (e as Error).message || '恢复失败', status: 500 })
                }
              }
              if (single) {
                const f = failed[0]
                if (f) {
                  sendJson(res, f.status, { error: f.error })
                  return
                }
                scheduleAutoPush()
                sendJson(res, 200, { ok: true })
                return
              }
              if (ok > 0) scheduleAutoPush()
              sendJson(res, 200, { ok, failed: failed.map(f => ({ name: f.name, error: f.error })) })
              return
            }

            if (route === '/trash-purge' && req.method === 'POST') {
              const body = JSON.parse(await readBody(req)) as { name?: string; names?: string[] }
              const single = typeof body.name === 'string' && !Array.isArray(body.names)
              const raw = Array.isArray(body.names) ? body.names : single ? [body.name] : []
              const names = raw.filter((n): n is string => typeof n === 'string' && n.endsWith('.trash') && basename(n) === n)
              if (raw.length === 0 || names.length !== raw.length) {
                sendJson(res, 400, { error: '参数错误' })
                return
              }
              let ok = 0
              const failed: { name: string; error: string; status: number }[] = []
              for (const name of names) {
                try {
                  const target = join(TRASH_DIR, name)
                  if (!existsSync(target)) {
                    failed.push({ name, error: '回收站里没有这个文件', status: 404 })
                    continue
                  }
                  await rm(target, { recursive: true, force: true })
                  ok++
                } catch (e) {
                  failed.push({ name, error: (e as Error).message || '删除失败', status: 500 })
                }
              }
              if (single) {
                const f = failed[0]
                if (f) {
                  sendJson(res, f.status, { error: f.error })
                  return
                }
                sendJson(res, 200, { ok: true })
                return
              }
              sendJson(res, 200, { ok, failed: failed.map(f => ({ name: f.name, error: f.error })) })
              return
            }

            if (route === '/move' && req.method === 'POST') {
              const body = JSON.parse(await readBody(req)) as { path?: string; targetDir?: string }
              if (typeof body.path !== 'string' || typeof body.targetDir !== 'string') {
                sendJson(res, 400, { error: '参数错误' })
                return
              }
              const from = safeJoin(body.path)
              if (!existsSync(from)) {
                sendJson(res, 404, { error: '文件或文件夹不存在' })
                return
              }
              const name = basename(body.path)
              const destDir = body.targetDir === '' ? LIBRARY_ROOT : safeJoin(body.targetDir)
              if (!existsSync(destDir)) {
                sendJson(res, 404, { error: '目标文件夹不存在' })
                return
              }
              // 同名自动加序号
              let dest = join(destDir, name)
              if (dest !== from) {
                let n = 1
                while (existsSync(dest)) {
                  const dot = name.lastIndexOf('.')
                  const stem = dot > 0 ? name.slice(0, dot) : name
                  const ext = dot > 0 ? name.slice(dot) : ''
                  dest = join(destDir, `${stem}-${n}${ext}`)
                  n++
                }
                await rename(from, dest)
              }
              sendJson(res, 200, { ok: true, path: relative(LIBRARY_ROOT, dest).replaceAll('\\', '/') })
              return
            }

            if (route === '/cloud/config' && req.method === 'GET') {
              const cfg = await loadCloudConfig()
              if (!cfg) { sendJson(res, 200, { configured: false }); return }
              sendJson(res, 200, {
                configured: true,
                config: { ...cfg, accessKey: cfg.accessKey, secretKey: '__keep__' },
              })
              return
            }

            if (route === '/cloud/config' && req.method === 'POST') {
              const body = JSON.parse(await readBody(req)) as Partial<CloudConfig>
              if (body.protocol !== 's3' && body.protocol !== 'webdav' && body.protocol !== 'cos') {
                sendJson(res, 400, { error: '协议只支持 s3 / cos / webdav' })
                return
              }
              if (typeof body.endpoint !== 'string' || !/^https?:\/\//.test(body.endpoint)) {
                sendJson(res, 400, { error: '地址要以 http(s):// 开头' })
                return
              }
              const old = await loadCloudConfig()
              const cfg: CloudConfig = {
                protocol: body.protocol,
                endpoint: body.endpoint,
                bucket: body.bucket || undefined,
                prefix: body.prefix || undefined,
                region: body.region || undefined,
                accessKey: typeof body.accessKey === 'string' ? body.accessKey : (old?.accessKey ?? ''),
                secretKey: body.secretKey === '__keep__' || body.secretKey === undefined ? (old?.secretKey ?? '') : body.secretKey,
                autoPush: !!body.autoPush,
              }
              if (!cfg.accessKey) { sendJson(res, 400, { error: '访问账号不能为空' }); return }
              await saveCloudConfig(cfg)
              scheduleAutoPush()
              sendJson(res, 200, { ok: true })
              return
            }

            if (route === '/cloud/test' && req.method === 'POST') {
              const cfg = await loadCloudConfig()
              if (!cfg) { sendJson(res, 400, { error: '还没配置云同步' }); return }
              sendJson(res, 200, await testCloud(cfg))
              return
            }

            if (route === '/cloud/sync' && req.method === 'POST') {
              const cfg = await loadCloudConfig()
              if (!cfg) { sendJson(res, 400, { error: '还没配置云同步' }); return }
              sendJson(res, 200, await syncNow(cfg))
              return
            }

            if (route === '/cloud/push' && req.method === 'POST') {
              // 单文件推送：库内文件直接推；会话产物先落到库根再推
              const body = JSON.parse(await readBody(req)) as { path?: string; abs?: boolean }
              const cfg = await loadCloudConfig()
              if (!cfg) { sendJson(res, 400, { error: '还没配置云同步，请先打开「云同步」填写 COS 信息' }); return }
              const relKey = await resolveUploadTarget(body.path, body.abs === true)
              await pushFile(cfg, relKey)
              sendJson(res, 200, { ok: true, path: relKey })
              return
            }

            if (route === '/share' && req.method === 'POST') {
              const body = JSON.parse(await readBody(req)) as { path?: string; abs?: boolean }
              const cfg = await loadCloudConfig()
              if (!cfg) { sendJson(res, 400, { error: '还没配置云同步，请先打开「云同步」填写 COS 信息' }); return }
              const relKey = await resolveUploadTarget(body.path, body.abs === true)
              await pushFile(cfg, relKey)
              const url = presignCosGet(cfg, relKey, 7 * 86400)
              sendJson(res, 200, { ok: true, url, expiresDays: 7 })
              return
            }

            res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'unknown route' }))
          } catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    'dsh-wb-desk: routes',
  )
}

export { PENDING_DIR }
