/**
 * 自动化配置（.dsh-library/config.json）：
 * - placement.rules：库外新建产物按「会话 → 工作区 → 默认 inbox」的顺序归位；
 * - pinRetentionDays：固定引用快照在会话结束后保留的天数。
 *
 * 规则只在归位那一刻读取，改完即时生效，不需要重启宿主。
 */
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { META_DIR } from './store.js'

export interface PlacementRule {
  /** 工作区名（会话 cwd 的目录名），可空。 */
  ws?: string
  /** 会话标识前缀，优先级高于工作区规则，可空。 */
  session?: string
  /** 库内目标目录，如 projects/foo。 */
  dir: string
}

export interface DeskConfig {
  placement: { rules: PlacementRule[] }
  pinRetentionDays: number
}

export const DEFAULT_PIN_RETENTION_DAYS = 7
const MAX_RULES = 50

const CONFIG_FILE = join(META_DIR, 'config.json')

function cleanText(input: unknown, max = 120): string {
  if (typeof input !== 'string') return ''
  return input.trim().replace(/[\u0000-\u001f]/g, '').slice(0, max)
}

/** 目标目录净化：统一正斜杠、去掉头尾斜杠、拒绝 .. 与插件元数据目录。 */
export function cleanDir(input: unknown): string {
  if (typeof input !== 'string') return ''
  const norm = input.replaceAll('\\', '/').trim().replace(/^\/+|\/+$/g, '')
  if (!norm) return ''
  const segs = norm.split('/')
  if (segs.some(s => s === '' || s === '.' || s === '..')) return ''
  if (segs[0] === '.dsh-library') return ''
  return segs.join('/')
}

function cleanDays(input: unknown): number {
  const n = typeof input === 'number' ? input : Number(input)
  if (!Number.isFinite(n)) return DEFAULT_PIN_RETENTION_DAYS
  return Math.min(365, Math.max(1, Math.round(n)))
}

/** 宽松收编外部输入（POST 也可以只带部分字段；磁盘上的旧结构 placement.rules 同样接受）。 */
export function sanitizeConfig(input: unknown): DeskConfig {
  const raw = (input ?? {}) as { rules?: unknown; placement?: { rules?: unknown }; pinRetentionDays?: unknown }
  const list = Array.isArray(raw.rules)
    ? raw.rules
    : Array.isArray(raw.placement?.rules) ? raw.placement.rules : []
  const rules: PlacementRule[] = []
  for (const item of list.slice(0, MAX_RULES)) {
    const r = (item ?? {}) as Record<string, unknown>
    const ws = cleanText(r.ws)
    const session = cleanText(r.session)
    const dir = cleanDir(r.dir)
    if (!dir || (!ws && !session)) continue
    rules.push({ ...(ws ? { ws } : {}), ...(session ? { session } : {}), dir })
  }
  return { placement: { rules }, pinRetentionDays: cleanDays(raw.pinRetentionDays) }
}

export async function loadConfig(): Promise<DeskConfig> {
  try {
    return sanitizeConfig(JSON.parse(await readFile(CONFIG_FILE, 'utf8')))
  } catch {
    return sanitizeConfig({})
  }
}

export async function saveConfig(input: unknown): Promise<DeskConfig> {
  const cfg = sanitizeConfig(input)
  await mkdir(META_DIR, { recursive: true })
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8')
  return cfg
}

/**
 * 按规则决定新产物落点：会话前缀命中优先，其次工作区名命中，都没有则 inbox。
 * 返回库内相对目录（已净化，可直接 join）。
 */
export async function resolvePlacementDir(ctx: { sessionId?: string; wsName?: string }): Promise<string> {
  const cfg = await loadConfig()
  const sessionId = ctx.sessionId && ctx.sessionId !== '未知会话' ? ctx.sessionId : ''
  const ws = (ctx.wsName || '').toLowerCase()
  for (const r of cfg.placement.rules) {
    if (r.session && sessionId && sessionId.startsWith(r.session)) return r.dir
  }
  if (ws) {
    for (const r of cfg.placement.rules) {
      if (r.ws && r.ws.toLowerCase() === ws) return r.dir
    }
  }
  return 'inbox'
}
