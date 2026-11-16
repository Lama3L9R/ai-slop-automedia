import type { TorrentItem, TorrentState } from '@automedia/shared'
import { eq, sql } from 'drizzle-orm'
import { db, schema } from '../db'
import { AppError, badRequest, errMsg, notFound } from '../errors'
import { getSettings } from '../settings'

interface QbTorrent {
  hash: string
  name: string
  category: string
  tags: string
  size: number
  progress: number
  state: string
  added_on: number
  content_path: string
  save_path: string
}

let cookie = ''
let cookieFor = ''

function baseUrl(): string {
  const base = getSettings().qb.url.trim().replace(/\/+$/, '')
  if (!base) throw badRequest('还没有配置 qBittorrent 地址（设置 → qBittorrent）')
  return base
}

async function login(base: string): Promise<void> {
  const { username, password } = getSettings().qb
  const res = await fetch(`${base}/api/v2/auth/login`, {
    method: 'POST',
    headers: { Referer: base, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await res.text()
  if (!res.ok || text.trim() === 'Fails.')
    throw badRequest(
      res.status === 403 ? 'qBittorrent 拒绝登录（失败次数过多，IP 被暂时封禁）' : 'qBittorrent 登录失败，请检查用户名和密码',
    )
  cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
  cookieFor = base
}

async function qbFetch(pathname: string): Promise<Response> {
  const base = baseUrl()
  const once = () =>
    fetch(base + pathname, {
      headers: { Referer: base, ...(cookie && cookieFor === base ? { Cookie: cookie } : {}) },
      signal: AbortSignal.timeout(15_000),
    })
  let res: Response
  try {
    res = await once()
    if (res.status === 403) {
      await login(base)
      res = await once()
    }
  } catch (e) {
    if (e instanceof AppError) throw e
    throw new AppError(502, `连接 qBittorrent 失败（${base}）：${errMsg(e)}`)
  }
  if (!res.ok) throw new AppError(502, `qBittorrent 返回 HTTP ${res.status}`)
  return res
}

export async function qbVersion(): Promise<string> {
  return (await (await qbFetch('/api/v2/app/version')).text()).trim()
}

/** qB 报告的路径 → 本机路径 */
export function mapPath(p: string): string {
  const mappings = [...getSettings().pathMappings]
    .filter((m) => m.from)
    .sort((a, b) => b.from.length - a.from.length)
  for (const m of mappings) if (p.startsWith(m.from)) return m.to + p.slice(m.from.length)
  return p
}

async function fetchTorrents(): Promise<QbTorrent[]> {
  const categories = getSettings().qb.categories.filter((c) => c.trim())
  if (!categories.length) return (await (await qbFetch('/api/v2/torrents/info')).json()) as QbTorrent[]
  const lists = await Promise.all(
    categories.map(
      async (c) =>
        (await (await qbFetch(`/api/v2/torrents/info?category=${encodeURIComponent(c)}`)).json()) as QbTorrent[],
    ),
  )
  return lists.flat()
}

export async function getTorrent(hash: string): Promise<QbTorrent> {
  const list = (await (
    await qbFetch(`/api/v2/torrents/info?hashes=${encodeURIComponent(hash)}`)
  ).json()) as QbTorrent[]
  if (!list[0]) throw notFound('qBittorrent 里找不到这个种子')
  return list[0]
}

export async function listTorrentItems(): Promise<TorrentItem[]> {
  const d = db()
  const torrents = await fetchTorrents()
  const states = new Map(
    d
      .select()
      .from(schema.torrents)
      .all()
      .map((r) => [r.hash, r.state as TorrentState]),
  )
  const imported = d
    .select({
      hash: schema.links.sourceRef,
      id: schema.media.id,
      title: schema.media.title,
      count: sql<number>`count(*)`,
    })
    .from(schema.links)
    .innerJoin(schema.media, eq(schema.media.id, schema.links.mediaId))
    .where(eq(schema.links.sourceType, 'torrent'))
    .groupBy(schema.links.sourceRef, schema.media.id)
    .all()
  const importedMap = new Map<string, TorrentItem['importedTo']>()
  for (const r of imported) {
    const list = importedMap.get(r.hash) ?? []
    list.push({ id: r.id, title: r.title, count: r.count })
    importedMap.set(r.hash, list)
  }
  return torrents
    .map((t) => ({
      hash: t.hash,
      name: t.name,
      category: t.category,
      tags: t.tags,
      size: t.size,
      progress: t.progress,
      qbState: t.state,
      addedOn: t.added_on,
      contentPath: mapPath(t.content_path),
      state: states.get(t.hash) ?? 'new',
      importedTo: importedMap.get(t.hash) ?? [],
    }))
    .sort((a, b) => b.addedOn - a.addedOn)
}

export function setTorrentState(hash: string, state: TorrentState, name = ''): void {
  db()
    .insert(schema.torrents)
    .values({ hash, state, name, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: schema.torrents.hash,
      set: { state, updatedAt: Date.now(), ...(name ? { name } : {}) },
    })
    .run()
}
