import fs from 'node:fs/promises'
import path from 'node:path'
import { extOf, type ImportRequest, type ImportResult, type Link, type PlanItem } from '@automedia/shared'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db'
import { badRequest } from '../errors'
import { buildLayout } from '../media/layout'
import { getMediaDetail, removeLinks } from '../media/store'
import { syncMedia } from '../media/sync'
import { findLibrary } from '../settings'
import { setTorrentState } from '../sources/qb'
import { createLink, exists, linkErrorHint } from '../util/fs'

interface Plan {
  items: PlanItem[]
  /** 与 items 一一对应：执行前需要先移除的旧链接 */
  replaces: number[][]
}

// macOS / Windows 的文件系统默认不区分大小写，目标路径按不区分大小写比较
const norm = (p: string) => p.toLowerCase()

/**
 * 计算每个文件会落到哪里、会不会冲突。不写磁盘。
 * 不校验 (季, 集) 是否存在于元数据里 —— 元数据缺了照样导入，之后在 Media 页补。
 */
export async function planImport(req: ImportRequest): Promise<Plan> {
  const detail = getMediaDetail(req.mediaId)
  const lib = findLibrary(detail.media.libraryId)
  if (!lib) throw badRequest(`「${detail.media.title}」还没有选择媒体库，请先在 Media 页面设置`)

  const fromThisSource = (l: Link) => l.sourceType === req.sourceType && l.sourceRef === req.sourceRef
  const kept = req.replaceSource ? detail.links.filter((l) => !fromThisSource(l)) : detail.links
  const freed = new Set(
    req.replaceSource ? detail.links.filter(fromThisSource).map((l) => norm(l.targetPath)) : [],
  )

  const layout = buildLayout(detail.media, detail.episodes, [...kept, ...req.items])
  const dir = path.join(lib.path, layout.folderName)
  const keptByTarget = new Map(kept.map((l) => [norm(l.targetPath), l]))

  const items: PlanItem[] = []
  const replaces: number[][] = []
  const targetCount = new Map<string, number>()
  const videoSlotCount = new Map<string, number>()

  for (const it of req.items) {
    const suffix = it.kind === 'video' ? '' : it.suffix
    const ext = extOf(path.basename(it.path))
    const target = path.join(dir, layout.linkRel({ season: it.season, episode: it.episode, suffix, ext }))
    items.push({ ...it, suffix, target, status: 'ok', message: '' })
    targetCount.set(norm(target), (targetCount.get(norm(target)) ?? 0) + 1)
    if (it.kind === 'video') {
      const k = `${it.season}:${it.episode}`
      videoSlotCount.set(k, (videoSlotCount.get(k) ?? 0) + 1)
    }
  }

  for (const item of items) {
    const replace = new Set<number>()
    replaces.push([])
    const fail = (message: string) => Object.assign(item, { status: 'error' as const, message })

    if (!extOf(path.basename(item.path))) {
      fail('文件没有扩展名')
      continue
    }
    const st = await fs.stat(item.path).catch(() => null)
    if (!st?.isFile()) {
      fail('源文件不存在')
      continue
    }
    if (item.kind === 'video' && (videoSlotCount.get(`${item.season}:${item.episode}`) ?? 0) > 1) {
      fail(`本次有多个视频被设成了 S${item.season}E${item.episode}`)
      continue
    }
    if ((targetCount.get(norm(item.target)) ?? 0) > 1) {
      fail('本次有多个文件会落到同一个目标文件名（字幕请用不同的语言标签区分）')
      continue
    }

    const same = keptByTarget.get(norm(item.target))
    if (same) replace.add(same.id)
    else if (!freed.has(norm(item.target)) && (await exists(item.target))) {
      fail('目标位置已有文件，且不是本工具创建的')
      continue
    }
    // 同一集换了个视频文件（比如 mkv → mp4）：旧的视频链接一并替换掉
    if (item.kind === 'video')
      for (const l of kept)
        if (l.kind === 'video' && l.season === item.season && l.episode === item.episode) replace.add(l.id)

    if (replace.size) {
      item.status = 'replace'
      item.message = '替换之前导入的文件'
      replaces[replaces.length - 1] = [...replace]
    }
  }
  return { items, replaces }
}

export async function executeImport(req: ImportRequest): Promise<ImportResult> {
  const d = db()
  if (req.replaceSource) {
    const old = getMediaDetail(req.mediaId).links.filter(
      (l) => l.sourceType === req.sourceType && l.sourceRef === req.sourceRef,
    )
    await removeLinks(old.map((l) => l.id))
  }
  const plan = await planImport({ ...req, replaceSource: false })
  const results: ImportResult['items'] = []

  for (const [i, item] of plan.items.entries()) {
    if (item.status === 'error') {
      results.push({ ...item, done: false })
      continue
    }
    try {
      await removeLinks(plan.replaces[i])
      const source = path.resolve(item.path)
      await createLink(req.linkMode, source, item.target)
      d.insert(schema.links)
        .values({
          mediaId: req.mediaId,
          season: item.season,
          episode: item.episode,
          kind: item.kind,
          suffix: item.suffix,
          ext: extOf(path.basename(item.target)),
          sourceType: req.sourceType,
          sourceRef: req.sourceRef,
          sourceName: req.sourceName,
          sourcePath: source,
          targetPath: item.target,
          linkMode: req.linkMode,
          createdAt: Date.now(),
        })
        .run()
      results.push({ ...item, done: true })
    } catch (e) {
      results.push({ ...item, status: 'error', message: linkErrorHint(e, req.linkMode), done: false })
    }
  }

  const { warnings } = await syncMedia(req.mediaId)
  d.update(schema.media).set({ updatedAt: Date.now() }).where(eq(schema.media.id, req.mediaId)).run()
  if (req.markImported && req.sourceType === 'torrent' && results.some((r) => r.done))
    setTorrentState(req.sourceRef, 'imported', req.sourceName)

  // sync 之后路径可能被重命名（movie 从单片变多片），以数据库为准回填
  const bySource = new Map(getMediaDetail(req.mediaId).links.map((l) => [l.sourcePath + '|' + l.suffix, l.targetPath]))
  for (const r of results)
    if (r.done) r.target = bySource.get(path.resolve(r.path) + '|' + r.suffix) ?? r.target
  return { items: results, warnings }
}
