import path from 'node:path'
import { pad2, type Episode, type Media, type Season } from '@automedia/shared'

/**
 * 媒体库里的目录 / 文件命名。所有命名规则都集中在这个文件里。
 *
 * series（Emby 剧集）:
 *   <标题> (<年份>) [tvdbid=123]/Season 01/<标题> - S01E01.mkv
 *   <标题> (<年份>) [tvdbid=123]/Season 01/<标题> - S01E01.chs.ass
 *   特别篇放 Season 00
 *
 * movie（一个 Media 只有一部片）:
 *   <标题> (<年份>) [tmdbid=123]/<标题> (<年份>).mkv
 * movie（一个 Media 有多部片，如三部曲，每「集」是一部片）:
 *   <标题> (<年份>) [tmdbid=123]/<该集标题> (<该集年份>).mkv
 *
 * comic（Emby 图片库，按文件夹浏览；一集是一个文件夹，里面的图片按顺序编号）:
 *   <标题>/001 - <集标题>/0001.jpg                 只有一季时不建季文件夹
 *   <标题>/S01 - <季标题>/001 - <集标题>/0001.jpg   有多季时
 *   文件名一律补零，任何按文件名排序的看图方式顺序都是对的；手动调整顺序就是重新编号。
 *
 * comic，CBZ 模式（Emby 书籍库；一集是一个 cbz，页面打包在里面，不单独落盘）:
 *   <标题>/<标题> - 001 - <集标题>.cbz
 *   <标题>/S01 - <季标题>/<标题> - S01E001 - <集标题>.cbz
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

type LayoutMedia = Pick<Media, 'kind' | 'title' | 'year' | 'tvdbId' | 'tmdbId' | 'imdbId'> & Partial<Pick<Media, 'comicFormat'>>
type Slot = { season: number; episode: number }

const slotKey = (season: number, episode: number) => `${season}:${episode}`

export function mediaFolderName(m: LayoutMedia): string {
  const ids: [string, string][] =
    m.kind === 'series'
      ? [['tvdbid', m.tvdbId], ['tmdbid', m.tmdbId], ['imdbid', m.imdbId]]
      : m.kind === 'movie'
        ? [['tmdbid', m.tmdbId], ['imdbid', m.imdbId]]
        : []
  const id = ids.find(([, v]) => v.trim())
  const year = m.year ? ` (${m.year})` : ''
  return `${sanitizeName(m.title)}${year}${id ? ` [${id[0]}=${id[1].trim()}]` : ''}`
}

export interface Layout {
  folderName: string
  /** 一个 movie 类型的 Media 下有多部片 */
  multiFilm: boolean
  /** comic：有不止一季 */
  multiSeason: boolean
  /** 季文件夹（相对 Media 目录），可能为空串 */
  relDir(season: number): string
  /** comic：这一集的文件夹，CBZ 模式下是这一集的 .cbz 文件（都相对 Media 目录）；其他类型等于 relDir */
  episodeDir(season: number, episode: number): string
  /** 不含扩展名的文件名 */
  baseName(season: number, episode: number): string
  linkRel(link: Slot & { suffix: string; ext: string; position?: number }): string
}

export interface LayoutOptions {
  /** 磁盘上已有的季文件夹（季号 → 文件夹名），有就沿用，见 existing.ts。只对 series 有意义 */
  seasonDirs?: Map<number, string>
  /** 季的元数据，comic 用它的标题给季文件夹命名 */
  seasons?: Season[]
}

/**
 * @param episodes Media 的集元数据
 * @param slots    已有 / 即将创建的链接所占用的 (季, 集)，用来判断 movie 是否多片、comic 是否多季
 */
export function buildLayout(
  media: LayoutMedia,
  episodes: Episode[],
  slots: Slot[],
  opts: LayoutOptions = {},
): Layout {
  const title = sanitizeName(media.title)
  const yearTag = media.year ? ` (${media.year})` : ''
  const epMap = new Map(episodes.map((e) => [slotKey(e.season, e.number), e]))

  const all = new Map<string, Slot>()
  for (const e of episodes) all.set(slotKey(e.season, e.number), { season: e.season, episode: e.number })
  for (const s of slots) all.set(slotKey(s.season, s.episode), s)
  const ordered = [...all.values()].sort((a, b) => a.season - b.season || a.episode - b.episode)
  const multiFilm = media.kind === 'movie' && ordered.length > 1

  if (media.kind === 'comic') {
    const seasonTitles = new Map((opts.seasons ?? []).map((s) => [s.number, clean(s.title)]))
    const seasonNumbers = new Set([...ordered.map((s) => s.season), ...seasonTitles.keys()])
    const multiSeason = seasonNumbers.size > 1
    const withTitle = (prefix: string, t: string) => (t ? `${prefix} - ${t}` : prefix)
    const relDir = (season: number) =>
      multiSeason ? withTitle(`S${pad2(season)}`, seasonTitles.get(season) ?? '') : ''
    const cbz = media.comicFormat === 'cbz'
    const epTitle = (season: number, episode: number) => clean(epMap.get(slotKey(season, episode))?.title ?? '')
    const num = (episode: number) => String(episode).padStart(3, '0')
    const episodeDir = (season: number, episode: number) =>
      path.join(
        relDir(season),
        cbz
          ? `${withTitle(`${title} - ${multiSeason ? `S${pad2(season)}E${num(episode)}` : num(episode)}`, epTitle(season, episode))}.cbz`
          : withTitle(num(episode), epTitle(season, episode)),
      )
    const pageName = (l: { position?: number; ext: string }) => `${String(l.position ?? 0).padStart(4, '0')}.${l.ext}`
    return {
      folderName: mediaFolderName(media),
      multiFilm: false,
      multiSeason,
      relDir,
      episodeDir,
      baseName: (season, episode) => path.basename(episodeDir(season, episode)),
      // CBZ 模式下页面不单独落盘，这里给的是一个「包内位置」：<那一集>.cbz#0001.jpg，只用来在数据库里唯一标识这一页
      linkRel: (l) =>
        cbz ? `${episodeDir(l.season, l.episode)}#${pageName(l)}` : path.join(episodeDir(l.season, l.episode), pageName(l)),
    }
  }

  const relDir = (season: number) =>
    media.kind === 'series' ? (opts.seasonDirs?.get(season) ?? `Season ${pad2(season)}`) : ''

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
    multiSeason: false,
    relDir,
    episodeDir: relDir,
    baseName,
    linkRel: (l) =>
      path.join(relDir(l.season), `${baseName(l.season, l.episode)}${l.suffix ? `.${l.suffix}` : ''}.${l.ext}`),
  }
}
