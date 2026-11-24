/**
 * 会话产物体检通知：Agent 每次把文件落进资料库时入队一条，
 * 客户端 shell.overlay 轮询 /notices 后在右下角弹气泡（几秒后自动消失）。
 *
 * 只存内存 ring buffer：重启即清，不落盘、不上云。
 */

export type FileNoticeKind = 'relocated' | 'saved'

export interface FileNotice {
  /** 自增序号（宿主每次启动从 1 开始），客户端按它增量拉取。 */
  id: number
  at: string
  kind: FileNoticeKind
  /** 文件名。 */
  name: string
  /** 库内落点（相对库根）。 */
  libPath: string
  /** 库外原始路径（relocated 才有）。 */
  sourcePath?: string
  sessionId?: string
  sessionTitle?: string
}

const MAX_NOTICES = 50

/** 宿主启动标识：客户端发现变了就重置游标，避免重启后 id 回绕导致漏弹/重弹。 */
export const NOTICE_BOOT = Math.random().toString(36).slice(2, 10)

let seq = 0
const ring: FileNotice[] = []

export function pushFileNotice(input: Omit<FileNotice, 'id' | 'at'>): void {
  seq += 1
  ring.push({ id: seq, at: new Date().toISOString(), ...input })
  if (ring.length > MAX_NOTICES) ring.splice(0, ring.length - MAX_NOTICES)
}

export function listFileNotices(sinceId: number): { boot: string; lastId: number; items: FileNotice[] } {
  return {
    boot: NOTICE_BOOT,
    lastId: seq,
    items: ring.filter(n => n.id > sinceId),
  }
}
