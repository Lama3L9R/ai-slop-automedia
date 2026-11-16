import path from 'node:path'
import { pad2, type Episode, type Media } from '@automedia/shared'

/**
 * 媒体库里的目录 / 文件命名（Emby 约定）。所有命名规则都集中在这个文件里。
 *
 * series:
 *   <标题> (<年份>) [tvdbid=123]/Season 01/<标题> - S01E01.mkv
 *   <标题> (<年份>) [tvdbid=123]/Season 01/<标题> - S01E01.chs.ass
 *   特别篇放 Season 00
 *
 * movie（一个 Media 只有一部片）:
 *   <标题> (<年份>) [tmdbid=123]/<标题> (<年份>).mkv
 * movie（一个 Media 有多部片，如三部曲，每「集」是一部片）:
 *   <标题> (<年份>) [tmdbid=123]/<该集标题> (<该集年份>).mkv
 */

function clean(name: string): string {
  return name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
}

export function sanitizeName(name: string): string {
  return clean(name) || 'Untitled'
}

type LayoutMedia = Pick<Media, 'kind' | 'title' | 'year' | 'tvdbId' | 'tmdbId' | 'imdbId'>
type Slot = { season: number; episode: number }

const slotKey = (season: number, episode: number) => `${season}:${episode}`

export function mediaFolderName(m: LayoutMedia): string {
  const ids: [string, string][] =
    m.kind === 'series'
      ? [['tvdbid', m.tvdbId], ['tmdbid', m.tmdbId], ['imdbid', m.imdbId]]
      : [['tmdbid', m.tmdbId], ['imdbid', m.imdbId]]
  const id = ids.find(([, v]) => v.trim())
  const year = m.year ? ` (${m.year})` : ''
  return `${sanitizeName(m.title)}${year}${id ? ` [${id[0]}=${id[1].trim()}]` : ''}`
}

export interface Layout {
  folderName: string
  /** 一个 movie 类型的 Media 下有多部片 */
  multiFilm: boolean
  /** 相对 Media 目录的子目录，可能为空串 */
  relDir(season: number): string
  /** 不含扩展名的文件名 */
  baseName(season: number, episode: number): string
  linkRel(link: Slot & { suffix: string; ext: string }): string
}

/**
 * @param episodes Media 的集元数据
 * @param slots    已有 / 即将创建的链接所占用的 (季, 集)，用来判断 movie 是否多片
 */
export function buildLayout(media: LayoutMedia, episodes: Episode[], slots: Slot[]): Layout {
  const title = sanitizeName(media.title)
  const yearTag = media.year ? ` (${media.year})` : ''
  const epMap = new Map(episodes.map((e) => [slotKey(e.season, e.number), e]))

  const all = new Map<string, Slot>()
  for (const e of episodes) all.set(slotKey(e.season, e.number), { season: e.season, episode: e.number })
  for (const s of slots) all.set(slotKey(s.season, s.episode), s)
  const ordered = [...all.values()].sort((a, b) => a.season - b.season || a.episode - b.episode)
  const multiFilm = media.kind === 'movie' && ordered.length > 1

  const relDir = (season: number) => (media.kind === 'series' ? `Season ${pad2(season)}` : '')

  const baseName = (season: number, episode: number) => {
    if (media.kind === 'series') return `${title} - S${pad2(season)}E${pad2(episode)}`
    if (!multiFilm) return `${title}${yearTag}`
    const ep = epMap.get(slotKey(season, episode))
    const name = clean(ep?.title ?? '')
    if (name) {
      const y = ep?.airDate.slice(0, 4) ?? ''
      return `${name}${/^\d{4}$/.test(y) ? ` (${y})` : ''}`
    }
    const idx = ordered.findIndex((s) => s.season === season && s.episode === episode) + 1
    return `${title} ${idx}`
  }

  return {
    folderName: mediaFolderName(media),
    multiFilm,
    relDir,
    baseName,
    linkRel: (l) =>
      path.join(relDir(l.season), `${baseName(l.season, l.episode)}${l.suffix ? `.${l.suffix}` : ''}.${l.ext}`),
  }
}
