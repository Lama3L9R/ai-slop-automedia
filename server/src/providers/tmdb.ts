import type { Episode, LookupBy, MediaKind, ProviderSearchResult, Season } from '@automedia/shared'
import { AppError, badRequest, errMsg } from '../errors'
import { getSettings } from '../settings'
import { extFetch } from '../util/http'
import type { MetadataProvider, ProviderMedia } from './types'

const API = 'https://api.themoviedb.org/3'
const IMG = 'https://image.tmdb.org/t/p/original'
const img = (p: string | null | undefined) => (p ? IMG + p : '')
const yearOf = (date: string | null | undefined) => (date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null)

async function call<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const { apiKey, language } = getSettings().tmdb
  const key = apiKey.trim()
  if (!key) throw badRequest('还没有配置 TMDB API Key（设置 → 元数据）')
  const url = new URL(API + path)
  url.searchParams.set('language', language || 'zh-CN')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const headers: Record<string, string> = { accept: 'application/json' }
  // v4 的 Read Access Token 是 JWT，走 Bearer；v3 的 API Key 走查询参数
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`
  else url.searchParams.set('api_key', key)

  let res
  try {
    res = await extFetch(url, { headers })
  } catch (e) {
    throw new AppError(502, `连接 TMDB 失败：${errMsg(e)}（网络不通时可在设置里配置代理）`)
  }
  if (res.status === 401) throw badRequest('TMDB API Key 无效')
  if (res.status === 404) throw new AppError(404, 'TMDB 上没有找到对应条目')
  if (!res.ok) throw new AppError(502, `TMDB 返回 HTTP ${res.status}`)
  return (await res.json()) as T
}

interface TvBrief {
  id: number
  name: string
  original_name: string
  first_air_date?: string
  overview?: string
  poster_path?: string | null
}
interface MovieBrief {
  id: number
  title: string
  original_title: string
  release_date?: string
  overview?: string
  poster_path?: string | null
}

const tvResult = (r: TvBrief): ProviderSearchResult => ({
  provider: 'tmdb',
  kind: 'series',
  id: String(r.id),
  title: r.name,
  originalTitle: r.original_name,
  year: yearOf(r.first_air_date),
  overview: r.overview ?? '',
  posterUrl: img(r.poster_path),
})
const movieResult = (r: MovieBrief): ProviderSearchResult => ({
  provider: 'tmdb',
  kind: 'movie',
  id: String(r.id),
  title: r.title,
  originalTitle: r.original_title,
  year: yearOf(r.release_date),
  overview: r.overview ?? '',
  posterUrl: img(r.poster_path),
})

/** 只在一种类型（剧集 / 电影）里查。按 ID 查不到时返回空数组而不是报错，方便换类型重试 */
async function searchKind(kind: MediaKind, by: LookupBy, q: string): Promise<ProviderSearchResult[]> {
  if (by === 'tvdb') return find(kind, 'tvdb_id', q)
  if (by === 'imdb') return find(kind, 'imdb_id', q)
  if (by === 'tmdb') {
    // 「687163-project-hail-mary」这种带名字的写法：取前面的数字
    const id = /^\d+/.exec(q)?.[0]
    if (!id) throw badRequest('TMDB ID 是一串数字，比如 687163（也可以直接粘贴 TMDB 的页面链接）')
    try {
      return kind === 'series'
        ? [tvResult(await call<TvBrief>(`/tv/${id}`))]
        : [movieResult(await call<MovieBrief>(`/movie/${id}`))]
    } catch (e) {
      if (e instanceof AppError && e.status === 404) return []
      throw e
    }
  }
  if (kind === 'series') return (await call<{ results: TvBrief[] }>('/search/tv', { query: q })).results.map(tvResult)
  return (await call<{ results: MovieBrief[] }>('/search/movie', { query: q })).results.map(movieResult)
}

async function find(kind: MediaKind, source: 'tvdb_id' | 'imdb_id', id: string): Promise<ProviderSearchResult[]> {
  const r = await call<{ tv_results: TvBrief[]; movie_results: MovieBrief[] }>(`/find/${encodeURIComponent(id)}`, {
    external_source: source,
  })
  return kind === 'series' ? r.tv_results.map(tvResult) : r.movie_results.map(movieResult)
}

const STATUS: Record<string, string> = {
  'Returning Series': 'Continuing',
  'In Production': 'Continuing',
  Ended: 'Ended',
  Canceled: 'Ended',
}

interface TvDetail extends TvBrief {
  status?: string
  vote_average?: number
  backdrop_path?: string | null
  genres?: { name: string }[]
  networks?: { name: string }[]
  production_companies?: { name: string }[]
  seasons?: { season_number: number; name?: string; overview?: string; poster_path?: string | null }[]
  external_ids?: { tvdb_id?: number | null; imdb_id?: string | null }
}
interface SeasonDetail {
  episodes?: {
    episode_number: number
    name?: string
    overview?: string
    air_date?: string | null
    runtime?: number | null
    still_path?: string | null
  }[]
}
interface MovieDetail extends MovieBrief {
  vote_average?: number
  backdrop_path?: string | null
  runtime?: number | null
  imdb_id?: string | null
  genres?: { name: string }[]
  production_companies?: { name: string }[]
}

async function fetchTv(id: string): Promise<ProviderMedia> {
  const d = await call<TvDetail>(`/tv/${encodeURIComponent(id)}`, { append_to_response: 'external_ids' })
  const seasons: Season[] = (d.seasons ?? []).map((s) => ({
    number: s.season_number,
    // TMDB 的默认季名（"第 1 季" / "Season 1"）没有信息量，不存
    title: /^(第\s*\d+\s*季|Season \d+|特别篇|Specials)$/i.test(s.name ?? '') ? '' : (s.name ?? ''),
    overview: s.overview ?? '',
    posterUrl: img(s.poster_path),
  }))
  const episodes: Episode[] = []
  for (let i = 0; i < seasons.length; i += 5) {
    const batch = seasons.slice(i, i + 5)
    const details = await Promise.all(
      batch.map((s) => call<SeasonDetail>(`/tv/${encodeURIComponent(id)}/season/${s.number}`)),
    )
    details.forEach((sd, j) => {
      for (const e of sd.episodes ?? [])
        episodes.push({
          season: batch[j].number,
          number: e.episode_number,
          title: e.name ?? '',
          overview: e.overview ?? '',
          airDate: e.air_date ?? '',
          runtime: e.runtime ?? null,
          stillUrl: img(e.still_path),
        })
    })
  }
  return {
    media: {
      kind: 'series',
      title: d.name,
      originalTitle: d.original_name ?? '',
      sortTitle: '',
      year: yearOf(d.first_air_date),
      premiered: d.first_air_date ?? '',
      status: STATUS[d.status ?? ''] ?? d.status ?? '',
      overview: d.overview ?? '',
      rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
      genres: (d.genres ?? []).map((g) => g.name),
      studios: [...(d.networks ?? []), ...(d.production_companies ?? [])].map((s) => s.name).slice(0, 5),
      tvdbId: d.external_ids?.tvdb_id ? String(d.external_ids.tvdb_id) : '',
      tmdbId: String(d.id),
      imdbId: d.external_ids?.imdb_id ?? '',
      posterUrl: img(d.poster_path),
      fanartUrl: img(d.backdrop_path),
    },
    seasons,
    episodes,
  }
}

async function fetchMovie(id: string): Promise<ProviderMedia> {
  const d = await call<MovieDetail>(`/movie/${encodeURIComponent(id)}`)
  return {
    media: {
      kind: 'movie',
      title: d.title,
      originalTitle: d.original_title ?? '',
      sortTitle: '',
      year: yearOf(d.release_date),
      premiered: d.release_date ?? '',
      status: '',
      overview: d.overview ?? '',
      rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
      genres: (d.genres ?? []).map((g) => g.name),
      studios: (d.production_companies ?? []).map((s) => s.name).slice(0, 5),
      tvdbId: '',
      tmdbId: String(d.id),
      imdbId: d.imdb_id ?? '',
      posterUrl: img(d.poster_path),
      fanartUrl: img(d.backdrop_path),
    },
    // 电影 = 1 季 1 集；想把三部曲放进同一个 Media，在管理页手动加「集」即可
    seasons: [{ number: 1, title: '', overview: '', posterUrl: '' }],
    episodes: [
      {
        season: 1,
        number: 1,
        title: d.title,
        overview: d.overview ?? '',
        airDate: d.release_date ?? '',
        runtime: d.runtime ?? null,
        stillUrl: '',
      },
    ],
  }
}

export const tmdbProvider: MetadataProvider = {
  id: 'tmdb',
  label: 'TMDB',
  lookups: ['name', 'tvdb', 'tmdb', 'imdb'],

  async search(kind: MediaKind, by: LookupBy, query: string) {
    const q = query.trim()
    if (!q) return []
    // 直接粘贴的 TMDB 页面链接：themoviedb.org/movie/687163-project-hail-mary → 按链接里的类型和 ID 查
    const link = /themoviedb\.org\/(movie|tv)\/(\d+)/i.exec(q)
    if (link) return searchKind(link[1].toLowerCase() === 'tv' ? 'series' : 'movie', 'tmdb', link[2])
    if (by === 'tvdb') {
      if (kind === 'movie') throw badRequest('TMDB 不支持用 TVDB ID 查电影，请用 TMDB / IMDb ID 或名称')
      return searchKind(kind, by, q)
    }
    const found = await searchKind(kind, by, q)
    if (found.length) return found
    // 选的类型下没有：换另一种再查一次。最常见的是查电影时「类型」还停在默认的「剧集」，
    // 这时 TMDB ID 687163 会被当成剧集的 ID 去查，名称也只在剧集里搜
    return searchKind(kind === 'series' ? 'movie' : 'series', by, q)
  },

  fetch(kind, id) {
    return kind === 'series' ? fetchTv(id) : fetchMovie(id)
  },

  async resolveId(media) {
    if (media.tmdbId.trim()) return media.tmdbId.trim()
    if (media.kind === 'series' && media.tvdbId.trim()) {
      const r = await find('series', 'tvdb_id', media.tvdbId.trim())
      if (r[0]) return r[0].id
    }
    if (media.imdbId.trim()) {
      const r = await find(media.kind, 'imdb_id', media.imdbId.trim())
      if (r[0]) return r[0].id
    }
    return null
  },
}
