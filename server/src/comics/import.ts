import fs from 'node:fs/promises'
import path from 'node:path'
import {
  extOf,
  isArchive,
  isImage,
  naturalCompare,
  type ComicImportRequest,
  type ComicImportResult,
  type ComicPlanItem,
  type Link,
} from '@automedia/shared'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db'
import { badRequest, errMsg } from '../errors'
import { buildLayout } from '../media/layout'
import { assertImportable, getMediaDetail, removeLinks } from '../media/store'
import { syncMedia } from '../media/sync'
import { findLibrary } from '../settings'
import { setTorrentState } from '../sources/qb'
import { extractArchive, isZipLike, zipEntryNames } from '../util/archive'
import { createLink, exists, linkErrorHint } from '../util/fs'

/**
 * 漫画导入。一个导入单位（一个压缩包，或一个装着图片的文件夹）对应一集：
 * 压缩包先在原地解压（下载目录里、压缩包旁边的同名文件夹），再把里面的图片按自然排序依次链接进媒体库，
 * 链接名是补零的序号。不写 NFO。
 */

/** 压缩包解压到哪：旁边的同名（去掉扩展名）文件夹 */
export const extractDirOf = (archive: string) =>
  path.join(path.dirname(archive), path.basename(archive).replace(/\.[^.]+$/, ''))

/** 在原地解压（已经解压过就直接用）。先解到临时目录再改名，中途失败不会留下半截的文件夹 */
export async function ensureExtracted(archive: string): Promise<string> {
  const dest = extractDirOf(archive)
  if (await exists(dest)) return dest
  const tmp = `${dest}.extracting`
  await fs.rm(tmp, { recursive: true, force: true })
  try {
    await extractArchive(archive, path.basename(archive), tmp)
    await fs.rename(tmp, dest)
  } catch (e) {
    await fs.rm(tmp, { recursive: true, force: true })
    throw e
  }
  return dest
}

/** 目录下（递归）的所有图片，按自然排序：每一层里文件和子目录混在一起按名字排 */
export async function listImages(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string) => {
    const entries = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => !e.name.startsWith('.') && e.name !== '__MACOSX')
      .sort((a, b) => naturalCompare(a.name, b.name))
    for (const ent of entries) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) await walk(full)
      else if (isImage(ent.name)) out.push(full)
    }
  }
  await walk(root)
  return out
}

interface Unit {
  /** 图片所在的目录（压缩包则是它的解压目录） */
  imageRoot: string
  archive: boolean
  extracted: boolean
}

async function resolveUnit(p: string): Promise<Unit | null> {
  const st = await fs.stat(p).catch(() => null)
  if (!st) return null
  if (st.isDirectory()) return { imageRoot: p, archive: false, extracted: true }
  if (!isArchive(p)) return null
  const dir = extractDirOf(p)
  return { imageRoot: dir, archive: true, extracted: await exists(dir) }
}

async function loadComic(mediaId: number) {
  const detail = getMediaDetail(mediaId)
  if (detail.media.kind !== 'comic') throw badRequest(`「${detail.media.title}」不是漫画`)
  assertImportable(detail.media)
  const lib = findLibrary(detail.media.libraryId)
  if (!lib) throw badRequest(`「${detail.media.title}」还没有选择媒体库，请先在它的页面里设置`)
  return { detail, lib }
}

export async function planComicImport(req: ComicImportRequest): Promise<ComicPlanItem[]> {
  const { detail, lib } = await loadComic(req.mediaId)
  const layout = buildLayout(detail.media, detail.episodes, [...detail.links, ...req.items], {
    seasons: detail.seasons,
  })
  const dir = path.join(lib.path, layout.folderName)
  const slotCount = new Map<string, number>()
  for (const it of req.items) {
    const k = `${it.season}:${it.episode}`
    slotCount.set(k, (slotCount.get(k) ?? 0) + 1)
  }
  const hasPages = new Set(detail.pageCounts.map((c) => `${c.season}:${c.episode}`))

  const items: ComicPlanItem[] = []
  for (const it of req.items) {
    const item: ComicPlanItem = {
      ...it,
      target: path.join(dir, layout.episodeDir(it.season, it.episode)),
      pages: null,
      extract: false,
      status: 'ok',
      message: '',
    }
    items.push(item)
    const fail = (message: string) => Object.assign(item, { status: 'error' as const, message })

    const unit = await resolveUnit(it.path)
    if (!unit) {
      fail('不是文件夹，也不是能识别的压缩包（zip / cbz / rar / cbr / 7z）')
      continue
    }
    if ((slotCount.get(`${it.season}:${it.episode}`) ?? 0) > 1) {
      fail(`本次有多个来源被设成了 S${it.season}E${it.episode}`)
      continue
    }
    item.extract = unit.archive && !unit.extracted
    try {
      if (unit.extracted) item.pages = (await listImages(unit.imageRoot)).length
      else if (isZipLike(it.path)) item.pages = (await zipEntryNames(it.path)).filter(isImage).length
    } catch (e) {
      fail(`读取失败：${errMsg(e)}`)
      continue
    }
    if (item.pages === 0) {
      fail('里面没有图片')
      continue
    }
    if (hasPages.has(`${it.season}:${it.episode}`)) {
      item.status = 'replace'
      item.message = '这一集已经导入过，会整集替换'
    }
  }
  return items
}

