import type { Episode, Media, Season } from '@automedia/shared'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function tag(name: string, value: string | number | null | undefined, attrs = ''): string {
  if (value === null || value === undefined || value === '') return ''
  return `  <${name}${attrs}>${esc(String(value))}</${name}>\n`
}

function doc(root: string, body: string): string {
  return `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<${root}>\n${body}</${root}>\n`
}

const lockTag = (lock: boolean) => (lock ? tag('lockdata', 'true') : '')

function idTags(m: Media): string {
  const primary = m.kind === 'series' ? ['tvdb', 'tmdb', 'imdb'] : ['tmdb', 'imdb', 'tvdb']
  const values: Record<string, string> = { tvdb: m.tvdbId.trim(), tmdb: m.tmdbId.trim(), imdb: m.imdbId.trim() }
  const def = primary.find((k) => values[k])
  let out = tag('tvdbid', values.tvdb) + tag('tmdbid', values.tmdb) + tag('imdbid', values.imdb)
  for (const k of primary) out += tag('uniqueid', values[k], ` type="${k}"${k === def ? ' default="true"' : ''}`)
  return out
}

function commonTags(m: Media): string {
  return (
    tag('rating', m.rating) +
    m.genres.map((g) => tag('genre', g)).join('') +
    m.studios.map((s) => tag('studio', s)).join('') +
    idTags(m)
  )
}

export function tvshowNfo(m: Media, lock: boolean): string {
  return doc(
    'tvshow',
    tag('title', m.title) +
      tag('originaltitle', m.originalTitle) +
      tag('sorttitle', m.sortTitle) +
      tag('plot', m.overview) +
      tag('year', m.year) +
      tag('premiered', m.premiered) +
      tag('status', m.status) +
      commonTags(m) +
      lockTag(lock),
  )
}

export function seasonNfo(number: number, season: Season | undefined, lock: boolean): string {
  return doc(
    'season',
    tag('title', season?.title || (number === 0 ? 'Specials' : `Season ${number}`)) +
      tag('plot', season?.overview) +
      tag('seasonnumber', number) +
      lockTag(lock),
  )
}

export function episodeNfo(season: number, episode: number, ep: Episode | undefined, lock: boolean): string {
  return doc(
    'episodedetails',
    tag('title', ep?.title) +
      tag('plot', ep?.overview) +
      tag('season', season) +
      tag('episode', episode) +
      tag('aired', ep?.airDate) +
      tag('runtime', ep?.runtime ? Math.round(ep.runtime) : null) +
      lockTag(lock),
  )
}

/** multiFilm 时每「集」是一部独立的片，Media 标题作为合集名 */
export function movieNfo(m: Media, ep: Episode | undefined, multiFilm: boolean, lock: boolean): string {
  const date = multiFilm ? ep?.airDate || '' : m.premiered || ep?.airDate || ''
  const year = /^\d{4}/.test(date) ? date.slice(0, 4) : m.year
  return doc(
    'movie',
    tag('title', multiFilm ? ep?.title || m.title : m.title) +
      tag('originaltitle', multiFilm ? '' : m.originalTitle) +
      tag('sorttitle', multiFilm ? '' : m.sortTitle) +
      tag('plot', multiFilm ? ep?.overview || '' : m.overview || ep?.overview || '') +
      tag('year', year) +
      tag('premiered', date) +
      tag('runtime', ep?.runtime ? Math.round(ep.runtime) : null) +
      (multiFilm
        ? `  <set>\n  ${tag('name', m.title)}  </set>\n` + m.genres.map((g) => tag('genre', g)).join('')
        : commonTags(m)) +
      lockTag(lock),
  )
}
