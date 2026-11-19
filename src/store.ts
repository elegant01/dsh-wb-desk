/**
 * dsh-wb-desk 存储层：文件本体直存，元数据收在 .dsh-library/ 隐藏目录。
 *
 * 布局：
 *   $DSH_HOME/library/            库根（可配置覆盖）
 *     *.html                      内置的两个介绍页（首次初始化时补，用户可删可改）
 *     inbox/                      Agent 自动归位的落点（有产物时才出现，不预建空目录）
 *     .dsh-library/               插件元数据（不与用户文件混放）
 *       pending/                  待确认队列（持久化，崩溃不丢）
 *       pins/                     固定修订引用快照
 *
 * 初始化"原地收编"：只补建缺失内容，绝不移动/改写已有文件。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { INTRO_FILES } from './intro.js'

/** 库根：DSH_LIBRARY_ROOT 覆盖 > DSH_HOME/library > ~/.dsh/library */
export const LIBRARY_ROOT: string = process.env.DSH_WB_DESK_ROOT
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'library')

/** 插件元数据目录（隐藏，与用户文件分离）。 */
export const META_DIR = join(LIBRARY_ROOT, '.dsh-library')
export const PENDING_DIR = join(META_DIR, 'pending')
export const PINS_DIR = join(META_DIR, 'pins')
/** 回收站：删除的文件移到这里可恢复，不参与树与搜索。 */
export const TRASH_DIR = join(META_DIR, '.trash')

/**
 * 初始化库：mkdir recursive 对已存在目录是幂等 no-op；
 * 两个介绍页是插件固定内置内容，缺了就补、已有不覆盖。
 */
export async function initLibrary(): Promise<void> {
  await mkdir(META_DIR, { recursive: true })
  await mkdir(PENDING_DIR, { recursive: true })
  await mkdir(PINS_DIR, { recursive: true })
  for (const file of INTRO_FILES) {
    const abs = join(LIBRARY_ROOT, file.name)
    if (!existsSync(abs)) await writeFile(abs, file.html, 'utf8')
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
