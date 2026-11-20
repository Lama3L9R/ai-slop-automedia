import type {
  ComicFormat,
  Episode,
  Link,
  LinkKind,
  LinkMode,
  Media,
  MediaDetail,
  MediaKind,
  MediaListItem,
  MediaSaveInput,
  PageCount,
  Season,
  SourceType,
} from '@automedia/shared'
import { asc, eq, inArray, sql } from 'drizzle-orm'
import { db, schema } from '../db'
import { badRequest, notFound } from '../errors'
import { pruneEmptyDirs, removeFile } from '../util/fs'
import { removeLocalPoster } from './poster'

type MediaRow = typeof schema.media.$inferSelect
type LinkRow = typeof schema.links.$inferSelect

export const rowToMedia = (r: MediaRow): Media => ({
  ...r,
  kind: r.kind as MediaKind,
  comicFormat: r.comicFormat as ComicFormat,
})

export const rowToLink = (r: LinkRow): Link => ({
  ...r,
  kind: r.kind as LinkKind,
  sourceType: r.sourceType as SourceType,
  linkMode: r.linkMode as LinkMode,
})

export function listMedia(): MediaListItem[] {
  const d = db()
  const count = sql<number>`count(*)`
  const eps = d
    .select({ mediaId: schema.episodes.mediaId, n: count })
    .from(schema.episodes)
    .groupBy(schema.episodes.mediaId)
    .all()
  const vids = d
    .select({ mediaId: schema.links.mediaId, n: count })
    .from(schema.links)
    .where(eq(schema.links.kind, 'video'))
    .groupBy(schema.links.mediaId)
    .all()
  // 漫画：有页面的集数
  const comics = d
    .select({ mediaId: schema.links.mediaId, n: sql<number>`count(distinct ${schema.links.season} * 100000 + ${schema.links.episode})` })
    .from(schema.links)
    .where(eq(schema.links.kind, 'page'))
    .groupBy(schema.links.mediaId)
    .all()
  // 还空着的集：元数据里有，但还没有视频（漫画：没有页面）
  const missing = d
    .select({ mediaId: schema.episodes.mediaId, n: count })
    .from(schema.episodes)
    .where(
      sql`not exists (select 1 from ${schema.links} as l where l.media_id = ${schema.episodes.mediaId}
        and l.season = ${schema.episodes.season} and l.episode = ${schema.episodes.number} and l.kind in ('video', 'page'))`,
    )
    .groupBy(schema.episodes.mediaId)
    .all()
  const epMap = new Map(eps.map((r) => [r.mediaId, r.n]))
  const vidMap = new Map([...vids, ...comics].map((r) => [r.mediaId, r.n]))
  const missMap = new Map(missing.map((r) => [r.mediaId, r.n]))
  return d
    .select()
    .from(schema.media)
    .all()
    .map((r) => ({
      ...rowToMedia(r),
      episodeCount: epMap.get(r.id) ?? 0,
      videoCount: vidMap.get(r.id) ?? 0,
      missingCount: missMap.get(r.id) ?? 0,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getMedia(id: number): Media {
  const row = db().select().from(schema.media).where(eq(schema.media.id, id)).get()
  if (!row) throw notFound(`媒体 #${id} 不存在`)
  return rowToMedia(row)
}

export function getLinks(mediaId: number): Link[] {
  return db()
    .select()
    .from(schema.links)
    .where(eq(schema.links.mediaId, mediaId))
    .orderBy(
      asc(schema.links.season),
      asc(schema.links.episode),
      asc(schema.links.kind),
      asc(schema.links.position),
      asc(schema.links.suffix),
    )
    .all()
    .map(rowToLink)
}

export function getMediaDetail(id: number): MediaDetail {
  const d = db()
  const media = getMedia(id)
  const seasons: Season[] = d
    .select()
    .from(schema.seasons)
    .where(eq(schema.seasons.mediaId, id))
    .orderBy(asc(schema.seasons.number))
    .all()
    .map(({ mediaId: _m, ...s }) => s)
  const episodes: Episode[] = d
    .select()
    .from(schema.episodes)
    .where(eq(schema.episodes.mediaId, id))
    .orderBy(asc(schema.episodes.season), asc(schema.episodes.number))
    .all()
    .map(({ mediaId: _m, ...e }) => e)
  const links = getLinks(id)
  const counts = new Map<string, PageCount>()
  for (const l of links) {
    if (l.kind !== 'page') continue
    const k = `${l.season}:${l.episode}`
    const c = counts.get(k) ?? { season: l.season, episode: l.episode, count: 0 }
    c.count++
    counts.set(k, c)
  }
  return { media, seasons, episodes, links, pageCounts: [...counts.values()] }
}

/** 校验并补齐：集引用到的季自动建出来；同一 (季, 集) 不允许重复 */
/** seasonMoves 可省略的保存入参（内部调用、测试用） */
export type SaveInput = Omit<MediaSaveInput, 'seasonMoves'> & Partial<Pick<MediaSaveInput, 'seasonMoves'>>

function normalize(input: SaveInput): { seasons: Season[]; episodes: Episode[] } {
  const seen = new Set<string>()
  for (const e of input.episodes) {
    const k = `${e.season}:${e.number}`
    if (seen.has(k)) throw badRequest(`第 ${e.season} 季第 ${e.number} 集重复了`)
    seen.add(k)
  }
  const seasonMap = new Map<number, Season>()
  for (const s of input.seasons) {
    if (seasonMap.has(s.number)) throw badRequest(`第 ${s.number} 季重复了`)
    seasonMap.set(s.number, s)
  }
  for (const e of input.episodes)
    if (!seasonMap.has(e.season)) seasonMap.set(e.season, { number: e.season, title: '', overview: '', posterUrl: '' })
  return {
    seasons: [...seasonMap.values()].sort((a, b) => a.number - b.number),
    episodes: [...input.episodes].sort((a, b) => a.season - b.season || a.number - b.number),
  }
}

type Tx = Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0]

function writeChildren(tx: Tx, mediaId: number, seasons: Season[], episodes: Episode[]) {
  tx.delete(schema.seasons).where(eq(schema.seasons.mediaId, mediaId)).run()
  tx.delete(schema.episodes).where(eq(schema.episodes.mediaId, mediaId)).run()
  if (seasons.length)
    tx.insert(schema.seasons)
      .values(seasons.map((s) => ({ mediaId, ...s })))
      .run()
  for (let i = 0; i < episodes.length; i += 500)
    tx.insert(schema.episodes)
      .values(episodes.slice(i, i + 500).map((e) => ({ mediaId, ...e })))
      .run()
}

export function createMedia(input: SaveInput): number {
  const { seasons, episodes } = normalize(input)
  const now = Date.now()
  return db().transaction((tx) => {
    const row = tx
      .insert(schema.media)
      .values({ ...input.media, folderPath: '', createdAt: now, updatedAt: now })
      .returning({ id: schema.media.id })
      .get()
    writeChildren(tx, row.id, seasons, episodes)
    return row.id
  })
}

export function saveMedia(id: number, input: SaveInput): void {
  const before = getMedia(id)
  // 封面换成了别的：之前上传的那张本地文件不再有人用
  if (before.posterUrl !== input.media.posterUrl) void removeLocalPoster(before.posterUrl)
  const { seasons, episodes } = normalize(input)

  // 改了季号：已导入的文件跟着换季（磁盘上的改名由之后的 sync 完成）
  const moves = new Map((input.seasonMoves ?? []).filter((m) => m.from !== m.to).map((m) => [m.from, m.to]))
  const links = moves.size ? getLinks(id) : []
  const taken = new Set<string>()
  for (const l of links) {
    const key = `${moves.get(l.season) ?? l.season}:${l.episode}:${l.kind}:${l.suffix}:${l.ext}:${l.position}`
    if (taken.has(key))
      throw badRequest(
        `改季号之后，第 ${moves.get(l.season) ?? l.season} 季第 ${l.episode} 集会有两个同类文件。请先移除其中一个已导入的文件`,
      )
    taken.add(key)
  }

  db().transaction((tx) => {
    tx.update(schema.media)
      .set({ ...input.media, updatedAt: Date.now() })
      .where(eq(schema.media.id, id))
      .run()
    writeChildren(tx, id, seasons, episodes)
    for (const l of links) {
      const to = moves.get(l.season)
      if (to !== undefined) tx.update(schema.links).set({ season: to }).where(eq(schema.links.id, l.id)).run()
    }
  })
}

/** 删除链接文件和记录（不动源文件）。返回受影响的 mediaId，调用方负责之后 sync。 */
export async function removeLinks(ids: number[]): Promise<number[]> {
  if (!ids.length) return []
  const rows = db().select().from(schema.links).where(inArray(schema.links.id, ids)).all()
  for (const r of rows) await removeFile(r.targetPath)
  db().delete(schema.links).where(inArray(schema.links.id, ids)).run()
  return [...new Set(rows.map((r) => r.mediaId))]
}

export async function deleteMedia(id: number): Promise<void> {
  const media = getMedia(id)
  const d = db()
  const links = d.select().from(schema.links).where(eq(schema.links.mediaId, id)).all()
  const arts = d.select().from(schema.artifacts).where(eq(schema.artifacts.mediaId, id)).all()
  for (const l of links) await removeFile(l.targetPath)
  for (const a of arts) await removeFile(a.path)
  await removeLocalPoster(media.posterUrl)
  if (media.folderPath) await pruneEmptyDirs(media.folderPath)
  d.transaction((tx) => {
    tx.delete(schema.links).where(eq(schema.links.mediaId, id)).run()
    tx.delete(schema.artifacts).where(eq(schema.artifacts.mediaId, id)).run()
    tx.delete(schema.seasons).where(eq(schema.seasons.mediaId, id)).run()
    tx.delete(schema.episodes).where(eq(schema.episodes.mediaId, id)).run()
    tx.delete(schema.media).where(eq(schema.media.id, id)).run()
  })
}
