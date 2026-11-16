import type {
  Episode,
  FileKind,
  Link,
  LinkMode,
  Media,
  MediaDetail,
  MediaKind,
  MediaListItem,
  MediaSaveInput,
  Season,
  SourceType,
} from '@automedia/shared'
import { asc, eq, inArray, sql } from 'drizzle-orm'
import { db, schema } from '../db'
import { badRequest, notFound } from '../errors'
import { pruneEmptyDirs, removeFile } from '../util/fs'

type MediaRow = typeof schema.media.$inferSelect
type LinkRow = typeof schema.links.$inferSelect

export const rowToMedia = (r: MediaRow): Media => ({ ...r, kind: r.kind as MediaKind })

export const rowToLink = (r: LinkRow): Link => ({
  ...r,
  kind: r.kind as FileKind,
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
  const epMap = new Map(eps.map((r) => [r.mediaId, r.n]))
  const vidMap = new Map(vids.map((r) => [r.mediaId, r.n]))
  return d
    .select()
    .from(schema.media)
    .all()
    .map((r) => ({ ...rowToMedia(r), episodeCount: epMap.get(r.id) ?? 0, videoCount: vidMap.get(r.id) ?? 0 }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getMedia(id: number): Media {
  const row = db().select().from(schema.media).where(eq(schema.media.id, id)).get()
  if (!row) throw notFound(`Media #${id} 不存在`)
  return rowToMedia(row)
}

export function getLinks(mediaId: number): Link[] {
  return db()
    .select()
    .from(schema.links)
    .where(eq(schema.links.mediaId, mediaId))
    .orderBy(asc(schema.links.season), asc(schema.links.episode), asc(schema.links.kind), asc(schema.links.suffix))
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
  return { media, seasons, episodes, links: getLinks(id) }
}

/** 校验并补齐：集引用到的季自动建出来；同一 (季, 集) 不允许重复 */
function normalize(input: MediaSaveInput): { seasons: Season[]; episodes: Episode[] } {
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

export function createMedia(input: MediaSaveInput): number {
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

export function saveMedia(id: number, input: MediaSaveInput): void {
  getMedia(id)
  const { seasons, episodes } = normalize(input)
  db().transaction((tx) => {
    tx.update(schema.media)
      .set({ ...input.media, updatedAt: Date.now() })
      .where(eq(schema.media.id, id))
      .run()
    writeChildren(tx, id, seasons, episodes)
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
  if (media.folderPath) await pruneEmptyDirs(media.folderPath)
  d.transaction((tx) => {
    tx.delete(schema.links).where(eq(schema.links.mediaId, id)).run()
    tx.delete(schema.artifacts).where(eq(schema.artifacts.mediaId, id)).run()
    tx.delete(schema.seasons).where(eq(schema.seasons.mediaId, id)).run()
    tx.delete(schema.episodes).where(eq(schema.episodes.mediaId, id)).run()
    tx.delete(schema.media).where(eq(schema.media.id, id)).run()
  })
}
