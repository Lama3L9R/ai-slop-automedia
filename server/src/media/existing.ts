import fs from 'node:fs/promises'
import path from 'node:path'
import { fileKindOf, pad2, type Media } from '@automedia/shared'
import { db, schema } from '../db'
import { exists, moveFile } from '../util/fs'
import { sanitizeName } from './layout'

/**
 * 与「媒体库里已经存在、但不是本工具创建的内容」打交道的逻辑。
 * 典型场景是接手 Sonarr 管过的媒体库：目录、季文件夹、每一集的文件都已经在那了。
 */

export interface Slot {
  season: number
  episode: number
}

/**
 * 从文件名里解析 SxxEyy。支持 Sonarr 的各种多集写法：
 * S01E01E02、S01E01-E02、S01E01-02、S01E01.S01E02 …… 多集文件按连续区间处理。
 */
export function parseEpisodes(fileName: string): Slot[] {
  const out = new Map<string, Slot>()
  const re = /(?<![a-z0-9])S(\d{1,4})[ ._]?E(\d{1,4})((?:-?E\d{1,4}|-\d{1,4}(?![\dpi]))*)/gi
  for (const m of fileName.matchAll(re)) {
    const season = Number(m[1])
    const first = Number(m[2])
    const rest = [...m[3].matchAll(/\d+/g)].map((x) => Number(x[0]))
    const last = Math.min(Math.max(first, ...rest), first + 50)
    for (let e = first; e <= last; e++) out.set(`${season}:${e}`, { season, episode: e })
  }
  return [...out.values()]
}

/**
 * 目录里已有的季文件夹：季号 → 实际的文件夹名。
 * Sonarr 默认用「Season 1」「Specials」，本工具默认用「Season 01」「Season 00」；
 * 已经有对应文件夹时就沿用它，避免同一季被拆进两个文件夹。
 */
export async function discoverSeasonDirs(dir: string): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const m = /^(?:Season|S)[ ._]?(\d{1,4})$/i.exec(ent.name)
    const n = m ? Number(m[1]) : /^Specials?$/i.test(ent.name) ? 0 : null
    if (n === null) continue
    if (!out.has(n) || ent.name === `Season ${pad2(n)}`) out.set(n, ent.name)
  }
  return out
}

const ID_TAG = /[\[{(]\s*(tvdb|tmdb|imdb)(?:id)?\s*[-=]\s*(\w+)\s*[\]})]/gi

/**
 * 在媒体库根目录下找「这部作品已有的目录」（还没被任何 Media 接管的）。
 * 先按目录名里的 ID 标记匹配（[tvdbid=1] [tvdbid-1] {tvdb-1} …），再按「标题」或「标题 (年份)」匹配。
 * 找不到或有歧义时返回 null —— 宁可新建目录，也不乱认。
 */
export async function findAdoptable(
  libPath: string,
  media: Pick<Media, 'title' | 'year' | 'tvdbId' | 'tmdbId' | 'imdbId'>,
): Promise<string | null> {
  const owned = new Set(
    db()
      .select({ p: schema.media.folderPath })
      .from(schema.media)
      .all()
      .map((r) => r.p.toLowerCase())
      .filter(Boolean),
  )
  const want: Record<string, string> = {
    tvdb: media.tvdbId.trim().toLowerCase(),
    tmdb: media.tmdbId.trim().toLowerCase(),
    imdb: media.imdbId.trim().toLowerCase(),
  }
  const title = sanitizeName(media.title).toLowerCase()
  const strong: string[] = []
  const weak: string[] = []
  const entries = await fs.readdir(libPath, { withFileTypes: true }).catch(() => [])
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const full = path.join(libPath, ent.name)
    if (owned.has(full.toLowerCase())) continue
    const ids = [...ent.name.matchAll(ID_TAG)].map((m) => [m[1].toLowerCase(), m[2].toLowerCase()] as const)
    if (ids.some(([k, v]) => want[k] && want[k] === v)) {
      strong.push(full)
      continue
    }
    if (ids.some(([k, v]) => want[k] && want[k] !== v)) continue
    const bare = ent.name.replace(ID_TAG, '').trim()
    const ym = /\((\d{4})\)$/.exec(bare)
    const base = (ym ? bare.slice(0, ym.index) : bare).trim().toLowerCase()
    if (base !== title) continue
    if (ym && media.year && Number(ym[1]) !== media.year) continue
    weak.push(full)
  }
  if (strong.length === 1) return strong[0]
  if (strong.length === 0 && weak.length === 1) return weak[0]
  return null
}

export interface ExistingVideo {
  path: string
  slots: Slot[]
}

/** 作品目录（含季文件夹）里不归本工具管、且能从文件名认出集号的视频 */
export async function scanUnmanagedVideos(dir: string, isManaged: (p: string) => boolean): Promise<ExistingVideo[]> {
  const out: ExistingVideo[] = []
  const walk = async (d: string, depth: number) => {
    const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => [])
    for (const ent of entries) {
      const full = path.join(d, ent.name)
      if (ent.isDirectory()) {
        if (depth < 2) await walk(full, depth + 1)
      } else if (fileKindOf(ent.name) === 'video' && !isManaged(full)) {
        const slots = parseEpisodes(ent.name)
        if (slots.length) out.push({ path: full, slots })
      }
    }
  }
  await walk(dir, 0)
  return out
}

/**
 * 删掉 existing 会不会丢数据？以下情况认为不会：
 * 它本身只是个链接；它是硬链接（数据在别处还有一份）；它和这次要导入的源文件一样大（是源文件的副本）。
 */
export async function safeToReplace(existing: string, source: string): Promise<{ safe: boolean; why: string }> {
  const [a, b] = await Promise.all([fs.lstat(existing), fs.stat(source)])
  if (a.isSymbolicLink()) return { safe: true, why: '符号链接' }
  if (a.ino && a.ino === b.ino && a.dev === b.dev) return { safe: true, why: '源文件的硬链接' }
  if (a.nlink > 1) return { safe: true, why: '硬链接' }
  if (a.size === b.size) return { safe: true, why: '与源文件大小相同的副本' }
  return { safe: false, why: '与源文件大小不同' }
}

const stem = (p: string) => path.basename(p).replace(/\.[^.]+$/, '')

/**
 * 视频换了名字之后，让它旁边不归本工具管的附属文件（Sonarr / Bazarr 留下的字幕、NFO、缩略图）跟着改名，
 * 这样它们仍然能被 Emby 认成这一集的。只处理「旧文件名 + . 或 -」开头的文件，不会碰别的集。
 */
export async function renameSidecars(
  oldVideo: string,
  newVideo: string,
  isManaged: (p: string) => boolean,
): Promise<void> {
  const fromDir = path.dirname(oldVideo)
  const toDir = path.dirname(newVideo)
  const fromBase = stem(oldVideo)
  const toBase = stem(newVideo)
  if (fromDir === toDir && fromBase === toBase) return
  const entries = await fs.readdir(fromDir).catch(() => [])
  for (const name of entries) {
    if (!name.startsWith(`${fromBase}.`) && !name.startsWith(`${fromBase}-`)) continue
    if (fileKindOf(name) === 'video') continue
    const src = path.join(fromDir, name)
    if (isManaged(src)) continue
    const dst = path.join(toDir, toBase + name.slice(fromBase.length))
    if (await exists(dst)) continue
    await moveFile(src, dst).catch(() => {})
  }
}
