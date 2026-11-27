/**
 * dsh-wb-desk 云同步：单用户、本地优先、云端镜像。
 *
 * 语义（刻意简单，单用户场景够用）：
 *   - 本地库永远是主库，读写都走本地；云端是镜像
 *   - syncUp：本地新/改 → 传云端；syncDown：云端新/改 → 拉回本地（按最后修改时间比较）
 *   - 删除不传播（任何一端删文件不会同步删另一端，防误删）
 *   - 插件元数据目录 .dsh-library/ 不参与同步（pending/pins 是本地语义）
 *
 * 支持两种「云存储地址」：
 *   - S3 兼容：阿里 OSS / 腾讯 COS / AWS S3 / Cloudflare R2 / MinIO（SigV4 签名，纯 crypto 实现）
 *   - WebDAV：坚果云 / NAS / Nextcloud（Basic auth + PROPFIND/GET/PUT/MKCOL）
 *
 * 配置存 META_DIR/cloud.json（本机明文，与 npmrc 同级风险；别提交进 git）。
 */
import { createHmac, createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { readdir, readFile, writeFile, mkdir, stat, utimes } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { LIBRARY_ROOT, META_DIR } from './store.js'

export interface CloudConfig {
  protocol: 's3' | 'cos' | 'webdav'
  endpoint: string
  bucket?: string
  prefix?: string
  region?: string
  accessKey: string
  secretKey: string
  autoPush?: boolean
  /** S3 路径风格（七牛 Kodo / MinIO 等只支持 path-style 的服务）。 */
  pathStyle?: boolean
}

const CONFIG_FILE = join(META_DIR, 'cloud.json')

export async function loadCloudConfig(): Promise<CloudConfig | null> {
  try {
    const cfg = JSON.parse(await readFile(CONFIG_FILE, 'utf8')) as CloudConfig
    if (!cfg.endpoint || !cfg.accessKey) return null
    return cfg
  } catch {
    return null
  }
}

export async function saveCloudConfig(cfg: CloudConfig): Promise<void> {
  await mkdir(META_DIR, { recursive: true })
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8')
}

interface RemoteEntry {
  key: string
  size: number
  lastmod: number
}

function prefixOf(cfg: CloudConfig): string {
  const p = (cfg.prefix || 'dsh-library').replace(/^\/+|\/+$/g, '')
  return p ? p + '/' : ''
}
/** 列表键统一为去掉前缀的相对键；上传/下载键统一加前缀。 */
function toRelKey(cfg: CloudConfig, key: string): string {
  const k = key.replace(/^\/+/, '')
  const p = prefixOf(cfg)
  return k.startsWith(p) ? k.slice(p.length) : k
}

/* ── S3（SigV4）── */
function sha256hex(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex')
}
function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest()
}
function s3Host(cfg: CloudConfig): { host: string; basePath: string } {
  const u = new URL(cfg.endpoint)
  return { host: cfg.bucket ? `${cfg.bucket}.${u.host}` : u.host, basePath: u.pathname.replace(/\/+$/, '') }
}
/**
 * 请求目标：默认 virtual-hosted（bucket 进域名），pathStyle 时 bucket 进路径
 * （七牛 Kodo / 多数自建 MinIO 只支持这种）。
 */
function s3Target(cfg: CloudConfig): { host: string; basePath: string; bucketPath: string } {
  const u = new URL(cfg.endpoint)
  const pathStyle = !!cfg.pathStyle && !!cfg.bucket
  return {
    host: cfg.bucket && !pathStyle ? `${cfg.bucket}.${u.host}` : u.host,
    basePath: u.pathname.replace(/\/+$/, ''),
    bucketPath: pathStyle ? '/' + encodeKey(cfg.bucket!) : '',
  }
}
function s3Region(cfg: CloudConfig): string {
  if (cfg.region && cfg.region.trim()) return cfg.region.trim()
  const m = s3Host(cfg).host.match(/(?:oss|cos)\.([a-z0-9-]+)\./) || s3Host(cfg).host.match(/\.([a-z0-9-]+)\.amazonaws\./)
  return m ? m[1] : 'us-east-1'
}
function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}
async function s3Request(cfg: CloudConfig, method: string, key: string, query: Record<string, string>, body?: Buffer): Promise<{ status: number; buffer: Buffer }> {
  const { host, basePath, bucketPath } = s3Target(cfg)
  const region = s3Region(cfg)
  const now = new Date()
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = sha256hex(body ?? '')
  // path-style 列桶时不带尾部斜杠；带 key 时拼在 bucket 之后
  const path = basePath + bucketPath + (key ? '/' + encodeKey(key) : bucketPath ? '' : '/')
  const sortedQuery = Object.keys(query).sort()
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(query[k])).join('&')
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
  const canonicalRequest = [method, path, sortedQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${dateStamp}/${region}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n')
  const kDate = hmac('AWS4' + cfg.secretKey, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, 's3')
  const kSigning = hmac(kService, 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')
  const res = await fetch(`https://${host}${path}${sortedQuery ? '?' + sortedQuery : ''}`, {
    method,
    headers: {
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body,
  })
  return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()) }
}

