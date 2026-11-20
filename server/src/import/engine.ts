import fs from 'node:fs/promises'
import path from 'node:path'
import {
  extOf,
  type ImportPlan,
  type ImportRequest,
  type ImportResult,
  type Link,
  type Media,
  type PlanItem,
} from '@automedia/shared'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db'
import { badRequest } from '../errors'
import {
  discoverSeasonDirs,
  findAdoptable,
  renameSidecars,
  safeToReplace,
  scanUnmanagedVideos,
} from '../media/existing'
import { buildLayout, mediaFolderName } from '../media/layout'
import { assertImportable, getMediaDetail, removeLinks } from '../media/store'
import { syncMedia } from '../media/sync'
import { findLibrary } from '../settings'
import { setTorrentState } from '../sources/qb'
import { createLink, exists, linkErrorHint } from '../util/fs'

interface Plan extends ImportPlan {
  /** 与 items 一一对应：执行前需要先移除的、本工具之前创建的链接 */
  replaces: number[][]
}

// macOS / Windows 的文件系统默认不区分大小写，目标路径按不区分大小写比较
const norm = (p: string) => p.toLowerCase()

/**
 * 这个 Media 在媒体库里的目录。
 * dir 是按本工具命名规则应该在的位置；scanDir 是此刻磁盘上实际要看的位置 ——
 * 目录还没建、但媒体库里已有这部作品的目录（Sonarr 建的）时，scanDir 指向那个目录，并给出 adopt。
 */
async function resolveDir(media: Media, libPath: string) {
  const dir = path.join(libPath, mediaFolderName(media))
  if (await exists(dir)) return { dir, scanDir: dir, adopt: null }
  const from = await findAdoptable(libPath, media)
  return { dir, scanDir: from ?? dir, adopt: from ? { from, to: dir } : null }
}

/**
 * 计算每个文件会落到哪里、会不会冲突、会替换掉什么。不写磁盘。
 * 不校验 (季, 集) 是否存在于元数据里 —— 元数据缺了照样导入，之后在 Media 页补。
 */
export async function planImport(req: ImportRequest): Promise<Plan> {
  const detail = getMediaDetail(req.mediaId)
  const { media } = detail
  assertImportable(media)
  const lib = findLibrary(media.libraryId)
  if (!lib) throw badRequest(`「${media.title}」还没有选择媒体库，请先在媒体页面设置`)

  if (media.kind === 'comic') throw badRequest(`「${media.title}」是漫画，请从「来源」页用漫画导入向导`)

  const fromThisSource = (l: Link) => l.sourceType === req.sourceType && l.sourceRef === req.sourceRef
  const kept = req.replaceSource ? detail.links.filter((l) => !fromThisSource(l)) : detail.links
  const freed = new Set(
    req.replaceSource ? detail.links.filter(fromThisSource).map((l) => norm(l.targetPath)) : [],
  )

  const { dir, scanDir, adopt } = await resolveDir(media, lib.path)
  const layout = buildLayout(media, detail.episodes, [...kept, ...req.items], {
    seasonDirs: await discoverSeasonDirs(scanDir),
  })
  /** 期望路径 → 此刻磁盘上对应的路径（接管目录之前两者不同） */
  const onDisk = (p: string) => (scanDir === dir ? p : path.join(scanDir, path.relative(dir, p)))
  const keptByTarget = new Map(kept.map((l) => [norm(l.targetPath), l]))
  const managed = new Set(detail.links.map((l) => norm(l.targetPath)))
  const foreignVideos =
    media.kind === 'series' ? await scanUnmanagedVideos(scanDir, (p) => managed.has(norm(p))) : []

  const items: PlanItem[] = []
  const replaces: number[][] = []
  const targetCount = new Map<string, number>()
  const videoSlotCount = new Map<string, number>()

  for (const it of req.items) {
    const suffix = it.kind === 'video' ? '' : it.suffix
    const ext = extOf(path.basename(it.path))
    const target = path.join(dir, layout.linkRel({ season: it.season, episode: it.episode, suffix, ext }))
    items.push({ ...it, suffix, target, status: 'ok', message: '', removes: [] })
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

    // ── 本工具自己之前创建的 ──
    const same = keptByTarget.get(norm(item.target))
    if (same) replace.add(same.id)
    // 同一集换了个视频文件（比如 mkv → mp4）：旧的视频链接一并替换掉
    if (item.kind === 'video')
      for (const l of kept)
        if (l.kind === 'video' && l.season === item.season && l.episode === item.episode) replace.add(l.id)

    // ── 不是本工具创建的（Sonarr 导入的、手动放的）──
    const foreign = new Set<string>()
    if (!same && !freed.has(norm(item.target)) && (await exists(onDisk(item.target)))) foreign.add(onDisk(item.target))
    if (item.kind === 'video')
      for (const f of foreignVideos)
        if (f.slots.some((s) => s.season === item.season && s.episode === item.episode)) foreign.add(f.path)
    item.removes = [...foreign]

    const notes: string[] = []
    if (replace.size) notes.push('替换之前导入的文件')
    let blocked = ''
    for (const p of foreign) {
      const name = path.basename(p)
      if (path.resolve(p) === path.resolve(item.path)) blocked = '源文件本身就在媒体库的这个目录里'
      else if (req.existing === 'skip') blocked = `媒体库里已有这一集的文件：${name}`
      else {
        const { safe, why } = await safeToReplace(p, item.path)
        if (!safe && req.existing !== 'force')
          blocked = `已有文件「${name}」${why}，可能是不同的版本。确认要替换的话，把「已有文件」改成「强制替换」`
        else notes.push(`删除已有文件：${name}（${why}）`)
      }
      if (blocked) break
    }
    if (blocked) {
      fail(blocked)
      continue
    }
    if (notes.length) {
      item.status = 'replace'
      item.message = notes.join('\n')
      replaces[replaces.length - 1] = [...replace]
    }
  }
  return { items, replaces, adopt }
}

