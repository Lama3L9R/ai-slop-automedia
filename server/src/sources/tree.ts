import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileKindOf, naturalCompare, type SourceTree, type SourceType, type TreeNode } from '@automedia/shared'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db'
import { badRequest } from '../errors'
import { rowToLink } from '../media/store'
import { isInside } from '../util/fs'
import { getTorrent, mapPath } from './qb'

const MAX_ENTRIES = 50_000
const SKIP = (name: string) => name === '.DS_Store' || name === 'Thumbs.db' || name.startsWith('._')

async function walk(dir: string, relPrefix: string, counter: { n: number }): Promise<TreeNode[]> {
  const entries = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => !SKIP(e.name))
  counter.n += entries.length
  if (counter.n > MAX_ENTRIES) throw badRequest(`目录内容太多（超过 ${MAX_ENTRIES} 项），请选择更具体的子目录`)
  const nodes = await Promise.all(
    entries.map(async (ent): Promise<TreeNode | null> => {
      const full = path.join(dir, ent.name)
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name
      let st
      try {
        st = await fs.stat(full)
      } catch {
        return null // 悬空链接、无权限
      }
      if (st.isDirectory())
        return { name: ent.name, path: full, rel, isDir: true, size: 0, kind: null, children: await walk(full, rel, counter) }
      if (!st.isFile()) return null
      return { name: ent.name, path: full, rel, isDir: false, size: st.size, kind: fileKindOf(ent.name) }
    }),
  )
  return nodes
    .filter((n): n is TreeNode => n !== null)
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || naturalCompare(a.name, b.name))
}

/** 文件夹在前、自然排序的目录树；root 也可以是单个文件（单文件种子） */
export async function readTree(root: string): Promise<TreeNode[]> {
  let st
  try {
    st = await fs.stat(root)
  } catch {
    throw badRequest(`路径不存在或无法访问：${root}`)
  }
  if (st.isFile()) {
    const name = path.basename(root)
    return [{ name, path: root, rel: name, isDir: false, size: st.size, kind: fileKindOf(name) }]
  }
  return walk(root, '', { n: 0 })
}

export async function sourceTree(type: SourceType, ref: string): Promise<SourceTree> {
  let root: string
  let name: string
  if (type === 'torrent') {
    const t = await getTorrent(ref)
    root = mapPath(t.content_path)
    name = t.name
  } else {
    if (!ref.trim()) throw badRequest('没有指定目录')
    root = path.resolve(ref)
    name = path.basename(root)
  }
  const nodes = await readTree(root)
  const links = db()
    .select({ link: schema.links, mediaTitle: schema.media.title })
    .from(schema.links)
    .innerJoin(schema.media, eq(schema.media.id, schema.links.mediaId))
    .all()
    .filter((r) => isInside(r.link.sourcePath, root))
    .map((r) => ({ ...rowToLink(r.link), mediaTitle: r.mediaTitle }))
  return { type, ref, name, root, nodes, links }
}

export interface DirListing {
  path: string
  parent: string | null
  dirs: { name: string; path: string }[]
}

/** 目录选择器用：列出子目录。path 为空时返回根（Windows 上是盘符列表）。 */
export async function listDirs(p: string): Promise<DirListing> {
  if (!p.trim()) {
    if (process.platform !== 'win32') p = '/'
    else {
      const drives = 'CDEFGHIJKLMNOPQRSTUVWXYZAB'
        .split('')
        .map((l) => `${l}:\\`)
        .filter((d) => existsSync(d))
      return { path: '', parent: null, dirs: drives.map((d) => ({ name: d, path: d })) }
    }
  }
  const dir = path.resolve(p)
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    throw badRequest(`无法读取目录：${dir}`)
  }
  const dirs: DirListing['dirs'] = []
  for (const ent of entries) {
    if (ent.name.startsWith('.') || ent.name.startsWith('$')) continue
    const full = path.join(dir, ent.name)
    let isDir = ent.isDirectory()
    if (ent.isSymbolicLink()) isDir = await fs.stat(full).then((s) => s.isDirectory(), () => false)
    if (isDir) dirs.push({ name: ent.name, path: full })
  }
  dirs.sort((a, b) => naturalCompare(a.name, b.name))
  const up = path.dirname(dir)
  const parent = up === dir ? (process.platform === 'win32' ? '' : null) : up
  return { path: dir, parent, dirs }
}