async function s3List(cfg: CloudConfig): Promise<RemoteEntry[]> {
  const out: RemoteEntry[] = []
  let token = ''
  for (;;) {
    const query: Record<string, string> = { 'list-type': '2', 'max-keys': '1000', prefix: prefixOf(cfg) }
    if (token) query['continuation-token'] = token
    const r = await s3Request(cfg, 'GET', '', query)
    const text = r.buffer.toString('utf8')
    if (r.status !== 200) throw new Error(`列出失败（HTTP ${r.status}）：${text.slice(0, 200)}`)
    const blocks = text.match(/<Contents>[\s\S]*?<\/Contents>/g) || []
    for (const b of blocks) {
      const key = decodeURIComponent(b.match(/<Key>([\s\S]*?)<\/Key>/)?.[1] ?? '')
      const relKey = toRelKey(cfg, key)
      const size = Number(b.match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0)
      const lastmod = Date.parse(b.match(/<LastModified>([^<]+)<\/LastModified>/)?.[1] ?? '') || 0
      if (relKey && !relKey.endsWith('/')) out.push({ key: relKey, size, lastmod })
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(text)
    token = text.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] ?? ''
    if (!truncated || !token) break
  }
  return out
}

/* ── 腾讯云 COS（q-signature，HMAC-SHA1）── */
function sha1hex(s: string): string {
  return createHash('sha1').update(s).digest('hex')
}
async function cosRequest(cfg: CloudConfig, method: string, key: string, query: Record<string, string>, body?: Buffer): Promise<{ status: number; buffer: Buffer }> {
  if (!cfg.bucket) throw new Error('COS 需要填 Bucket（存储桶名-APPID）')
  const host = `${cfg.bucket}.${new URL(cfg.endpoint).host}`
  // 实测（2026-11-19 真账号）：COS 签名用未编码原始路径，线上请求用编码路径
  const signPath = key ? '/' + key : '/'
  const wirePath = key ? '/' + encodeKey(key) : '/'
  // 参数与头按字典序、key 小写、value 编码后参与签名
  const paramPairs = Object.keys(query).sort().map(k => [k.toLowerCase(), query[k]] as const)
  const headerPairs = [['host', host] as const]
  const fmt = (pairs: readonly (readonly [string, string])[]) =>
    pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
  const list = (pairs: readonly (readonly [string, string])[]) =>
    pairs.map(([k]) => encodeURIComponent(k)).join(';')
  const nowSec = Math.floor(Date.now() / 1000)
  const keyTime = `${nowSec - 60};${nowSec + 600}`
  const httpString = [method.toLowerCase(), signPath, fmt(paramPairs), fmt(headerPairs), ''].join('\n')
  const stringToSign = `sha1\n${keyTime}\n${sha1hex(httpString)}\n`
  const signKey = createHmac('sha1', cfg.secretKey).update(keyTime).digest('hex')
  const signature = createHmac('sha1', signKey).update(stringToSign).digest('hex')
  const auth = `q-sign-algorithm=sha1&q-ak=${encodeURIComponent(cfg.accessKey)}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=${list(headerPairs)}&q-url-param-list=${list(paramPairs)}&q-signature=${signature}`
  const qs = Object.keys(query).sort().map(k => encodeURIComponent(k) + '=' + encodeURIComponent(query[k])).join('&')
  const res = await fetch(`https://${host}${wirePath}${qs ? '?' + qs : ''}`, {
    method,
    headers: { authorization: auth },
    body,
  })
  return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()) }
}

