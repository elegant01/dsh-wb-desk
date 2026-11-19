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
import { readdir, readFile, rename, writeFile, mkdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { LIBRARY_ROOT, PENDING_DIR, TRASH_DIR } from './store.js'
import { listPending, resolvePending } from './pending.js'
import { listActivePins, releasePin } from './pins.js'
import { readArtifacts } from './artifacts.js'
import { loadCloudConfig, saveCloudConfig, syncNow, testCloud, scheduleAutoPush, type CloudConfig } from './cloud.js'

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

            if (route === '/tree' && req.method === 'GET') {
              if (!existsSync(LIBRARY_ROOT)) {
                sendJson(res, 200, { items: [] })
                return
              }
              sendJson(res, 200, { items: await buildTree(LIBRARY_ROOT, '', 8) })
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
              sendJson(res, 200, { items: await readArtifacts() })
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
              const dir = body.dir && body.dir.trim() !== '' ? body.dir : 'inbox'
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
              sendJson(res, 200, { ok: true, path: rel })
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
              const dir = body.dir && body.dir.trim() !== '' ? body.dir : 'inbox'
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
              // 编码原相对路径进回收站文件名，恢复时可还原位置
              await mkdir(TRASH_DIR, { recursive: true })
              const trashName = body.path.replaceAll('/', '%2F') + '.' + Date.now() + '.trash'
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
              const items = (await readdir(TRASH_DIR)).filter(f => f.endsWith('.trash')).reverse()
                .map(f => {
                  const dot = f.lastIndexOf('.')
                  const encoded = f.slice(0, dot)
                  return { name: f, originalPath: encoded.replaceAll('%2F', '/') }
                })
              sendJson(res, 200, { items })
              return
            }

            if (route === '/trash-restore' && req.method === 'POST') {
              const body = JSON.parse(await readBody(req)) as { name?: string }
              if (typeof body.name !== 'string' || !body.name.endsWith('.trash')) {
                sendJson(res, 400, { error: '参数错误' })
                return
              }
              const trashFile = join(TRASH_DIR, basename(body.name))
              if (!existsSync(trashFile)) {
                sendJson(res, 404, { error: '回收站里没有这个文件' })
                return
              }
              const originalRel = basename(body.name, '.trash').replaceAll('%2F', '/')
              const dest = safeJoin(originalRel)
              await mkdir(dirname(dest), { recursive: true })
              await rename(trashFile, dest)
              scheduleAutoPush()
              sendJson(res, 200, { ok: true })
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
