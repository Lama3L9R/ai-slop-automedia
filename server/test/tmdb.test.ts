import { beforeEach, describe, expect, it, vi } from 'vitest'

// 不连真的 TMDB：settings 给一个假 key，HTTP 请求交给下面这个假的 TMDB
vi.mock('../src/settings', () => ({ getSettings: () => ({ tmdb: { apiKey: 'test-key', language: 'zh-CN' } }) }))
const calls: string[] = []
vi.mock('../src/util/http', () => ({
  extFetch: async (input: URL | string) => {
    const url = new URL(String(input))
    const route = url.pathname.replace(/^\/3/, '')
    calls.push(`${route}${url.searchParams.get('query') ? `?${url.searchParams.get('query')}` : ''}`)
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    const hailMary = { id: 687163, title: '挽救计划', original_title: 'Project Hail Mary', release_date: '2026-03-20' }
    if (route === '/movie/687163') return json(hailMary)
    if (route === '/search/movie') return json({ results: url.searchParams.get('query') === 'Project Hail Mary' ? [hailMary] : [] })
    if (route === '/search/tv') return json({ results: [] })
    if (route === '/find/tt12042730') return json({ movie_results: [hailMary], tv_results: [] })
    if (route === '/tv/1399') return json({ id: 1399, name: '权力的游戏', original_name: 'Game of Thrones', first_air_date: '2011-04-17' })
    return json({ status_message: 'not found' }, 404)
  },
}))

const { tmdbProvider } = await import('../src/providers/tmdb')

describe('TMDB 搜索', () => {
  beforeEach(() => {
    calls.length = 0
  })
  const brief = (r: { kind: string; id: string; originalTitle: string }[]) => r.map((x) => [x.kind, x.id, x.originalTitle])

  it('类型停在「剧集」时也能按 TMDB ID / 名称 / IMDb ID 找到电影', async () => {
    expect(brief(await tmdbProvider.search('series', 'tmdb', '687163'))).toEqual([['movie', '687163', 'Project Hail Mary']])
    expect(calls).toEqual(['/tv/687163', '/movie/687163'])

    expect(brief(await tmdbProvider.search('series', 'name', 'Project Hail Mary'))).toEqual([['movie', '687163', 'Project Hail Mary']])
    expect(brief(await tmdbProvider.search('series', 'imdb', 'tt12042730'))).toEqual([['movie', '687163', 'Project Hail Mary']])
  })

  it('选对了类型就不多查', async () => {
    await tmdbProvider.search('movie', 'tmdb', '687163')
    expect(calls).toEqual(['/movie/687163'])
    expect(brief(await tmdbProvider.search('series', 'tmdb', '1399'))).toEqual([['series', '1399', 'Game of Thrones']])
  })

  it('接受 TMDB 页面链接和带名字的 ID', async () => {
    const url = 'https://www.themoviedb.org/movie/687163-project-hail-mary?language=en-CA'
    expect(brief(await tmdbProvider.search('series', 'name', url))).toEqual([['movie', '687163', 'Project Hail Mary']])
    expect(calls).toEqual(['/movie/687163'])
    expect(brief(await tmdbProvider.search('movie', 'tmdb', '687163-project-hail-mary'))).toHaveLength(1)
    await expect(tmdbProvider.search('movie', 'tmdb', 'project-hail-mary')).rejects.toThrow(/一串数字/)
  })

  it('两种类型都没有就是空结果，不报错', async () => {
    expect(await tmdbProvider.search('series', 'tmdb', '999999999')).toEqual([])
    expect(await tmdbProvider.search('movie', 'name', '不存在的作品')).toEqual([])
  })
})