async function cosList(cfg: CloudConfig): Promise<RemoteEntry[]> {
  const out: RemoteEntry[] = []
  let marker = ''
  for (;;) {
    const query: Record<string, string> = { prefix: prefixOf(cfg), 'max-keys': '1000' }
    if (marker) query.marker = marker
    const r = await cosRequest(cfg, 'GET', '', query)
    const text = r.buffer.toString('utf8')
    if (r.status !== 200) throw new Error(`列出失败（HTTP ${r.status}）：${text.slice(0, 200)}`)
    const blocks = text.match(/<Contents>[\s\S]*?<\/Contents>/g) || []
    for (const b of blocks) {
      const key = decodeURIComponent(b.match(/<Key>([\s\S]*?)<\/Key>/)?.[1] ?? '')
      const relKey = toRelKey(cfg, key)
      const size = Number(b.match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0)
      const lastmod = Date.parse(b.match(/<LastModified>([^<]+)<\/LastModified>/)?.[1] ?? '') || 0
      if (relKey && !relKey.endsWith('/')) out.push({ key: relKey, size, lastmod })
    }
    if (!/<IsTruncated>true<\/IsTruncated>/.test(text)) break
    marker = text.match(/<NextMarker>([^<]+)<\/NextMarker>/)?.[1] ?? ''
    if (!marker) break
  }
  return out
}

/* ── WebDAV ── */
function davAuth(cfg: CloudConfig): string {
  return 'Basic ' + Buffer.from(`${cfg.accessKey}:${cfg.secretKey}`).toString('base64')
}
function davUrl(cfg: CloudConfig, key: string): string {
  return cfg.endpoint.replace(/\/+$/, '') + '/' + encodeKey(prefixOf(cfg) + key)
}
async function davList(cfg: CloudConfig): Promise<RemoteEntry[]> {
  const res = await fetch(davUrl(cfg, ''), {
    method: 'PROPFIND',
    headers: { authorization: davAuth(cfg), depth: '1', 'content-type': 'application/xml' },
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/><d:getcontentlength/><d:resourcetype/></d:prop></d:propfind>',
  })
  if (res.status === 404) return [] // 前缀目录还没建过 = 空
  if (res.status !== 207) throw new Error(`列出失败（HTTP ${res.status}）：${(await res.text()).slice(0, 200)}`)
  const text = await res.text()
  const out: RemoteEntry[] = []
  const baseHref = new URL(davUrl(cfg, '')).pathname.replace(/\/+$/, '') + '/'
  for (const m of text.matchAll(/<d:response>([\s\S]*?)<\/d:response>/g)) {
    const block = m[1]
    if (/<d:collection/.test(block)) continue
    const href = decodeURIComponent(block.match(/<d:href>([^<]+)<\/d:href>/)?.[1] ?? '')
    if (!href.startsWith(baseHref)) continue
    const key = href.slice(baseHref.length)
    if (!key) continue
    const size = Number(block.match(/<d:getcontentlength>(\d+)<\/d:getcontentlength>/)?.[1] ?? 0)
    const lastmod = Date.parse(block.match(/<d:getlastmodified>([^<]+)<\/d:getlastmodified>/)?.[1] ?? '') || 0
    out.push({ key, size, lastmod })
  }
  return out
}