export async function executeComicImport(req: ComicImportRequest): Promise<ComicImportResult> {
  const d = db()
  const plan = await planComicImport(req)
  const results: ComicImportResult['items'] = []
  // 和 planComicImport 用同一套布局算每一页的位置
  const { detail, lib } = await loadComic(req.mediaId)
  const packed = detail.media.comicFormat === 'cbz'
  const layout = buildLayout(detail.media, detail.episodes, [...detail.links, ...req.items], { seasons: detail.seasons })
  const dir = path.join(lib.path, layout.folderName)

  for (const item of plan) {
    if (item.status === 'error') {
      results.push({ ...item, done: false })
      continue
    }
    const created: string[] = []
    try {
      const unit = (await resolveUnit(item.path))!
      const root = unit.archive ? await ensureExtracted(item.path) : unit.imageRoot
      const images = await listImages(root)
      if (!images.length) throw new Error('里面没有图片')

      // 整集替换：先清掉这一集已有的页
      const old = d
        .select({ id: schema.links.id })
        .from(schema.links)
        .where(
          and(
            eq(schema.links.mediaId, req.mediaId),
            eq(schema.links.kind, 'page'),
            eq(schema.links.season, item.season),
            eq(schema.links.episode, item.episode),
          ),
        )
        .all()
      await removeLinks(old.map((r) => r.id))

      const now = Date.now()
      const rows = images.map((source, i) => {
        const ext = extOf(source)
        const position = i + 1
        return {
          mediaId: req.mediaId,
          season: item.season,
          episode: item.episode,
          kind: 'page',
          suffix: '',
          ext,
          sourceType: req.sourceType,
          sourceRef: req.sourceRef,
          sourceName: req.sourceName,
          sourcePath: path.resolve(source),
          targetPath: path.join(dir, layout.linkRel({ season: item.season, episode: item.episode, suffix: '', ext, position })),
          linkMode: req.linkMode,
          position,
          createdAt: now,
        }
      })
      // CBZ 模式：只登记页面，打包由随后的 sync 完成
      if (!packed)
        for (const r of rows) {
          await createLink(req.linkMode, r.sourcePath, r.targetPath)
          created.push(r.targetPath)
        }
      d.transaction((tx) => {
        for (let i = 0; i < rows.length; i += 200) tx.insert(schema.links).values(rows.slice(i, i + 200)).run()
      })
      results.push({ ...item, pages: rows.length, done: true })
    } catch (e) {
      // 一集要么全进要么不进：把这次已经建出来的链接撤掉
      for (const p of created) await fs.rm(p, { force: true })
      const message = (e as NodeJS.ErrnoException).code ? linkErrorHint(e, req.linkMode) : errMsg(e)
      results.push({ ...item, status: 'error', message, done: false })
    }
  }

  const { warnings } = await syncMedia(req.mediaId)
  d.update(schema.media).set({ updatedAt: Date.now() }).where(eq(schema.media.id, req.mediaId)).run()
  if (req.markImported && req.sourceType === 'torrent' && results.some((r) => r.done))
    setTorrentState(req.sourceRef, 'imported', req.sourceName)
  return { items: results, warnings }
}

// ───────────────────────── 页面顺序 ─────────────────────────

export function getPages(mediaId: number, season: number, episode: number): Link[] {
  return getMediaDetail(mediaId).links.filter(
    (l) => l.kind === 'page' && l.season === season && l.episode === episode,
  )
}

/**
 * 设置一集的页面顺序。order 是按新顺序排列的链接 id；这一集里没出现在 order 中的页会被移除（只删链接）。
 * 之后 sync 会把媒体库里的文件按新顺序重新编号。
 */
export async function setPageOrder(mediaId: number, season: number, episode: number, order: number[]): Promise<Link[]> {
  const pages = getPages(mediaId, season, episode)
  const ids = new Set(pages.map((p) => p.id))
  if (new Set(order).size !== order.length || order.some((id) => !ids.has(id)))
    throw badRequest('页面列表和服务器上的不一致，请刷新后重试')
  const keep = new Set(order)
  await removeLinks(pages.filter((p) => !keep.has(p.id)).map((p) => p.id))
  db().transaction((tx) => {
    order.forEach((id, i) =>
      tx
        .update(schema.links)
        .set({ position: i + 1 })
        .where(eq(schema.links.id, id))
        .run(),
    )
  })
  await syncMedia(mediaId)
  return getPages(mediaId, season, episode)
}
