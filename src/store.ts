/**
 * dsh-wb-desk 存储层：文件本体直存，元数据收在 .dsh-library/ 隐藏目录。
 *
 * 布局（对应需求文档 3.4 / 第 6 节）：
 *   $DSH_HOME/library/            库根（可配置覆盖）
 *     inbox/                      Agent 自动归位的默认落点
 *     projects/                   按项目手工归档
 *     archive/                    归档区
 *     .dsh-library/               插件元数据（不与用户文件混放）
 *       pending/                  待确认队列（持久化，崩溃不丢）
 *       pins/                     固定修订引用快照
 *
 * 初始化"原地收编"：只补建缺失目录，绝不移动/改写已有文件。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'

/** 库根：DSH_LIBRARY_ROOT 覆盖 > DSH_HOME/library > ~/.dsh/library */
export const LIBRARY_ROOT: string = process.env.DSH_WB_DESK_ROOT
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'library')

/** 插件元数据目录（隐藏，与用户文件分离）。 */
export const META_DIR = join(LIBRARY_ROOT, '.dsh-library')
export const PENDING_DIR = join(META_DIR, 'pending')
export const PINS_DIR = join(META_DIR, 'pins')
/** 回收站：删除的文件移到这里可恢复，不参与树与搜索。 */
export const TRASH_DIR = join(META_DIR, '.trash')

/** 首次打开的默认目录结构（需求文档 3.4）。 */
export const DEFAULT_DIRS = ['inbox', 'projects', 'archive'] as const

/**
 * 初始化库：mkdir recursive 对已存在目录是幂等 no-op，
 * 因此天然满足"不覆盖已有内容、原地收编"的语义。
 */
export async function initLibrary(): Promise<void> {
  await mkdir(META_DIR, { recursive: true })
  await mkdir(PENDING_DIR, { recursive: true })
  await mkdir(PINS_DIR, { recursive: true })
  for (const dir of DEFAULT_DIRS) {
    await mkdir(join(LIBRARY_ROOT, dir), { recursive: true })
  }
}

/** 库内相对路径 → 绝对路径（调用方需已校验无 .. 越界）。 */
export function inLibrary(relativePath: string): string {
  return join(LIBRARY_ROOT, relativePath)
}

/** 判断绝对路径是否落在库内。 */
export function isInsideLibrary(absolutePath: string): boolean {
  const norm = absolutePath.replaceAll('\\', '/')
  const root = LIBRARY_ROOT.replaceAll('\\', '/')
  return norm.startsWith(root.endsWith('/') ? root : root + '/')
}