/* ── 协议无关封装 ── */
async function remoteList(cfg: CloudConfig): Promise<RemoteEntry[]> {
  return cfg.protocol === 's3' ? s3List(cfg) : cfg.protocol === 'cos' ? cosList(cfg) : davList(cfg)
}
async function remoteGet(cfg: CloudConfig, key: string): Promise<Buffer> {
  const fullKey = prefixOf(cfg) + key
  if (cfg.protocol === 's3') {
    const r = await s3Request(cfg, 'GET', fullKey, {})
    if (r.status !== 200) throw new Error(`下载失败（HTTP ${r.status}）`)
    return r.buffer
  }
  if (cfg.protocol === 'cos') {
    const r = await cosRequest(cfg, 'GET', fullKey, {})
    if (r.status !== 200) throw new Error(`下载失败（HTTP ${r.status}）`)
    return r.buffer
  }
  const res = await fetch(davUrl(cfg, key), { headers: { authorization: davAuth(cfg) } })
  if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`)
  return Buffer.from(await res.arrayBuffer())
}
async function remotePut(cfg: CloudConfig, key: string, body: Buffer): Promise<void> {
  const fullKey = prefixOf(cfg) + key
  if (cfg.protocol === 's3') {
    const r = await s3Request(cfg, 'PUT', fullKey, {}, body)
    if (r.status !== 200) throw new Error(`上传失败（HTTP ${r.status}）：${r.buffer.toString('utf8').slice(0, 200)}`)
    return
  }
  if (cfg.protocol === 'cos') {
    const r = await cosRequest(cfg, 'PUT', fullKey, {}, body)
    if (r.status !== 200) throw new Error(`上传失败（HTTP ${r.status}）：${r.buffer.toString('utf8').slice(0, 200)}`)
    return
  }
  // WebDAV：先补建父目录（MKCOL 已存在会 405，忽略）
  const segs = key.split('/').slice(0, -1)
  let cur = ''
  for (const seg of segs) {
    cur = cur ? cur + '/' + seg : seg
    await fetch(cfg.endpoint.replace(/\/+$/, '') + '/' + encodeKey(prefixOf(cfg) + cur), {
      method: 'MKCOL', headers: { authorization: davAuth(cfg) },
    }).catch(() => {})
  }
  const res = await fetch(davUrl(cfg, key), { method: 'PUT', headers: { authorization: davAuth(cfg) }, body })
  if (!res.ok && res.status !== 201 && res.status !== 204) throw new Error(`上传失败（HTTP ${res.status}）`)
}

/* ── 本地遍历（跳过 .dsh-library 等隐藏目录与 inbox Agent 产物区）── */
interface LocalEntry { rel: string; size: number; mtime: number }
async function localList(): Promise<LocalEntry[]> {
  const out: LocalEntry[] = []
  async function walk(dir: string, rel: string): Promise<void> {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (rel === '' && entry.name === 'inbox') continue // inbox 是本地产物区，只留在本地，不镜像上云
      const abs = join(dir, entry.name)
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(abs, relPath)
      else if (entry.isFile()) {
        try {
          const st = await stat(abs)
          out.push({ rel: relPath, size: st.size, mtime: st.mtimeMs })
        } catch { /* 竞态删除跳过 */ }
      }
    }
  }
  await walk(LIBRARY_ROOT, '')
  return out
}

/* ── 单文件推送与分享链接 ── */
/** 把库内单个文件推到云端（relKey 为库内相对路径）。 */
export async function pushFile(cfg: CloudConfig, relKey: string): Promise<void> {
  const abs = join(LIBRARY_ROOT, relKey)
  await remotePut(cfg, relKey, await readFile(abs))
}

/**
 * 生成 COS 预签名 GET 链接（带过期时间）。
 * 签名进查询参数：q-url-param-list 为空、q-header-list=host，
 * 规范串与线上 query 用同一套编码（对齐 cos-js-sdk-v5 的 getAuth 行为）。
 */
export function presignCosGet(cfg: CloudConfig, relKey: string, expiresSec: number): string {
  if (cfg.protocol !== 'cos') throw new Error('分享链接目前仅支持腾讯云 COS')
  if (!cfg.bucket) throw new Error('COS 需要填 Bucket（存储桶名-APPID）')
  const host = `${cfg.bucket}.${new URL(cfg.endpoint).host}`
  const fullKey = prefixOf(cfg) + relKey
  const signPath = '/' + fullKey
  const wirePath = '/' + encodeKey(fullKey)
  const nowSec = Math.floor(Date.now() / 1000)
  const keyTime = `${nowSec - 60};${nowSec + expiresSec}`
  const query: Record<string, string> = {
    'q-sign-algorithm': 'sha1',
    'q-ak': cfg.accessKey,
    'q-sign-time': keyTime,
    'q-key-time': keyTime,
    'q-header-list': 'host',
    'q-url-param-list': '',
  }
  const encodePairs = (pairs: readonly (readonly [string, string])[]) =>
    pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
  // 规范串只覆盖「业务参数 + 声明的 Headers」，auth 参数本身不进签名
  const headerPairs = [['host', host] as const]
  const httpString = ['get', signPath, '', encodePairs(headerPairs), ''].join('\n')
  const stringToSign = `sha1\n${keyTime}\n${sha1hex(httpString)}\n`
  const signKey = createHmac('sha1', cfg.secretKey).update(keyTime).digest('hex')
  const signature = createHmac('sha1', signKey).update(stringToSign).digest('hex')
  const qs = Object.keys(query).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join('&')
  return `https://${host}${wirePath}?${qs}&q-signature=${signature}`
}

