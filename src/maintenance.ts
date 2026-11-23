/**
 * 定期维护：回收站过期条目 + 固定引用快照。
 * 宿主启动时跑一次，之后每 6 小时一次；保存自动化设置时也会立即跑一次。
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { TRASH_DIR } from './store.js'
import { cleanupPins } from './pins.js'
import { loadConfig } from './config.js'

export const TRASH_RETENTION_DAYS = 30
const DAY_MS = 86400e3

/** 回收站文件名形如 <url编码路径>.<删除时间戳>.trash；解析不出时间戳时退回 mtime。 */
export async function cleanupTrash(now = Date.now()): Promise<number> {
  if (!existsSync(TRASH_DIR)) return 0
  let removed = 0
  let files: string[] = []
  try {
    files = (await readdir(TRASH_DIR)).filter(f => f.endsWith('.trash'))
  } catch {
    return 0
  }
  for (const f of files) {
    const p = join(TRASH_DIR, f)
    const base = f.slice(0, -'.trash'.length)
    const ts = Number(base.slice(base.lastIndexOf('.') + 1))
    let deletedAt = Number.isFinite(ts) && ts > 0 ? ts : 0
    if (!deletedAt) {
      try { deletedAt = (await stat(p)).mtimeMs } catch { continue }
    }
    if (now - deletedAt <= TRASH_RETENTION_DAYS * DAY_MS) continue
    try {
      await rm(p, { recursive: true, force: true })
      removed++
    } catch {
      // 单个失败不影响其他条目
    }
  }
  return removed
}

export interface MaintenanceResult { pins: number; trash: number }

export async function runMaintenance(): Promise<MaintenanceResult> {
  const cfg = await loadConfig().catch(() => null)
  let pins = 0
  let trash = 0
  try { pins = await cleanupPins(cfg?.pinRetentionDays ?? 7) } catch { /* 清理失败不影响主流程 */ }
  try { trash = await cleanupTrash() } catch { /* 同上 */ }
  return { pins, trash }
}
