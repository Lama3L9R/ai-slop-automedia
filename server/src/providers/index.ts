import type { Episode, MediaDetail, MediaInput, Season } from '@automedia/shared'
import type { SaveInput } from '../media/store'
import { badRequest } from '../errors'
import { tmdbProvider } from './tmdb'
import type { MetadataProvider, ProviderMedia } from './types'

const registry = new Map<string, MetadataProvider>([[tmdbProvider.id, tmdbProvider]])

export function getProvider(id: string): MetadataProvider {
  const p = registry.get(id)
  if (!p) throw badRequest(`未知的元数据来源：${id}`)
  return p
}

export const listProviders = () => [...registry.values()].map((p) => ({ id: p.id, label: p.label, lookups: p.lookups }))

const isEmpty = (v: unknown) => v === '' || v === null || v === undefined || (Array.isArray(v) && v.length === 0)

/** 逐字段补空：current 有值就保留 */
function fill<T extends object>(current: T, incoming: T): T {
  const out = { ...current }
  for (const k of Object.keys(incoming) as (keyof T)[]) if (isEmpty(out[k])) out[k] = incoming[k]
  return out
}

/**
 * 把上游数据合并进已有 Media。
 * - fill：只补全空字段，补上缺失的季和集
 * - overwrite：上游有的字段和季/集以上游为准
 * 两种模式都不会删除上游没有的季和集（那正是用户手动补的数据）。
 */
export function mergeProvider(
  current: MediaDetail,
  incoming: ProviderMedia,
  mode: 'fill' | 'overwrite',
): SaveInput {
  const { id: _i, folderPath: _f, createdAt: _c, updatedAt: _u, ...cur } = current.media
  const inc: MediaInput = {
    ...incoming.media,
    kind: cur.kind,
    libraryId: cur.libraryId,
    comicFormat: cur.comicFormat,
    importLocked: cur.importLocked,
  }
  const media = mode === 'overwrite' ? fill(inc, cur) : fill(cur, inc)

  const seasonMap = new Map<number, Season>(current.seasons.map((s) => [s.number, s]))
  for (const s of incoming.seasons) {
    const old = seasonMap.get(s.number)
    seasonMap.set(s.number, !old ? s : mode === 'overwrite' ? fill(s, old) : fill(old, s))
  }
  const key = (e: Episode) => `${e.season}:${e.number}`
  const epMap = new Map<string, Episode>(current.episodes.map((e) => [key(e), e]))
  for (const e of incoming.episodes) {
    const old = epMap.get(key(e))
    epMap.set(key(e), !old ? e : mode === 'overwrite' ? fill(e, old) : fill(old, e))
  }
  return { media, seasons: [...seasonMap.values()], episodes: [...epMap.values()] }
}
