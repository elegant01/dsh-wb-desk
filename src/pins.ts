/**
 * 固定修订引用（需求文档 3.3）：Agent 首次读取库内文件时打快照（pin），
 * 之后同会话再次读取时，若文件已漂移，Agent 拿到的仍是 pin 时刻版本并收到漂移提示。
 *
 * 存储布局（.dsh-library/pins/）：
 *   <hash8>-<ts>.json   pin 快照本体（内容 + 元数据）
 *   active.json         { [库内相对路径]: { pinId, hash, createdAt } } 当前生效 pin 索引
 *
 * 生命周期跟随会话：v0.1 由 UI「释放」或用户手动清理 active.json 条目；
 * 后续接入宿主会话生命周期事件后自动清理。
 */
import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { PINS_DIR, inLibrary } from './store.js'

export interface Pin {
  id: string
  /** 库内相对路径。 */
  relPath: string
  /** pin 时刻的完整内容。 */
  content: string
  /** pin 时刻内容的 SHA-256，用于漂移检测。 */
  hash: string
  createdAt: string
}

interface ActiveIndex {
  [relPath: string]: { pinId: string; hash: string; createdAt: string }
}

const ACTIVE_FILE = join(PINS_DIR, 'active.json')

function hashOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

async function readActiveIndex(): Promise<ActiveIndex> {
  try {
    return JSON.parse(await readFile(ACTIVE_FILE, 'utf8')) as ActiveIndex
  } catch {
    return {}
  }
}

async function writeActiveIndex(index: ActiveIndex): Promise<void> {
  await mkdir(PINS_DIR, { recursive: true })
  await writeFile(ACTIVE_FILE, JSON.stringify(index, null, 2), 'utf8')
}

export interface PinOutcome {
  /** 该次读取的生效 pin。 */
  pin: Pin
  /** 是否本次新建（首次读取）。 */
  created: boolean
  /** 文件相对 pin 已漂移。 */
  drifted: boolean
  /** 文件当前内容（漂移时用于对比提示），可能不存在。 */
  current?: { content: string; hash: string }
}

/**
 * 读取库内文件时的 pin 语义：
 * - 无 pin → 以当前内容新建（首次固定）；
 * - 有 pin 且未漂移 → 直接复用；
 * - 有 pin 且已漂移 → 保持旧 pin，返回漂移信息（Agent 拿固定版本 + 提示）。
 */
export async function pinForRead(absPath: string, relPath: string): Promise<PinOutcome | null> {
  if (!existsSync(absPath)) return null
  const current = await readFile(absPath, 'utf8')
  const currentHash = hashOf(current)

  const index = await readActiveIndex()
  const active = index[relPath]
  if (!active) {
    const pin: Pin = {
      id: randomUUID(),
      relPath,
      content: current,
      hash: currentHash,
      createdAt: new Date().toISOString(),
    }
    await mkdir(PINS_DIR, { recursive: true })
    await writeFile(join(PINS_DIR, `${pin.hash.slice(0, 8)}-${Date.now()}.json`), JSON.stringify(pin, null, 2), 'utf8')
    index[relPath] = { pinId: pin.id, hash: pin.hash, createdAt: pin.createdAt }
    await writeActiveIndex(index)
    return { pin, created: true, drifted: false }
  }

  if (active.hash === currentHash) {
    // 未漂移：当前内容即 pin 内容，无需落快照副本
    const pin: Pin = {
      id: active.pinId,
      relPath,
      content: current,
      hash: active.hash,
      createdAt: active.createdAt,
    }
    return { pin, created: false, drifted: false }
  }

  // 已漂移：加载旧 pin 快照（可能已被磁盘清理，退化为索引内记录的旧 hash）
  const pinFile = await findPinFile(active.pinId)
  const pin: Pin = pinFile
    ? JSON.parse(await readFile(pinFile, 'utf8')) as Pin
    : { id: active.pinId, relPath, content: '', hash: active.hash, createdAt: active.createdAt }
  return {
    pin,
    created: false,
    drifted: true,
    current: { content: current, hash: currentHash },
  }
}

async function findPinFile(pinId: string): Promise<string | null> {
  try {
    const { readdir } = await import('node:fs/promises')
    const files = await readdir(PINS_DIR)
    const hit = files.find(f => f.endsWith('.json') && f !== 'active.json' && f.includes(pinId.slice(0, 8)))
    return hit ? join(PINS_DIR, hit) : null
  } catch {
    return null
  }
}

/** 列出全部生效 pin（相对路径 + 元数据，不含内容）。 */
export async function listActivePins(): Promise<Array<{ relPath: string; pinId: string; hash: string; createdAt: string; drifted: boolean }>> {
  const index = await readActiveIndex()
  const out: Array<{ relPath: string; pinId: string; hash: string; createdAt: string; drifted: boolean }> = []
  for (const [relPath, active] of Object.entries(index)) {
    let drifted = true
    try {
      drifted = hashOf(await readFile(inLibrary(relPath), 'utf8')) !== active.hash
    } catch {
      drifted = true
    }
    out.push({ relPath, pinId: active.pinId, hash: active.hash, createdAt: active.createdAt, drifted })
  }
  return out
}

/** 释放（重新固定入口）：删除 pin 索引条目；下次读取会重新固定。 */
export async function releasePin(relPath: string): Promise<boolean> {
  const index = await readActiveIndex()
  if (!(relPath in index)) return false
  delete index[relPath]
  await writeActiveIndex(index)
  return true
}
