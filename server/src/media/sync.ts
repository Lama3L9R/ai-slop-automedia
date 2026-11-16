import fs from 'node:fs/promises'
import path from 'node:path'
import type { Link, MediaDetail } from '@automedia/shared'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db'
import { errMsg } from '../errors'
import { findLibrary, getSettings } from '../settings'
import { createLink, exists, isInside, moveFile, pruneEmptyDirs, removeFile } from '../util/fs'
import { extFetch } from '../util/http'
import { discoverSeasonDirs, renameSidecars } from './existing'
import { buildLayout, mediaFolderName, type Layout } from './layout'
import { episodeNfo, movieNfo, seasonNfo, tvshowNfo } from './nfo'
import { getLinks, getMediaDetail } from './store'

export interface SyncResult {
  warnings: string[]
}

type Artifact = { content: string } | { url: string }

function imageExt(url: string): string {
  try {
    const m = /\.(jpe?g|png|webp)$/i.exec(new URL(url).pathname)
    if (m) return m[1].toLowerCase().replace('jpeg', 'jpg')
  } catch {
    /* 非法 URL 当作 jpg */
  }
  return 'jpg'
}

/** 这个 Media 目录下应该存在的全部 NFO / 图片 */
function computeArtifacts(detail: MediaDetail, layout: Layout, dir: string, lock: boolean): Map<string, Artifact> {
  const { media, seasons, episodes, links } = detail
  const out = new Map<string, Artifact>()
  const image = (rel: string, url: string) => {
    if (url.trim()) out.set(path.join(dir, `${rel}.${imageExt(url)}`), { url: url.trim() })
  }
  const epOf = (s: number, e: number) => episodes.find((x) => x.season === s && x.number === e)
  const videos = links.filter((l) => l.kind === 'video')

  if (media.kind === 'series') {
    out.set(path.join(dir, 'tvshow.nfo'), { content: tvshowNfo(media, lock) })
    image('poster', media.posterUrl)
    image('fanart', media.fanartUrl)
    for (const n of new Set(links.map((l) => l.season))) {
      const season = seasons.find((s) => s.number === n)
      out.set(path.join(dir, layout.relDir(n), 'season.nfo'), { content: seasonNfo(n, season, lock) })
      image(path.join(layout.relDir(n), 'poster'), season?.posterUrl ?? '')
    }
    for (const v of videos) {
      const ep = epOf(v.season, v.episode)
      const base = path.join(layout.relDir(v.season), layout.baseName(v.season, v.episode))
      out.set(path.join(dir, `${base}.nfo`), { content: episodeNfo(v.season, v.episode, ep, lock) })
      image(`${base}-thumb`, ep?.stillUrl ?? '')
    }
  } else {
    for (const v of videos) {
      const ep = epOf(v.season, v.episode)
      const base = layout.baseName(v.season, v.episode)
      out.set(path.join(dir, `${base}.nfo`), { content: movieNfo(media, ep, layout.multiFilm, lock) })
      if (layout.multiFilm) {
        image(`${base}-poster`, ep?.stillUrl || media.posterUrl)
        image(`${base}-fanart`, media.fanartUrl)
      }
    }
    if (!layout.multiFilm && videos.length) {
      image('poster', media.posterUrl)
      image('fanart', media.fanartUrl)
    }
  }
  return out
}

// ───────────────────────── 图片下载（后台） ─────────────────────────

let imageChain: Promise<void> = Promise.resolve()

/** 测试用：等待后台图片下载结束 */
export const imagesIdle = () => imageChain

function queueImages(mediaId: number, jobs: { path: string; url: string }[]) {
  if (!jobs.length) return
  imageChain = imageChain.then(async () => {
    let failures = 0
    for (const job of jobs) {
      // 连续失败说明网络不通，剩下的不再硬等超时
      if (failures >= 2) break
      try {
        const res = await extFetch(job.url, { timeoutMs: 20_000 })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const buf = Buffer.from(await res.arrayBuffer())
        await fs.mkdir(path.dirname(job.path), { recursive: true })
        await fs.writeFile(job.path, buf)
        db()
          .insert(schema.artifacts)
          .values({ path: job.path, mediaId, sourceUrl: job.url })
          .onConflictDoUpdate({ target: schema.artifacts.path, set: { mediaId, sourceUrl: job.url } })
          .run()
        failures = 0
      } catch (e) {
        failures++
        console.warn(`[sync] 图片下载失败 ${job.url}: ${errMsg(e)}`)
      }
    }
  })
}

// ───────────────────────── sync ─────────────────────────

let chain: Promise<unknown> = Promise.resolve()

/**
 * 让磁盘上的媒体库目录与数据库一致：
 * 标题 / 年份 / ID 变了就改目录和文件名，重写 NFO，清理过期的 NFO 和图片，补回丢失的链接。
 * 串行执行，避免两次同步互相踩。
 */
export function syncMedia(id: number): Promise<SyncResult> {
  const run = chain.then(() => doSync(id))
  chain = run.catch(() => {})
  return run
}