export interface SyncResult {
  pushed: number
  pulled: number
  skipped: number
  errors: string[]
}

const SKEW_MS = 2000 // 本地 mtime 与云端 lastmod 的时钟误差容忍

/** 双向镜像：本地新的推上去，云端新的拉下来；删除不传播。 */
export async function syncNow(cfg: CloudConfig): Promise<SyncResult> {
  const [remote, local] = await Promise.all([remoteList(cfg), localList()])
  const remoteMap = new Map(remote.map(r => [r.key, r]))
  const localMap = new Map(local.map(l => [l.rel, l]))
  const result: SyncResult = { pushed: 0, pulled: 0, skipped: 0, errors: [] }

  for (const l of local) {
    const r = remoteMap.get(l.rel)
    const needPush = !r || r.lastmod < l.mtime - SKEW_MS || (r.size !== l.size && Math.abs(r.lastmod - l.mtime) > SKEW_MS)
    if (!needPush) { result.skipped++; continue }
    try {
      await remotePut(cfg, l.rel, await readFile(join(LIBRARY_ROOT, l.rel)))
      result.pushed++
    } catch (e) {
      result.errors.push(`${l.rel}：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  for (const r of remote) {
    if (r.key === 'inbox' || r.key.startsWith('inbox/')) { result.skipped++; continue } // 历史遗留的 inbox 镜像不回拉
    const l = localMap.get(r.key)
    const needPull = !l || l.mtime < r.lastmod - SKEW_MS
    if (!needPull) { result.skipped++; continue }
    try {
      const abs = join(LIBRARY_ROOT, r.key)
      if (r.key.includes('..')) { result.errors.push(`${r.key}：非法路径，跳过`); continue }
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, await remoteGet(cfg, r.key))
      await utimes(abs, new Date(), new Date(r.lastmod)) // mtime 对齐云端，避免来回互推
      result.pulled++
    } catch (e) {
      result.errors.push(`${r.key}：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return result
}

/** 连通性测试：列出前缀内容即可。 */
export async function testCloud(cfg: CloudConfig): Promise<{ ok: boolean; detail: string }> {
  try {
    const items = await remoteList(cfg)
    return { ok: true, detail: `连接成功，云端前缀下已有 ${items.length} 个文件` }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

/* ── 同步状态（面板状态灯用；只在内存，重启归零）── */
export type CloudSyncState = 'idle' | 'syncing' | 'ok' | 'error'
export interface CloudSyncStatus {
  state: CloudSyncState
  /** 最近一次状态变化的时间戳（毫秒）。 */
  at: number
  pushed: number
  pulled: number
  errors: number
  /** 失败时的第一条错误，供状态灯 title 展示。 */
  detail?: string
}
let lastStatus: CloudSyncStatus = { state: 'idle', at: 0, pushed: 0, pulled: 0, errors: 0 }

export function cloudSyncStatus(): CloudSyncStatus {
  return { ...lastStatus }
}

export function markSyncStarted(): void {
  lastStatus = { ...lastStatus, state: 'syncing', at: Date.now(), detail: undefined }
}

export function markSyncResult(r: SyncResult): void {
  lastStatus = {
    state: r.errors.length ? 'error' : 'ok',
    at: Date.now(),
    pushed: r.pushed,
    pulled: r.pulled,
    errors: r.errors.length,
    detail: r.errors[0],
  }
}

export function markSyncFailed(message: string): void {
  lastStatus = { ...lastStatus, state: 'error', at: Date.now(), detail: message }
}

/* ── 自动推送（防抖，写操作后调用）── */
let pushTimer: ReturnType<typeof setTimeout> | null = null
let pushing = false
export function scheduleAutoPush(onDone?: (r: SyncResult | null) => void): void {
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(async () => {
    if (pushing) return
    pushing = true
    try {
      const cfg = await loadCloudConfig()
      if (cfg && cfg.autoPush) {
        markSyncStarted()
        try {
          const r = await syncNow(cfg)
          markSyncResult(r)
          onDone?.(r)
        } catch (e) {
          // 失败对本地写入仍静默，但要让面板状态灯看见
          markSyncFailed(e instanceof Error ? e.message : String(e))
        }
      }
    } catch {
      // 读配置失败等：同步失败绝不影响本地写入
    } finally {
      pushing = false
    }
  }, 5000)
}

export { CONFIG_FILE }
export function configExists(): boolean {
  return existsSync(CONFIG_FILE)
}
