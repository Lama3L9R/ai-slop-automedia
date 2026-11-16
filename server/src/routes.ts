import {
  AiSuggestInput,
  FromProviderInput,
  ImportRequest,
  LookupBy,
  MediaKind,
  MediaSaveInput,
  RefreshInput,
  SourceType,
  TorrentStateInput,
  type ImportPlan,
} from '@automedia/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { suggest } from './ai/suggest'
import { badRequest } from './errors'
import { executeImport, planImport } from './import/engine'
import {
  createMedia,
  deleteMedia,
  getMedia,
  getMediaDetail,
  listMedia,
  removeLinks,
  saveMedia,
} from './media/store'
import { syncMedia } from './media/sync'
import { getProvider, listProviders, mergeProvider } from './providers'
import { getSettings, saveSettings } from './settings'
import { listTorrentItems, qbVersion, setTorrentState } from './sources/qb'
import { listDirs, sourceTree } from './sources/tree'
import { listUploads, saveUpload } from './subtitles/upload'

const idParam = z.object({ id: z.coerce.number().int() })

export function registerRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => ({ ok: true }))
  app.get('/api/auth/check', async () => ({ ok: true }))

  // ── 设置 ──
  app.get('/api/settings', async () => getSettings())
  app.put('/api/settings', async (req) => saveSettings(req.body))
  app.post('/api/settings/test-qb', async () => ({ version: await qbVersion() }))
  app.get('/api/fs/dirs', async (req) => listDirs(z.object({ path: z.string().default('') }).parse(req.query).path))

  // ── Media ──
  app.get('/api/media', async () => listMedia())
  app.get('/api/media/:id', async (req) => getMediaDetail(idParam.parse(req.params).id))

  app.post('/api/media', async (req) => {
    const id = createMedia(MediaSaveInput.parse(req.body))
    return getMediaDetail(id)
  })

  app.put('/api/media/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    saveMedia(id, MediaSaveInput.parse(req.body))
    const { warnings } = await syncMedia(id)
    return { ...getMediaDetail(id), warnings }
  })

  app.delete('/api/media/:id', async (req) => {
    await deleteMedia(idParam.parse(req.params).id)
    return { ok: true }
  })

  /** 重新写 NFO、修复丢失的链接 */
  app.post('/api/media/:id/sync', async (req) => {
    const { id } = idParam.parse(req.params)
    const { warnings } = await syncMedia(id)
    return { ...getMediaDetail(id), warnings }
  })

  app.post('/api/media/:id/refresh', async (req) => {
    const { id } = idParam.parse(req.params)
    const { mode } = RefreshInput.parse(req.body ?? {})
    const current = getMediaDetail(id)
    const provider = getProvider('tmdb')
    const pid = await provider.resolveId(current.media)
    if (!pid) throw badRequest('这个媒体没有可用的外部 ID（TMDB / TVDB / IMDb），无法从上游刷新')
    saveMedia(id, MediaSaveInput.parse(mergeProvider(current, await provider.fetch(current.media.kind, pid), mode)))
    const { warnings } = await syncMedia(id)
    return { ...getMediaDetail(id), warnings }
  })

  app.delete('/api/links/:id', async (req) => {
    const affected = await removeLinks([idParam.parse(req.params).id])
    for (const mediaId of affected) await syncMedia(mediaId)
    return { ok: true }
  })

  // ── 元数据来源 ──
  app.get('/api/providers', async () => listProviders())

  app.get('/api/providers/:pid/search', async (req) => {
    const { pid } = z.object({ pid: z.string() }).parse(req.params)
    const q = z.object({ kind: MediaKind, by: LookupBy.default('name'), q: z.string() }).parse(req.query)
    return getProvider(pid).search(q.kind, q.by, q.q)
  })

  app.post('/api/media/from-provider', async (req) => {
    const input = FromProviderInput.parse(req.body)
    const data = await getProvider(input.provider).fetch(input.kind, input.id)
    const id = createMedia(
      MediaSaveInput.parse({ ...data, media: { ...data.media, libraryId: input.libraryId } }),
    )
    return getMediaDetail(id)
  })

  // ── 来源 ──
  app.get('/api/torrents', async () => listTorrentItems())

  app.put('/api/torrents/:hash/state', async (req) => {
    const { hash } = z.object({ hash: z.string().min(1) }).parse(req.params)
    const { state, name } = TorrentStateInput.parse(req.body)
    setTorrentState(hash, state, name)
    return { ok: true }
  })

  app.get('/api/sources/tree', async (req) => {
    const q = z.object({ type: SourceType, ref: z.string().min(1) }).parse(req.query)
    return sourceTree(q.type, q.ref)
  })

  // ── 导入 ──
  app.post('/api/import/preview', async (req): Promise<ImportPlan> => {
    const { items, adopt } = await planImport(ImportRequest.parse(req.body))
    return { items, adopt }
  })
  app.post('/api/import/execute', async (req) => executeImport(ImportRequest.parse(req.body)))

  // ── 字幕上传 ──
  app.get('/api/subtitles/uploads', async () => listUploads())

  app.post('/api/subtitles/upload', async (req) => {
    const { mediaId } = z.object({ mediaId: z.coerce.number().int().optional() }).parse(req.query)
    if (mediaId) getMedia(mediaId)
    return saveUpload(req.files(), mediaId)
  })

  // ── AI ──
  app.post('/api/ai/suggest', async (req) => suggest(AiSuggestInput.parse(req.body)))
}