export async function executeImport(req: ImportRequest): Promise<ImportResult> {
  assertImportable(getMediaDetail(req.mediaId).media)
  const d = db()
  const warnings: string[] = []
  if (req.replaceSource) {
    const old = getMediaDetail(req.mediaId).links.filter(
      (l) => l.sourceType === req.sourceType && l.sourceRef === req.sourceRef,
    )
    await removeLinks(old.map((l) => l.id))
  }

  // 接管媒体库里已有的目录：改成本工具的命名，里面的东西原样保留，之后逐集替换
  const first = await planImport({ ...req, replaceSource: false })
  const adopt = first.items.some((i) => i.status !== 'error') ? first.adopt : null
  if (adopt) {
    try {
      await fs.rename(adopt.from, adopt.to)
    } catch (e) {
      throw badRequest(`接管已有目录失败（${adopt.from}）：${linkErrorHint(e, req.linkMode)}`)
    }
    d.update(schema.media).set({ folderPath: adopt.to }).where(eq(schema.media.id, req.mediaId)).run()
  }
  const plan = adopt ? await planImport({ ...req, replaceSource: false }) : first

  const isManaged = (() => {
    const set = new Set([
      ...getMediaDetail(req.mediaId).links.map((l) => norm(l.targetPath)),
      ...d
        .select()
        .from(schema.artifacts)
        .where(eq(schema.artifacts.mediaId, req.mediaId))
        .all()
        .map((a) => norm(a.path)),
      ...plan.items.map((i) => norm(i.target)),
    ])
    return (p: string) => set.has(norm(p))
  })()

  const results: ImportResult['items'] = []
  for (const [i, item] of plan.items.entries()) {
    if (item.status === 'error') {
      results.push({ ...item, done: false })
      continue
    }
    try {
      await removeLinks(plan.replaces[i])
      for (const old of item.removes) {
        await fs.rm(old, { force: true })
        if (item.kind === 'video') await renameSidecars(old, item.target, isManaged)
      }
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

  warnings.push(...(await syncMedia(req.mediaId)).warnings)
  d.update(schema.media).set({ updatedAt: Date.now() }).where(eq(schema.media.id, req.mediaId)).run()
  if (req.markImported && req.sourceType === 'torrent' && results.some((r) => r.done))
    setTorrentState(req.sourceRef, 'imported', req.sourceName)

  // sync 之后路径可能被重命名（movie 从单片变多片），以数据库为准回填
  const bySource = new Map(getMediaDetail(req.mediaId).links.map((l) => [l.sourcePath + '|' + l.suffix, l.targetPath]))
  for (const r of results)
    if (r.done) r.target = bySource.get(path.resolve(r.path) + '|' + r.suffix) ?? r.target
  return { items: results, warnings }
}
