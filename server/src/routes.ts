import {
  AiSuggestInput,
  AutomationInput,
  FromProviderInput,
  ImportRequest,
  LookupBy,
  MediaKind,
  MediaSaveInput,
  RefreshInput,
  SourceType,
  TorrentStateInput,
  ComicImportRequest,
  PageOrderInput,
  ScriptFileWrite,
  type AutomationMeta,
  type ImportPlan,
  type MediaDetail,
} from '@automedia/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { suggest } from './ai/suggest'
import {
  automationEnabled,
  createAutomation,
  cronPreview,
  defaultInterpreter,
  deleteAutomation,
  getRun,
  listAutomations,
  readScriptFile,
  writeScriptFile,
  listRuns,
  providedEnv,
  startRun,
  stopRun,
  updateAutomation,
} from './automation/automation'
import { ensureExtracted, executeComicImport, getPages, planComicImport, setPageOrder } from './comics/import'
import { createReadStream, existsSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { db, schema } from './db'
import { badRequest, notFound } from './errors'
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
import { POSTER_MIME, posterPathOf, removeLocalPoster, savePoster } from './media/poster'
import { syncMedia } from './media/sync'
import { getProvider, listProviders, mergeProvider } from './providers'
import { getSettings, saveSettings } from './settings'
import { listTorrentItems, qbVersion, setTorrentState } from './sources/qb'
import { listDirs, sourceTree } from './sources/tree'
import { listUploads, saveUpload } from './subtitles/upload'

const idParam = z.object({ id: z.coerce.number().int() })
const slotQuery = z.object({ season: z.coerce.number().int().min(0), episode: z.coerce.number().int().min(0) })

/** 给前端的 Media 详情：漫画页数量太多，不随详情下发（只给 pageCounts），要看某一集的页另外取 */
function detailForApi(id: number): MediaDetail {
  const d = getMediaDetail(id)
  return { ...d, links: d.links.filter((l) => l.kind !== 'page') }
}

const IMAGE_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  jxl: 'image/jxl',
  tif: 'image/tiff',
  tiff: 'image/tiff',
}

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
  app.get('/api/media/:id', async (req) => detailForApi(idParam.parse(req.params).id))

  app.post('/api/media', async (req) => {
    const id = createMedia(MediaSaveInput.parse(req.body))
    return detailForApi(id)
  })

  app.put('/api/media/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    saveMedia(id, MediaSaveInput.parse(req.body))
    const { warnings } = await syncMedia(id)
    return { ...detailForApi(id), warnings }
  })

  app.delete('/api/media/:id', async (req) => {
    await deleteMedia(idParam.parse(req.params).id)
    return { ok: true }
  })

  /** 重新写 NFO、修复丢失的链接 */
  app.post('/api/media/:id/sync', async (req) => {
    const { id } = idParam.parse(req.params)
    const { warnings } = await syncMedia(id)
    return { ...detailForApi(id), warnings }
  })

  app.post('/api/media/:id/refresh', async (req) => {
    const { id } = idParam.parse(req.params)
    const { mode } = RefreshInput.parse(req.body ?? {})
    const current = getMediaDetail(id)
    if (current.media.kind === 'comic') throw badRequest('漫画没有上游元数据可以刷新')
    const provider = getProvider('tmdb')
    const pid = await provider.resolveId(current.media)
    if (!pid) throw badRequest('这个媒体没有可用的外部 ID（TMDB / TVDB / IMDb），无法从上游刷新')
    saveMedia(id, MediaSaveInput.parse(mergeProvider(current, await provider.fetch(current.media.kind, pid), mode)))
    const { warnings } = await syncMedia(id)
    return { ...detailForApi(id), warnings }
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
    if (q.kind === 'comic') throw badRequest('漫画没有可用的元数据来源，请手动创建')
    return getProvider(pid).search(q.kind, q.by, q.q)
  })

  app.post('/api/media/from-provider', async (req) => {
    const input = FromProviderInput.parse(req.body)
    if (input.kind === 'comic') throw badRequest('漫画没有可用的元数据来源，请手动创建')
    const data = await getProvider(input.provider).fetch(input.kind, input.id)
    const id = createMedia(
      MediaSaveInput.parse({ ...data, media: { ...data.media, libraryId: input.libraryId } }),
    )
    return detailForApi(id)
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

  // ── 漫画 ──
  app.post('/api/comics/extract', async (req) => ({
    dir: await ensureExtracted(z.object({ path: z.string().min(1) }).parse(req.body).path),
  }))
  app.post('/api/comics/preview', async (req) => planComicImport(ComicImportRequest.parse(req.body)))
  app.post('/api/comics/import', async (req) => executeComicImport(ComicImportRequest.parse(req.body)))

  app.get('/api/media/:id/pages', async (req) => {
    const q = slotQuery.parse(req.query)
    return getPages(idParam.parse(req.params).id, q.season, q.episode)
  })
  app.put('/api/media/:id/pages', async (req) => {
    const input = PageOrderInput.parse(req.body)
    return setPageOrder(idParam.parse(req.params).id, input.season, input.episode, input.order)
  })

  /** 页面排序界面预览用：把某个链接指向的图片原样发出去 */
  app.get('/api/links/:id/file', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const link = db().select().from(schema.links).where(eq(schema.links.id, id)).get()
    const type = link && IMAGE_TYPES[link.ext]
    if (!link || !type) throw notFound('没有这张图片')
    return reply.type(type).header('cache-control', 'private, max-age=3600').send(createReadStream(link.sourcePath))
  })

  // ── 字幕上传 ──
  app.get('/api/subtitles/uploads', async () => listUploads())

  app.post('/api/subtitles/upload', async (req) => {
    const { mediaId } = z.object({ mediaId: z.coerce.number().int().optional() }).parse(req.query)
    if (mediaId) getMedia(mediaId)
    return saveUpload(req.files(), mediaId)
  })

  // ── AI ──
  app.post('/api/ai/suggest', async (req) => suggest(AiSuggestInput.parse(req.body)))

  // ── 封面（上传的 / 从漫画页面里选的）──
  app.get('/api/posters/:name', async (req, reply) => {
    const { name } = z.object({ name: z.string() }).parse(req.params)
    const file = posterPathOf(name)
    if (!file || !existsSync(file)) throw notFound('没有这张封面')
    return reply
      .type(POSTER_MIME[name.split('.').pop()!])
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(createReadStream(file))
  })

  app.post('/api/media/:id/poster', async (req) => {
    const { id } = idParam.parse(req.params)
    const before = getMedia(id)
    const part = await req.file({ limits: { fileSize: 10 * 1024 * 1024 } })
    if (!part) throw badRequest('没有收到图片')
    const posterUrl = await savePoster(part.file, part.mimetype)
    db().update(schema.media).set({ posterUrl, updatedAt: Date.now() }).where(eq(schema.media.id, id)).run()
    await removeLocalPoster(before.posterUrl)
    const { warnings } = await syncMedia(id)
    return { posterUrl, warnings }
  })

  app.delete('/api/media/:id/poster', async (req) => {
    const { id } = idParam.parse(req.params)
    const before = getMedia(id)
    db().update(schema.media).set({ posterUrl: '', updatedAt: Date.now() }).where(eq(schema.media.id, id)).run()
    await removeLocalPoster(before.posterUrl)
    const { warnings } = await syncMedia(id)
    return { posterUrl: '', warnings }
  })

  // ── 自动化 ──
  app.get('/api/automations/meta', async (): Promise<AutomationMeta> => ({
    enabled: automationEnabled(),
    platform: process.platform,
    defaultInterpreter: defaultInterpreter(),
    env: providedEnv().map((v) => ({
      name: v.name,
      description: v.description,
      value: v.secret ? '' : v.value,
      secret: !!v.secret,
    })),
  }))
  /** 读 / 写服务器上的脚本文件（「服务器上已有的脚本文件」模式下直接编辑它） */
  app.post('/api/automations/script-file/read', async (req) => readScriptFile(z.object({ path: z.string() }).parse(req.body).path))
  app.put('/api/automations/script-file', async (req) => writeScriptFile(ScriptFileWrite.parse(req.body)))
  app.get('/api/automations', async () => listAutomations())
  app.post('/api/automations', async (req) => createAutomation(AutomationInput.parse(req.body)))
  app.put('/api/automations/:id', async (req) =>
    updateAutomation(idParam.parse(req.params).id, AutomationInput.parse(req.body)),
  )
  app.delete('/api/automations/:id', async (req) => {
    await deleteAutomation(idParam.parse(req.params).id)
    return { ok: true }
  })
  /** 校验 cron 表达式，并给出接下来几次的执行时间 */
  app.post('/api/automations/cron', async (req) => ({
    next: cronPreview(z.object({ cron: z.string() }).parse(req.body).cron),
  }))
  app.post('/api/automations/:id/run', async (req) => ({
    runId: await startRun(idParam.parse(req.params).id, 'manual'),
  }))
  app.post('/api/automations/:id/stop', async (req) => {
    await stopRun(idParam.parse(req.params).id)
    return { ok: true }
  })
  app.get('/api/automations/:id/runs', async (req) => listRuns(idParam.parse(req.params).id))
  app.get('/api/automation-runs/:id', async (req) => getRun(idParam.parse(req.params).id))
}
