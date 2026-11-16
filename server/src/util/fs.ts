import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { LinkMode } from '@automedia/shared'

/** lstat：悬空的符号链接也算存在 */
export async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p)
    return true
  } catch {
    return false
  }
}

export async function createLink(mode: LinkMode, src: string, dst: string): Promise<void> {
  await fs.mkdir(path.dirname(dst), { recursive: true })
  if (mode === 'symlink') await fs.symlink(src, dst, 'file')
  else if (mode === 'hardlink') await fs.link(src, dst)
  // FICLONE：APFS 等支持 CoW 的文件系统上是瞬间完成的克隆，不支持时退化为普通拷贝
  else await fs.copyFile(src, dst, constants.COPYFILE_FICLONE)
}

export function linkErrorHint(e: unknown, mode: LinkMode): string {
  const code = (e as NodeJS.ErrnoException)?.code
  if (code === 'EXDEV') return '硬链接不能跨磁盘 / 卷，请改用符号链接或拷贝'
  if (code === 'EPERM' && mode === 'symlink' && process.platform === 'win32')
    return 'Windows 上创建符号链接需要开启「开发者模式」或以管理员身份运行'
  if (code === 'EEXIST') return '目标文件已存在'
  if (code === 'ENOENT') return '源文件不存在'
  return e instanceof Error ? e.message : String(e)
}

/** 只删链接 / 文件本身，不会跟随符号链接去删源文件 */
export async function removeFile(p: string): Promise<void> {
  await fs.rm(p, { force: true })
}

/** rename，跨卷时退化为「重建 + 删除」 */
export async function moveFile(src: string, dst: string): Promise<void> {
  await fs.mkdir(path.dirname(dst), { recursive: true })
  try {
    await fs.rename(src, dst)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    const st = await fs.lstat(src)
    if (st.isSymbolicLink()) await fs.symlink(await fs.readlink(src), dst, 'file')
    else await fs.copyFile(src, dst)
    await fs.rm(src, { force: true })
  }
}

const JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

/** 自底向上删除空目录（只含系统垃圾文件的也算空）。返回 dir 自身是否被删除。 */
export async function pruneEmptyDirs(dir: string): Promise<boolean> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return false
  }
  let remaining = 0
  const junk: string[] = []
  for (const ent of entries) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (!(await pruneEmptyDirs(full))) remaining++
    } else if (JUNK.has(ent.name)) junk.push(full)
    else remaining++
  }
  if (remaining > 0) return false
  for (const j of junk) await fs.rm(j, { force: true })
  try {
    await fs.rmdir(dir)
    return true
  } catch {
    return false
  }
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