async function doSync(id: number): Promise<SyncResult> {
  const d = db()
  const warnings: string[] = []
  const detail = getMediaDetail(id)
  const { media } = detail
  const lib = findLibrary(media.libraryId)
  if (!lib) {
    if (detail.links.length) warnings.push('这个媒体没有选择媒体库（或媒体库已被删除），磁盘上的文件未更新')
    return { warnings }
  }

  const dir = path.join(lib.path, mediaFolderName(media))
  const oldDir = media.folderPath

  // 1. 目录整体改名（保留目录里不归本工具管的文件）
  if (oldDir && oldDir !== dir && (await exists(oldDir)) && !(await exists(dir))) {
    try {
      await fs.mkdir(path.dirname(dir), { recursive: true })
      await fs.rename(oldDir, dir)
      const rebase = (p: string) => (isInside(p, oldDir) ? path.join(dir, path.relative(oldDir, p)) : p)
      d.transaction((tx) => {
        for (const l of detail.links)
          tx.update(schema.links)
            .set({ targetPath: rebase(l.targetPath) })
            .where(eq(schema.links.id, l.id))
            .run()
        const arts = tx.select().from(schema.artifacts).where(eq(schema.artifacts.mediaId, id)).all()
        for (const a of arts)
          tx.update(schema.artifacts)
            .set({ path: rebase(a.path) })
            .where(eq(schema.artifacts.path, a.path))
            .run()
      })
      detail.links = getLinks(id)
    } catch (e) {
      // 跨卷等情况：退化为下面的逐文件移动
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') warnings.push(`目录改名失败：${errMsg(e)}`)
    }
  }

  // 2. 逐个链接对齐到期望路径，丢失的重新创建
  // 已有的季文件夹（比如 Sonarr 建的「Season 1」）沿用，不另建「Season 01」
  const layout = buildLayout(media, detail.episodes, detail.links, await discoverSeasonDirs(dir))
  const managed = new Set([
    ...detail.links.map((l) => l.targetPath),
    ...d
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.mediaId, id))
      .all()
      .map((a) => a.path),
  ])
  const setPath = (link: Link, p: string) => {
    d.update(schema.links).set({ targetPath: p }).where(eq(schema.links.id, link.id)).run()
    link.targetPath = p
  }
  const pending = detail.links
    .map((link) => ({ link, want: path.join(dir, layout.linkRel(link)) }))
    .filter((x) => x.link.targetPath !== x.want)
  // 多轮处理：目标位置被另一个「也要挪走」的链接占着时先等它走（改季号、两季对调时会出现）
  for (let guard = pending.length * 2 + 2; pending.length && guard > 0; guard--) {
    let progressed = false
    for (const x of [...pending]) {
      const { link, want } = x
      try {
        if (await exists(link.targetPath)) {
          if (await exists(want)) {
            if (pending.some((o) => o !== x && o.link.targetPath === want)) continue
            throw new Error(`目标已存在：${want}`)
          }
          const from = link.targetPath
          await moveFile(from, want)
          // 视频旁边不归本工具管的字幕等附属文件跟着改名
          if (link.kind === 'video') await renameSidecars(from, want, (p) => managed.has(p))
        }
        setPath(link, want)
      } catch (e) {
        warnings.push(`${path.basename(link.targetPath)}：${errMsg(e)}`)
      }
      pending.splice(pending.indexOf(x), 1)
      progressed = true
    }
    if (!progressed && pending.length) {
      // 互相占着对方的位置：把其中一个先挪到临时名字，下一轮就能解开
      const x = pending[0]
      try {
        const tmp = `${x.link.targetPath}.automedia-moving`
        await moveFile(x.link.targetPath, tmp)
        setPath(x.link, tmp)
      } catch (e) {
        warnings.push(`${path.basename(x.link.targetPath)}：${errMsg(e)}`)
        pending.shift()
      }
    }
  }
  for (const link of detail.links) {
    try {
      if (!(await exists(link.targetPath))) await createLink(link.linkMode, link.sourcePath, link.targetPath)
    } catch (e) {
      warnings.push(`${path.basename(link.targetPath)}：${errMsg(e)}`)
    }
  }

  // 3. NFO / 图片
  const desired = detail.links.length
    ? computeArtifacts(detail, layout, dir, getSettings().nfo.lockData)
    : new Map<string, Artifact>()
  const existing = d.select().from(schema.artifacts).where(eq(schema.artifacts.mediaId, id)).all()
  const existingMap = new Map(existing.map((r) => [r.path, r]))
  const imageJobs: { path: string; url: string }[] = []

  for (const [p, art] of desired) {
    try {
      if ('content' in art) {
        await fs.mkdir(path.dirname(p), { recursive: true })
        await fs.writeFile(p, art.content, 'utf8')
        if (!existingMap.has(p)) d.insert(schema.artifacts).values({ path: p, mediaId: id }).onConflictDoNothing().run()
      } else {
        const row = existingMap.get(p)
        const onDisk = await exists(p)
        if (row?.sourceUrl === art.url && onDisk) continue
        // 已有同名图片但不是本工具下载的（用户自己放的 / Emby 存的）→ 不覆盖
        if (onDisk && !row) continue
        imageJobs.push({ path: p, url: art.url })
      }
    } catch (e) {
      warnings.push(`${path.basename(p)}：${errMsg(e)}`)
    }
  }
  for (const row of existing) {
    if (desired.has(row.path)) continue
    await removeFile(row.path)
    d.delete(schema.artifacts).where(eq(schema.artifacts.path, row.path)).run()
  }
  queueImages(id, imageJobs)

  // 4. 清理空目录，记录当前目录
  const dirGone = await pruneEmptyDirs(dir)
  if (oldDir && oldDir !== dir) await pruneEmptyDirs(oldDir)
  const folderPath = detail.links.length && !dirGone ? dir : ''
  if (folderPath !== media.folderPath)
    d.update(schema.media).set({ folderPath }).where(eq(schema.media.id, id)).run()

  return { warnings }
}
