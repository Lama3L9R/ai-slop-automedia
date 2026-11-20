import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import zlib from 'node:zlib'
import { AutomationInput, ComicImportRequest, ImportRequest, MediaSaveInput, guessSubtitleSuffix, levenshtein, naturalCompare, rankBySimilarity, titleCandidates } from '@automedia/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { parseItems, render } from '../src/ai/suggest'
import { buildApp, requestHandlerOf } from '../src/app'
import {
  createAutomation,
  deleteAutomation,
  getRun,
  idle,
  listAutomations,
  listRuns,
  parseArgv,
  readScriptFile,
  startRun,
  stopScheduler,
  updateAutomation,
  writeScriptFile,
} from '../src/automation/automation'
import { db, openDb, schema } from '../src/db'
import { eq, sql } from 'drizzle-orm'
import { executeComicImport, getPages, planComicImport, setPageOrder } from '../src/comics/import'
import { executeImport, planImport } from '../src/import/engine'
import { describeRule, localAddresses, matcher, parseListen, startRestrictedListeners } from '../src/listen'
import { parseEpisodes } from '../src/media/existing'
import { createMedia, deleteMedia, getMediaDetail, listMedia, removeLinks, saveMedia } from '../src/media/store'
import { imagesIdle, syncMedia } from '../src/media/sync'
import { saveSettings } from '../src/settings'
import { readTree } from '../src/sources/tree'
import { saveUpload } from '../src/subtitles/upload'
import { extractArchive, zipEntryNames } from '../src/util/archive'

const tmp = fsSync.mkdtempSync(path.join(process.env.AUTOMEDIA_TEST_TMP || os.tmpdir(), 'automedia-test-'))
const lib = path.join(tmp, 'library')
const src = path.join(tmp, 'downloads', '[VCB-Studio] ReLIFE [Ma10p_1080p]')
const subs = path.join(tmp, 'subs')

// Windows 上没开开发者模式时建不了符号链接，相关用例跳过
const canSymlink = (() => {
  try {
    fsSync.writeFileSync(path.join(tmp, 'probe'), '')
    fsSync.symlinkSync(path.join(tmp, 'probe'), path.join(tmp, 'probe-link'), 'file')
    return true
  } catch {
    return false
  }
})()

const read = (p: string) => fs.readFile(p, 'utf8')
const has = (p: string) => fs.lstat(p).then(() => true, () => false)

type RequestInput = z.input<typeof ImportRequest>

function request(mediaId: number, over: Partial<RequestInput> & Pick<RequestInput, 'items'>): ImportRequest {
  return ImportRequest.parse({
    mediaId,
    linkMode: 'copy',
    sourceType: 'torrent',
    sourceRef: 'hash-relife',
    sourceName: 'ReLIFE BD',
    ...over,
  })
}

const file = (name: string) => path.join(src, name)
let relife: number

beforeAll(async () => {
  openDb(':memory:')
  await fs.mkdir(path.join(src, 'SPs'), { recursive: true })
  for (let i = 1; i <= 13; i++) await fs.writeFile(file(`[VCB-Studio] ReLIFE [${String(i).padStart(2, '0')}].mkv`), `ep${i}`)
  await fs.writeFile(file('SPs/[VCB-Studio] ReLIFE [NCOP].mkv'), 'ncop')
  await fs.writeFile(file('SPs/[VCB-Studio] ReLIFE [Menu01].png'), 'menu')
  await fs.writeFile(file('[VCB-Studio] ReLIFE [01].sc.ass'), 'sub-sc')
  await fs.writeFile(file('[VCB-Studio] ReLIFE [01].tc.ass'), 'sub-tc')
  saveSettings({ libraries: [{ id: 'anime', name: '动画', path: lib }], subtitleDir: subs })
  relife = createMedia(
    MediaSaveInput.parse({
      media: { title: 'ReLIFE', year: 2016, tvdbId: '305089', libraryId: 'anime', overview: 'A & B <test>' },
      // 上游只有 12 集
      episodes: Array.from({ length: 12 }, (_, i) => ({ season: 1, number: i + 1, title: `report ${i + 1}` })),
    }),
  )
})

afterAll(async () => {
  stopScheduler()
  await imagesIdle()
  await fs.rm(tmp, { recursive: true, force: true })
})

/** 手工拼一个「存储」方式的 zip，文件名用原始字节（模拟中文 Windows 打的 GBK 包） */
function makeZip(entries: { name: Buffer; data: Buffer }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const crc = zlib.crc32(e.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(e.data.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(e.name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(e.data.length, 20)
    central.writeUInt32LE(e.data.length, 24)
    central.writeUInt16LE(e.name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, e.name, e.data)
    centrals.push(central, e.name)
    offset += 30 + e.name.length + e.data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

describe('纯函数', () => {
  it('自然排序', () => {
    expect(['ep10', 'ep2', 'ep1'].sort(naturalCompare)).toEqual(['ep1', 'ep2', 'ep10'])
  })
  it('字幕语言标签', () => {
    expect(guessSubtitleSuffix('[VCB] ReLIFE [01].sc.ass')).toBe('chs')
    expect(guessSubtitleSuffix('ReLIFE 01 [CHT].ass')).toBe('cht')
    expect(guessSubtitleSuffix('ReLIFE.S01E01.zh-Hans.srt')).toBe('chs')
    expect(guessSubtitleSuffix('ReLIFE - 01.JPSC.ass')).toBe('chs')
    expect(guessSubtitleSuffix('ReLIFE - 01.ass')).toBe('')
  })
  it('模版渲染只展开一遍', () => {
    expect(render('${a} | ${b} | ${x}', { a: '${b}', b: 2 })).toBe('${b} | 2 | ${x}')
  })
  it('解析模型输出', () => {
    const raw = '<think>hmm</think>```json\n{"items":[{"i":0,"s":1,"e":1},{"i":1,"s":0,"e":2,"tag":"chs"},{"i":9,"s":1,"e":1},{"i":2,"s":null,"e":null}]}\n```'
    expect(parseItems(raw, new Set([0, 1, 2]))).toEqual([
      { index: 0, season: 1, episode: 1, suffix: '' },
      { index: 1, season: 0, episode: 2, suffix: 'chs' },
    ])
  })
})

describe('目录树', () => {
  it('文件夹在前，自然排序，带类型', async () => {
    const nodes = await readTree(src)
    expect(nodes[0]).toMatchObject({ name: 'SPs', isDir: true })
    expect(nodes[0].children!.map((n) => n.kind)).toEqual([null, 'video'])
    const videos = nodes.filter((n) => n.kind === 'video').map((n) => n.name)
    expect(videos[0]).toContain('[01]')
    expect(videos[12]).toContain('[13]')
    expect(nodes.find((n) => n.name.endsWith('.sc.ass'))).toMatchObject({ kind: 'subtitle', rel: '[VCB-Studio] ReLIFE [01].sc.ass' })
  })
})

describe('导入（copy）', () => {
  const dir = path.join(lib, 'ReLIFE (2016) [tvdbid=305089]')

  it('按 Emby 结构落盘，元数据里没有的 EP13 照常导入', async () => {
    const items = Array.from({ length: 13 }, (_, i) => ({
      path: file(`[VCB-Studio] ReLIFE [${String(i + 1).padStart(2, '0')}].mkv`),
      season: 1,
      episode: i + 1,
      kind: 'video' as const,
    }))
    const res = await executeImport(request(relife, { items }))
    expect(res.items.every((r) => r.done)).toBe(true)
    expect(res.warnings).toEqual([])
    expect(await read(path.join(dir, 'Season 01', 'ReLIFE - S01E13.mkv'))).toBe('ep13')

    const show = await read(path.join(dir, 'tvshow.nfo'))
    expect(show).toContain('<title>ReLIFE</title>')
    expect(show).toContain('<plot>A &amp; B &lt;test&gt;</plot>')
    expect(show).toContain('<uniqueid type="tvdb" default="true">305089</uniqueid>')
    expect(show).toContain('<lockdata>true</lockdata>')
    expect(await read(path.join(dir, 'Season 01', 'ReLIFE - S01E01.nfo'))).toContain('<title>report 1</title>')
    const ep13 = await read(path.join(dir, 'Season 01', 'ReLIFE - S01E13.nfo'))
    expect(ep13).toContain('<episode>13</episode>')
    expect(ep13).not.toContain('<title>')
    expect(await has(path.join(dir, 'Season 01', 'season.nfo'))).toBe(true)
  })

  it('字幕跟随视频文件名，用语言标签区分', async () => {
    const res = await executeImport(
      request(relife, {
        items: [
          { path: file('[VCB-Studio] ReLIFE [01].sc.ass'), season: 1, episode: 1, kind: 'subtitle', suffix: 'chs' },
          { path: file('[VCB-Studio] ReLIFE [01].tc.ass'), season: 1, episode: 1, kind: 'subtitle', suffix: 'cht' },
        ],
      }),
    )
    expect(res.items.map((r) => path.basename(r.target))).toEqual(['ReLIFE - S01E01.chs.ass', 'ReLIFE - S01E01.cht.ass'])
    expect(await read(path.join(dir, 'Season 01', 'ReLIFE - S01E01.chs.ass'))).toBe('sub-sc')
  })

  it('预览能发现冲突', async () => {
    const dup = await planImport(
      request(relife, {
        items: [
          { path: file('[VCB-Studio] ReLIFE [02].mkv'), season: 2, episode: 1, kind: 'video' },
          { path: file('[VCB-Studio] ReLIFE [03].mkv'), season: 2, episode: 1, kind: 'video' },
          { path: file('nope.mkv'), season: 2, episode: 2, kind: 'video' },
          { path: file('[VCB-Studio] ReLIFE [01].mkv'), season: 1, episode: 1, kind: 'video' },
        ],
      }),
    )
    expect(dup.items.map((i) => i.status)).toEqual(['error', 'error', 'error', 'replace'])

    // 目标位置有不归本工具管的文件
    await fs.mkdir(path.join(dir, 'Season 00'), { recursive: true })
    await fs.writeFile(path.join(dir, 'Season 00', 'ReLIFE - S00E01.mkv'), 'manual')
    const foreign = await planImport(
      request(relife, { items: [{ path: file('SPs/[VCB-Studio] ReLIFE [NCOP].mkv'), season: 0, episode: 1, kind: 'video' }] }),
    )
    expect(foreign.items[0].status).toBe('error')
    await fs.rm(path.join(dir, 'Season 00'), { recursive: true })
  })

  it('改标题后目录、文件名、NFO 一起跟着改', async () => {
    const d = getMediaDetail(relife)
    const { id: _i, folderPath: _f, createdAt: _c, updatedAt: _u, ...media } = d.media
    saveMedia(relife, { media: { ...media, title: 'ReLIFE: 重返17岁' }, seasons: d.seasons, episodes: d.episodes })
    expect((await syncMedia(relife)).warnings).toEqual([])

    const renamed = path.join(lib, 'ReLIFE 重返17岁 (2016) [tvdbid=305089]')
    expect(await has(dir)).toBe(false)
    expect(await read(path.join(renamed, 'Season 01', 'ReLIFE 重返17岁 - S01E13.mkv'))).toBe('ep13')
    expect(await has(path.join(renamed, 'Season 01', 'ReLIFE 重返17岁 - S01E01.chs.ass'))).toBe(true)
    expect(await has(path.join(renamed, 'Season 01', 'ReLIFE 重返17岁 - S01E01.nfo'))).toBe(true)
    expect(await has(path.join(renamed, 'Season 01', 'ReLIFE - S01E01.nfo'))).toBe(false)
    expect(getMediaDetail(relife).media.folderPath).toBe(renamed)

    saveMedia(relife, { media, seasons: d.seasons, episodes: d.episodes })
    await syncMedia(relife)
    expect(await has(path.join(dir, 'Season 01', 'ReLIFE - S01E13.mkv'))).toBe(true)
    expect(await has(renamed)).toBe(false)
  })

  it('重新导入：先清掉这个来源之前的全部链接', async () => {
    const res = await executeImport(
      request(relife, {
        replaceSource: true,
        items: [{ path: file('[VCB-Studio] ReLIFE [01].mkv'), season: 1, episode: 1, kind: 'video' }],
      }),
    )
    expect(res.items[0].done).toBe(true)
    const season = await fs.readdir(path.join(dir, 'Season 01'))
    expect(season.sort()).toEqual(['ReLIFE - S01E01.mkv', 'ReLIFE - S01E01.nfo', 'season.nfo'])
    // 源文件一个都不能少
    expect((await fs.readdir(src)).length).toBe(16)
  })

  it('删掉最后一个链接后目录被清理干净', async () => {
    const links = getMediaDetail(relife).links
    await removeLinks(links.map((l) => l.id))
    await syncMedia(relife)
    expect(await has(dir)).toBe(false)
    expect(getMediaDetail(relife).media.folderPath).toBe('')
    expect(await read(file('[VCB-Studio] ReLIFE [01].mkv'))).toBe('ep1')
  })
})

describe('链接方式', () => {
  it('硬链接指向同一个 inode', async () => {
    const res = await executeImport(
      request(relife, {
        linkMode: 'hardlink',
        items: [{ path: file('[VCB-Studio] ReLIFE [02].mkv'), season: 1, episode: 2, kind: 'video' }],
      }),
    )
    expect(res.items[0]).toMatchObject({ done: true })
    expect((await fs.stat(res.items[0].target)).nlink).toBe(2)
  })

  it.skipIf(!canSymlink)('符号链接指向源文件的绝对路径，删除链接不影响源文件', async () => {
    const source = file('[VCB-Studio] ReLIFE [03].mkv')
    const res = await executeImport(
      request(relife, { linkMode: 'symlink', items: [{ path: source, season: 1, episode: 3, kind: 'video' }] }),
    )
    const target = res.items[0].target
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true)
    expect(await fs.readlink(target)).toBe(source)
    expect(await read(target)).toBe('ep3')

    // 链接被手动删掉后，sync 会补回来
    await fs.rm(target)
    await syncMedia(relife)
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true)

    await removeLinks(getMediaDetail(relife).links.map((l) => l.id))
    await syncMedia(relife)
    expect(await read(source)).toBe('ep3')
  })
})

describe('movie 布局', () => {
  it('单片 → 多片时自动改名', async () => {
    const id = createMedia(
      MediaSaveInput.parse({
        media: { kind: 'movie', title: '指环王', year: 2001, tmdbId: '120', libraryId: 'anime' },
        episodes: [
          { season: 1, number: 1, title: '护戒使者', airDate: '2001-12-19' },
          { season: 1, number: 2, title: '双塔奇兵', airDate: '2002-12-18' },
        ],
      }),
    )
    const dir = path.join(lib, '指环王 (2001) [tmdbid=120]')
    const a = await executeImport(
      request(id, { sourceRef: 'lotr', items: [{ path: file('[VCB-Studio] ReLIFE [04].mkv'), season: 1, episode: 1, kind: 'video' }] }),
    )
    expect(a.items[0].target).toBe(path.join(dir, '护戒使者 (2001).mkv'))
    await executeImport(
      request(id, { sourceRef: 'lotr', items: [{ path: file('[VCB-Studio] ReLIFE [05].mkv'), season: 1, episode: 2, kind: 'video' }] }),
    )
    expect((await fs.readdir(dir)).sort()).toEqual(['双塔奇兵 (2002).mkv', '双塔奇兵 (2002).nfo', '护戒使者 (2001).mkv', '护戒使者 (2001).nfo'].sort())
    expect(await read(path.join(dir, '双塔奇兵 (2002).nfo'))).toContain('<name>指环王</name>')
    await deleteMedia(id)
    expect(await has(dir)).toBe(false)
  })

  it('只有一部片时用 Media 标题命名', async () => {
    const id = createMedia(
      MediaSaveInput.parse({ media: { kind: 'movie', title: '你的名字。', year: 2016, tmdbId: '372058', libraryId: 'anime' } }),
    )
    const res = await executeImport(
      request(id, { sourceRef: 'kimi', items: [{ path: file('[VCB-Studio] ReLIFE [06].mkv'), season: 1, episode: 1, kind: 'video' }] }),
    )
    expect(res.items[0].target).toBe(path.join(lib, '你的名字。 (2016) [tmdbid=372058]', '你的名字。 (2016).mkv'))
    await deleteMedia(id)
  })
})

describe('字幕上传', () => {
  it('解压 zip：GBK 文件名、子目录、拦截越界路径', async () => {
    const gbk = Buffer.from([0xd7, 0xd6, 0xc4, 0xbb]) // 「字幕」的 GBK 编码
    const zip = makeZip([
      { name: Buffer.concat([gbk, Buffer.from('/'), gbk, Buffer.from(' 01.sc.ass')]), data: Buffer.from('s1') },
      { name: Buffer.from('ReLIFE 02.tc.ass'), data: Buffer.from('s2') },
      { name: Buffer.from('../evil.ass'), data: Buffer.from('x') },
      { name: Buffer.from('__MACOSX/._junk'), data: Buffer.from('x') },
    ])
    async function* parts() {
      yield { filename: 'ReLIFE 字幕.zip', file: Readable.from([zip]) }
    }
    const { path: batch } = await saveUpload(parts(), relife)
    expect(batch).toBe(path.join(subs, 'ReLIFE', 'ReLIFE 字幕'))
    expect(await read(path.join(batch, '字幕', '字幕 01.sc.ass'))).toBe('s1')
    expect(await read(path.join(batch, 'ReLIFE 02.tc.ass'))).toBe('s2')
    expect(await has(path.join(subs, 'ReLIFE', 'evil.ass'))).toBe(false)
    expect((await fs.readdir(batch)).sort()).toEqual(['ReLIFE 02.tc.ass', '字幕'])

    // 同名再传一次不会覆盖
    const again = await saveUpload(parts(), relife)
    expect(again.path).toBe(path.join(subs, 'ReLIFE', 'ReLIFE 字幕 (2)'))
  })
})

describe('接手 Sonarr 导入过的媒体库', () => {
  it('从文件名解析集号', () => {
    expect(parseEpisodes('Show - S01E01 - Title Bluray-1080p.mkv')).toEqual([{ season: 1, episode: 1 }])
    expect(parseEpisodes('Show - S01E01-E03 - Title.mkv').map((s) => s.episode)).toEqual([1, 2, 3])
    expect(parseEpisodes('Show - S01E05E06.mkv').map((s) => s.episode)).toEqual([5, 6])
    expect(parseEpisodes('Show - S01E05-06.mkv').map((s) => s.episode)).toEqual([5, 6])
    expect(parseEpisodes('Show - S02E07 - 031 - Title.mkv')).toEqual([{ season: 2, episode: 7 }])
    expect(parseEpisodes('Show.S01E02-1080p.mkv')).toEqual([{ season: 1, episode: 2 }])
    expect(parseEpisodes('Show - 07 [1080p].mkv')).toEqual([])
  })

  it('接管已有目录，沿用季文件夹，按集替换，不碰没重新导入的集', async () => {
    const id = createMedia(
      MediaSaveInput.parse({ media: { title: 'Sonarr Show', year: 2020, tvdbId: '777', libraryId: 'anime' } }),
    )
    // Sonarr 的默认命名：目录没有 ID 标记，季文件夹是「Season 1」，文件名带集标题和画质
    const old = path.join(lib, 'Sonarr Show (2020)')
    const s1 = path.join(old, 'Season 1')
    await fs.mkdir(s1, { recursive: true })
    await fs.mkdir(path.join(lib, 'Sonarr Show 2 (2021)')) // 名字相近的别的作品，不能被认错
    // E07：和源文件内容相同（Sonarr 跨盘拷过来的副本）
    await fs.copyFile(file('[VCB-Studio] ReLIFE [07].mkv'), path.join(s1, 'Sonarr Show - S01E07 - Title Bluray-1080p.mkv'))
    await fs.writeFile(path.join(s1, 'Sonarr Show - S01E07 - Title Bluray-1080p.zh.ass'), 'bazarr')
    await fs.writeFile(path.join(s1, 'Sonarr Show - S01E07 - Title Bluray-1080p.nfo'), '<sonarr/>')
    // E08：另一个版本，大小不同
    await fs.writeFile(path.join(s1, 'Sonarr Show - S01E08 - Title WEBDL-720p.mkv'), 'a different release')
    // E09：这次不重新导入
    await fs.writeFile(path.join(s1, 'Sonarr Show - S01E09 - Title.mkv'), 'untouched')
    await fs.writeFile(path.join(old, 'tvshow.nfo'), '<sonarr/>')

    const items = [7, 8].map((n) => ({
      path: file(`[VCB-Studio] ReLIFE [0${n}].mkv`),
      season: 1,
      episode: n,
      kind: 'video' as const,
    }))
    const dir = path.join(lib, 'Sonarr Show (2020) [tvdbid=777]')
    const plan = await planImport(request(id, { sourceRef: 'sonarr', items }))
    expect(plan.adopt).toEqual({ from: old, to: dir })
    expect(plan.items.map((i) => i.status)).toEqual(['replace', 'error'])
    expect(plan.items[0].target).toBe(path.join(dir, 'Season 1', 'Sonarr Show - S01E07.mkv'))
    expect(plan.items[0].removes).toEqual([path.join(s1, 'Sonarr Show - S01E07 - Title Bluray-1080p.mkv')])
    expect(plan.items[1].message).toContain('大小不同')
    const skip = await planImport(request(id, { sourceRef: 'sonarr', items, existing: 'skip' }))
    expect(skip.items.map((i) => i.status)).toEqual(['error', 'error'])
    expect(await has(old)).toBe(true) // 预览不动磁盘

    const res = await executeImport(request(id, { sourceRef: 'sonarr', items }))
    expect(res.items.map((r) => r.done)).toEqual([true, false])
    expect(res.warnings).toEqual([])
    expect(await has(old)).toBe(false)
    expect((await fs.readdir(dir)).sort()).toEqual(['Season 1', 'tvshow.nfo'])
    expect((await fs.readdir(path.join(dir, 'Season 1'))).sort()).toEqual(
      [
        'Sonarr Show - S01E07.mkv',
        'Sonarr Show - S01E07.nfo',
        'Sonarr Show - S01E07.zh.ass',
        'Sonarr Show - S01E08 - Title WEBDL-720p.mkv',
        'Sonarr Show - S01E09 - Title.mkv',
        'season.nfo',
      ].sort(),
    )
    // Bazarr 的字幕跟着视频改了名，NFO 被本工具的内容覆盖
    expect(await read(path.join(dir, 'Season 1', 'Sonarr Show - S01E07.zh.ass'))).toBe('bazarr')
    expect(await read(path.join(dir, 'Season 1', 'Sonarr Show - S01E07.nfo'))).toContain('<episodedetails>')
    expect(await read(path.join(dir, 'tvshow.nfo'))).toContain('<title>Sonarr Show</title>')
    expect(getMediaDetail(id).media.folderPath).toBe(dir)

    const forced = await executeImport(request(id, { sourceRef: 'sonarr', existing: 'force', items: [items[1]] }))
    expect(forced.items[0].done).toBe(true)
    expect(await has(path.join(dir, 'Season 1', 'Sonarr Show - S01E08 - Title WEBDL-720p.mkv'))).toBe(false)
    expect(await read(path.join(dir, 'Season 1', 'Sonarr Show - S01E08.mkv'))).toBe('ep8')

    // 删除 Media 只带走本工具创建的东西
    await deleteMedia(id)
    expect((await fs.readdir(path.join(dir, 'Season 1'))).sort()).toEqual(
      ['Sonarr Show - S01E07.zh.ass', 'Sonarr Show - S01E09 - Title.mkv'].sort(),
    )
    await fs.rm(dir, { recursive: true })
    await fs.rm(path.join(lib, 'Sonarr Show 2 (2021)'), { recursive: true })
  })
})

describe('改季号', () => {
  it('已导入的文件跟着换季，两季对调也能解开', async () => {
    const id = createMedia(
      MediaSaveInput.parse({
        media: { title: 'Renumber', libraryId: 'anime' },
        episodes: [{ season: 2, number: 1, title: '本该是第三季' }],
      }),
    )
    const res = await executeImport(
      request(id, {
        sourceRef: 'renumber',
        items: [
          { path: file('[VCB-Studio] ReLIFE [09].mkv'), season: 2, episode: 1, kind: 'video' },
          { path: file('[VCB-Studio] ReLIFE [10].mkv'), season: 3, episode: 1, kind: 'video' },
          { path: file('[VCB-Studio] ReLIFE [01].sc.ass'), season: 2, episode: 1, kind: 'subtitle', suffix: 'chs' },
        ],
      }),
    )
    expect(res.items.every((r) => r.done)).toBe(true)
    const dir = path.join(lib, 'Renumber')
    const media = { title: 'Renumber', libraryId: 'anime' }

    // 第 2 季 ↔ 第 3 季
    saveMedia(
      id,
      MediaSaveInput.parse({
        media,
        episodes: [{ season: 3, number: 1, title: '本该是第三季' }],
        seasonMoves: [
          { from: 2, to: 3 },
          { from: 3, to: 2 },
        ],
      }),
    )
    expect((await syncMedia(id)).warnings).toEqual([])
    expect(await read(path.join(dir, 'Season 03', 'Renumber - S03E01.mkv'))).toBe('ep9')
    expect(await read(path.join(dir, 'Season 03', 'Renumber - S03E01.chs.ass'))).toBe('sub-sc')
    expect(await read(path.join(dir, 'Season 03', 'Renumber - S03E01.nfo'))).toContain('<title>本该是第三季</title>')
    expect(await read(path.join(dir, 'Season 02', 'Renumber - S02E01.mkv'))).toBe('ep10')
    expect((await fs.readdir(path.join(dir, 'Season 02'))).sort()).toEqual(['Renumber - S02E01.mkv', 'Renumber - S02E01.nfo', 'season.nfo'])

    // 第 3 季并进第 2 季会让同一集有两个视频 → 拒绝，什么都不改
    expect(() => saveMedia(id, MediaSaveInput.parse({ media, seasonMoves: [{ from: 3, to: 2 }] }))).toThrow(/两个同类文件/)
    expect(getMediaDetail(id).links.map((l) => l.season).sort()).toEqual([2, 3, 3])

    // 第 2 季挪到一个空的季号
    saveMedia(id, MediaSaveInput.parse({ media, seasonMoves: [{ from: 2, to: 5 }] }))
    await syncMedia(id)
    expect(await read(path.join(dir, 'Season 05', 'Renumber - S05E01.mkv'))).toBe('ep10')
    expect(await has(path.join(dir, 'Season 02'))).toBe(false)
    await deleteMedia(id)
    expect(await has(dir)).toBe(false)
  })
})

describe('漫画', () => {
  const comicSrc = path.join(tmp, 'downloads', '[漫画] 测试漫画')
  const comicRequest = (mediaId: number, items: { path: string; season: number; episode: number }[]) =>
    ComicImportRequest.parse({ mediaId, linkMode: 'copy', sourceType: 'dir', sourceRef: comicSrc, items })
  const ls = async (p: string) => (await fs.readdir(p)).sort()

  it('压缩包原地解压，按自然排序编号；可以调整顺序、删页；多季时自动分文件夹', async () => {
    await fs.mkdir(path.join(comicSrc, 'vol2'), { recursive: true })
    const vol1 = path.join(comicSrc, '第01卷.zip')
    await fs.writeFile(
      vol1,
      makeZip([
        { name: Buffer.from('10.jpg'), data: Buffer.from('p10') },
        { name: Buffer.from('2.jpg'), data: Buffer.from('p2') },
        { name: Buffer.from('1.jpg'), data: Buffer.from('p1') },
        { name: Buffer.from('credits.txt'), data: Buffer.from('not an image') },
      ]),
    )
    await fs.writeFile(path.join(comicSrc, 'vol2', 'b.png'), 'v2b')
    await fs.writeFile(path.join(comicSrc, 'vol2', 'a.png'), 'v2a')
    const vol2 = path.join(comicSrc, 'vol2')

    const id = createMedia(
      MediaSaveInput.parse({
        media: { kind: 'comic', title: '测试漫画', libraryId: 'anime' },
        episodes: [{ season: 1, number: 1, title: '开端' }],
      }),
    )
    const dir = path.join(lib, '测试漫画')
    const items = [
      { path: vol1, season: 1, episode: 1 },
      { path: vol2, season: 1, episode: 2 },
    ]

    const plan = await planComicImport(comicRequest(id, items))
    expect(plan.map((p) => [p.status, p.pages, p.extract])).toEqual([
      ['ok', 3, true],
      ['ok', 2, false],
    ])
    expect(plan[0].target).toBe(path.join(dir, '001 - 开端'))
    expect(await has(path.join(comicSrc, '第01卷'))).toBe(false) // 预览不解压

    const res = await executeComicImport(comicRequest(id, items))
    expect(res.items.map((r) => [r.done, r.pages])).toEqual([
      [true, 3],
      [true, 2],
    ])
    expect(res.warnings).toEqual([])
    // 解压在压缩包旁边的同名文件夹里，压缩包本身不动
    expect(await ls(path.join(comicSrc, '第01卷'))).toEqual(['1.jpg', '10.jpg', '2.jpg', 'credits.txt'])
    expect(await has(vol1)).toBe(true)
    // 只有一季：不建季文件夹；没有 NFO；页面按自然排序编号
    expect(await ls(dir)).toEqual(['001 - 开端', '002'])
    expect(await ls(path.join(dir, '001 - 开端'))).toEqual(['0001.jpg', '0002.jpg', '0003.jpg'])
    expect(await read(path.join(dir, '001 - 开端', '0003.jpg'))).toBe('p10')
    expect(await read(path.join(dir, '002', '0001.png'))).toBe('v2a')
    expect(getMediaDetail(id).pageCounts).toEqual([
      { season: 1, episode: 1, count: 3 },
      { season: 1, episode: 2, count: 2 },
    ])

    // 调整顺序：第 10 页放最前当封面，第 2 页删掉
    const pages = getPages(id, 1, 1)
    expect(pages.map((p) => path.basename(p.sourcePath))).toEqual(['1.jpg', '2.jpg', '10.jpg'])
    const after = await setPageOrder(id, 1, 1, [pages[2].id, pages[0].id])
    expect(after.map((p) => [p.position, path.basename(p.sourcePath)])).toEqual([
      [1, '10.jpg'],
      [2, '1.jpg'],
    ])
    expect(await ls(path.join(dir, '001 - 开端'))).toEqual(['0001.jpg', '0002.jpg'])
    expect(await read(path.join(dir, '001 - 开端', '0001.jpg'))).toBe('p10')
    expect(await read(path.join(dir, '001 - 开端', '0002.jpg'))).toBe('p1')
    await expect(setPageOrder(id, 1, 1, [pages[1].id])).rejects.toThrow(/不一致/)

    // 再导入一个第 2 季的内容：变成多季，已有的集自动挪进 S01
    const more = await executeComicImport(comicRequest(id, [{ path: vol2, season: 2, episode: 1 }]))
    expect(more.items[0].done).toBe(true)
    expect(await ls(dir)).toEqual(['S01', 'S02'])
    expect(await ls(path.join(dir, 'S01'))).toEqual(['001 - 开端', '002'])
    expect(await read(path.join(dir, 'S01', '001 - 开端', '0001.jpg'))).toBe('p10')
    expect(await ls(path.join(dir, 'S02', '001'))).toEqual(['0001.png', '0002.png'])

    // 重新导入同一集：整集替换
    const again = await planComicImport(comicRequest(id, [{ path: vol2, season: 1, episode: 1 }]))
    expect(again[0].status).toBe('replace')
    await executeComicImport(comicRequest(id, [{ path: vol2, season: 1, episode: 1 }]))
    expect(await ls(path.join(dir, 'S01', '001 - 开端'))).toEqual(['0001.png', '0002.png'])

    // 视频向导不接受漫画
    await expect(
      planImport(request(id, { items: [{ path: file('[VCB-Studio] ReLIFE [01].mkv'), season: 1, episode: 1, kind: 'video' }] })),
    ).rejects.toThrow(/漫画/)

    await deleteMedia(id)
    expect(await has(dir)).toBe(false)
    expect(await read(path.join(comicSrc, '第01卷', '1.jpg'))).toBe('p1')
  })

  it('CBZ 模式：一集打成一个带 ComicInfo.xml 的 cbz，改顺序 / 改元数据会重新打包，可以和图片模式互相切换', async () => {
    const vol1 = path.join(comicSrc, '第01卷.zip') // 上一个用例已经解压过：1.jpg 2.jpg 10.jpg
    const vol2 = path.join(comicSrc, 'vol2')
    const media = { kind: 'comic' as const, title: 'CBZ 漫画', year: 2020, libraryId: 'anime', comicFormat: 'cbz' as const, genres: ['热血'], studios: ['某作者'], overview: '简介 & 说明' }
    const id = createMedia(MediaSaveInput.parse({ media, episodes: [{ season: 1, number: 1, title: '开端' }] }))
    const dir = path.join(lib, 'CBZ 漫画 (2020)')
    /** 把 cbz 解到临时目录里读内容 */
    const unpack = async (cbz: string) => {
      const out = await fs.mkdtemp(path.join(tmp, 'unpack-'))
      await extractArchive(cbz, path.basename(cbz), out)
      return out
    }

    const plan = await planComicImport(comicRequest(id, [{ path: vol1, season: 1, episode: 1 }, { path: vol2, season: 1, episode: 2 }]))
    expect(plan[0].target).toBe(path.join(dir, 'CBZ 漫画 - 001 - 开端.cbz'))
    const res = await executeComicImport(comicRequest(id, [{ path: vol1, season: 1, episode: 1 }, { path: vol2, season: 1, episode: 2 }]))
    expect(res.items.map((r) => r.done)).toEqual([true, true])
    expect(res.warnings).toEqual([])
    // 媒体库里只有 cbz，没有散的图片
    expect(await ls(dir)).toEqual(['CBZ 漫画 - 001 - 开端.cbz', 'CBZ 漫画 - 002.cbz'])
    const cbz1 = path.join(dir, 'CBZ 漫画 - 001 - 开端.cbz')
    expect(await zipEntryNames(cbz1)).toEqual(['0001.jpg', '0002.jpg', '0003.jpg', 'ComicInfo.xml'])
    let out = await unpack(cbz1)
    expect(await read(path.join(out, '0003.jpg'))).toBe('p10')
    const info = await read(path.join(out, 'ComicInfo.xml'))
    for (const piece of [
      '<Title>开端</Title>',
      '<Series>CBZ 漫画</Series>',
      '<Number>1</Number>',
      '<Count>2</Count>',
      '<Summary>简介 &amp; 说明</Summary>',
      '<Year>2020</Year>',
      '<Writer>某作者</Writer>',
      '<Genre>热血</Genre>',
      '<PageCount>3</PageCount>',
      '<Page Image="0" Type="FrontCover" />',
    ])
      expect(info).toContain(piece)
    expect(info).not.toContain('<Volume>') // 只有一季时不写
    expect(getMediaDetail(id).pageCounts.map((c) => c.count)).toEqual([3, 2])

    // 没变化时再同步不会重新打包
    const before = (await fs.stat(cbz1)).mtimeMs
    await new Promise((r) => setTimeout(r, 20))
    await syncMedia(id)
    expect((await fs.stat(cbz1)).mtimeMs).toBe(before)

    // 调整顺序 → 重新打包
    const pages = getPages(id, 1, 1)
    await setPageOrder(id, 1, 1, [pages[2].id, pages[0].id, pages[1].id])
    out = await unpack(cbz1)
    expect(await read(path.join(out, '0001.jpg'))).toBe('p10')
    expect(await read(path.join(out, '0002.jpg'))).toBe('p1')

    // 改集标题 → 文件名和 ComicInfo 都跟着变，旧包被清掉
    saveMedia(id, MediaSaveInput.parse({ media, episodes: [{ season: 1, number: 1, title: '序章' }] }))
    expect((await syncMedia(id)).warnings).toEqual([])
    expect(await ls(dir)).toEqual(['CBZ 漫画 - 001 - 序章.cbz', 'CBZ 漫画 - 002.cbz'])
    out = await unpack(path.join(dir, 'CBZ 漫画 - 001 - 序章.cbz'))
    expect(await read(path.join(out, 'ComicInfo.xml'))).toContain('<Title>序章</Title>')

    // 切到图片模式：cbz 删掉，变成图片文件夹（顺序保留）
    saveMedia(id, MediaSaveInput.parse({ media: { ...media, comicFormat: 'images' }, episodes: [{ season: 1, number: 1, title: '序章' }] }))
    expect((await syncMedia(id)).warnings).toEqual([])
    expect(await ls(dir)).toEqual(['001 - 序章', '002'])
    expect(await read(path.join(dir, '001 - 序章', '0001.jpg'))).toBe('p10')

    // 再切回 CBZ：图片文件夹清掉，重新打包
    saveMedia(id, MediaSaveInput.parse({ media, episodes: [{ season: 1, number: 1, title: '序章' }] }))
    expect((await syncMedia(id)).warnings).toEqual([])
    expect(await ls(dir)).toEqual(['CBZ 漫画 - 001 - 序章.cbz', 'CBZ 漫画 - 002.cbz'])

    // 多季：不建季文件夹（Emby 会把只装着一本书的文件夹当成书，用文件夹名当书名），
    // 全部平铺，文件名带 SxxExxx，ComicInfo 写 Volume
    await executeComicImport(comicRequest(id, [{ path: vol2, season: 2, episode: 1 }]))
    expect(await ls(dir)).toEqual(['CBZ 漫画 - S01E001 - 序章.cbz', 'CBZ 漫画 - S01E002.cbz', 'CBZ 漫画 - S02E001.cbz'])
    out = await unpack(path.join(dir, 'CBZ 漫画 - S02E001.cbz'))
    expect(await read(path.join(out, 'ComicInfo.xml'))).toContain('<Volume>2</Volume>')

    // 旧版本留下的季文件夹布局（S02 - xx/….cbz）：再同步一次就搬回平铺，空的季文件夹清掉
    const flat = path.join(dir, 'CBZ 漫画 - S02E001.cbz')
    const old = path.join(dir, 'S02 - 旧布局', 'CBZ 漫画 - S02E001.cbz')
    await fs.mkdir(path.dirname(old))
    await fs.rename(flat, old)
    db().update(schema.artifacts).set({ path: old }).where(eq(schema.artifacts.path, flat)).run()
    db()
      .update(schema.links)
      .set({ targetPath: sql`${old} || substr(${schema.links.targetPath}, ${flat.length + 1})` })
      .where(sql`substr(${schema.links.targetPath}, 1, ${flat.length + 1}) = ${flat + '#'}`)
      .run()
    expect((await syncMedia(id)).warnings).toEqual([])
    expect(await ls(dir)).toEqual(['CBZ 漫画 - S01E001 - 序章.cbz', 'CBZ 漫画 - S01E002.cbz', 'CBZ 漫画 - S02E001.cbz'])
    expect(getMediaDetail(id).pageCounts.map((c) => c.count)).toEqual([3, 2, 2])

    // 标题里有半角方括号：Emby 解析书名时会在第一个「 [...]」处截断，所以磁盘上换成全角；ComicInfo 里保持原样
    const bracketed = { ...media, title: '(C99) [作者 (社团)] CBZ 漫画 [DL版]' }
    saveMedia(id, MediaSaveInput.parse({ media: bracketed, episodes: [{ season: 1, number: 1, title: '序章 [前篇]' }] }))
    expect((await syncMedia(id)).warnings).toEqual([])
    expect(await has(dir)).toBe(false)
    const bdir = path.join(lib, '(C99) ［作者 (社团)］ CBZ 漫画 ［DL版］ (2020)')
    expect(await ls(bdir)).toEqual([
      '(C99) ［作者 (社团)］ CBZ 漫画 ［DL版］ - S01E001 - 序章 ［前篇］.cbz',
      '(C99) ［作者 (社团)］ CBZ 漫画 ［DL版］ - S01E002.cbz',
      '(C99) ［作者 (社团)］ CBZ 漫画 ［DL版］ - S02E001.cbz',
    ])
    out = await unpack(path.join(bdir, '(C99) ［作者 (社团)］ CBZ 漫画 ［DL版］ - S01E001 - 序章 ［前篇］.cbz'))
    const binfo = await read(path.join(out, 'ComicInfo.xml'))
    expect(binfo).toContain('<Series>(C99) [作者 (社团)] CBZ 漫画 [DL版]</Series>')
    expect(binfo).toContain('<Title>序章 [前篇]</Title>')

    await deleteMedia(id)
    expect(await has(bdir)).toBe(false)
    expect(await read(path.join(comicSrc, '第01卷', '1.jpg'))).toBe('p1')
  })

  it('没有图片、路径不对、同一集重复都会在预览里报出来', async () => {
    const id = createMedia(MediaSaveInput.parse({ media: { kind: 'comic', title: '空漫画', libraryId: 'anime' } }))
    await fs.mkdir(path.join(comicSrc, 'empty'), { recursive: true })
    const plan = await planComicImport(
      comicRequest(id, [
        { path: path.join(comicSrc, 'empty'), season: 1, episode: 1 },
        { path: path.join(comicSrc, 'nope.zip'), season: 1, episode: 2 },
        { path: path.join(comicSrc, 'vol2'), season: 1, episode: 3 },
        { path: path.join(comicSrc, '第01卷'), season: 1, episode: 3 },
      ]),
    )
    expect(plan.map((p) => p.status)).toEqual(['error', 'error', 'error', 'error'])
    await deleteMedia(id)
  })
})

describe('自动化', () => {
  // 用 node 当解释器，测试在 Windows / macOS / Linux 上都能跑；路径带引号是因为 Windows 上有空格
  const node = `"${process.execPath}"`
  const make = (over: Record<string, unknown>) =>
    createAutomation(AutomationInput.parse({ name: '测试脚本', interpreter: node, ...over }))

  it('拆命令行参数', () => {
    expect(parseArgv('bash -e')).toEqual(['bash', '-e'])
    expect(parseArgv('"C:\\Program Files\\nodejs\\node.exe" --no-warnings')).toEqual(['C:\\Program Files\\nodejs\\node.exe', '--no-warnings'])
  })

  it('手动触发：脚本能拿到环境变量，输出和退出码被记录；没开手动触发的会被拒绝', async () => {
    const a = await make({
      manual: true,
      env: [{ key: 'MY_VAR', value: '你好' }],
      content:
        "console.log(process.env.AUTOMEDIA_TRIGGER, process.env.MY_VAR, process.env.AUTOMEDIA_SCRIPT_NAME, process.env.AUTOMEDIA_API_URL)\r\nconsole.error('to-stderr')\r\nprocess.exit(3)",
    })
    const runId = await startRun(a.id, 'manual')
    await expect(startRun(a.id, 'manual')).rejects.toThrow(/正在运行/)
    await idle(a.id)
    const run = getRun(runId)
    expect(run).toMatchObject({ status: 'failed', exitCode: 3, trigger: 'manual' })
    expect(run.output).toContain('manual 你好 测试脚本 http://127.0.0.1:')
    expect(run.output).toContain('to-stderr')
    expect(listRuns(a.id)[0].output).toBeUndefined() // 列表不带输出

    const b = await make({ name: '只能定时', content: 'console.log("ok")' })
    await expect(startRun(b.id, 'manual')).rejects.toThrow(/手动触发/)
    const scheduled = await startRun(b.id, 'schedule')
    await idle(b.id)
    expect(getRun(scheduled)).toMatchObject({ status: 'success', exitCode: 0, trigger: 'schedule' })
    await deleteAutomation(a.id)
    await deleteAutomation(b.id)
  })

  it('服务器上已有的脚本文件；超时会被强制结束', async () => {
    const script = path.join(tmp, 'hello.mjs')
    await fs.writeFile(script, 'console.log("from file", process.cwd() === import.meta.dirname)')
    const a = await make({ source: 'file', filePath: script, manual: true })
    const runId = await startRun(a.id, 'manual')
    await idle(a.id)
    expect(getRun(runId)).toMatchObject({ status: 'success' })
    expect(getRun(runId).output).toContain('from file true') // 工作目录默认是脚本所在的目录

    const slow = await make({ name: '慢脚本', manual: true, timeoutSec: 1, content: 'console.log("start"); setTimeout(() => {}, 60000)' })
    const slowRun = await startRun(slow.id, 'manual')
    await idle(slow.id)
    expect(getRun(slowRun).status).toBe('timeout')
    expect(getRun(slowRun).output).toContain('start')
    await deleteAutomation(a.id)
    await deleteAutomation(slow.id)
  })

  it('定时：到点自动执行；停用后不再触发', async () => {
    const a = await make({ content: 'console.log("tick")', triggers: [{ type: 'schedule', cron: '* * * * * *' }] })
    expect(listAutomations().find((x) => x.id === a.id)?.nextRun).toBeGreaterThan(Date.now() - 1000)
    for (let i = 0; i < 40 && !listRuns(a.id).some((r) => r.status === 'success'); i++) await new Promise((r) => setTimeout(r, 100))
    const first = listRuns(a.id).find((r) => r.status === 'success')
    expect(first).toMatchObject({ trigger: 'schedule', exitCode: 0 })

    const { id: _i, createdAt: _c, updatedAt: _u, ...input } = a
    await updateAutomation(a.id, { ...input, enabled: false })
    await idle(a.id)
    expect(listAutomations().find((x) => x.id === a.id)?.nextRun).toBeNull()
    const count = listRuns(a.id).length
    await new Promise((r) => setTimeout(r, 1300))
    expect(listRuns(a.id).length).toBe(count)
    await deleteAutomation(a.id)
    expect(listAutomations().some((x) => x.id === a.id)).toBe(false)
  })

  it('保存时校验', async () => {
    await expect(make({ content: 'x', triggers: [{ type: 'schedule', cron: '每天三点' }] })).rejects.toThrow(/定时表达式无效/)
    await expect(make({ content: '   ' })).rejects.toThrow(/空的/)
    await expect(make({ source: 'file', filePath: path.join(tmp, 'nope.sh') })).rejects.toThrow(/没有这个文件/)
    await expect(make({ content: 'x', env: [{ key: 'A', value: '1' }, { key: 'A', value: '2' }] })).rejects.toThrow(/重名/)
    expect(() => AutomationInput.parse({ name: 'x', env: [{ key: '1BAD', value: '' }] })).toThrow()
  })

  it('在网页里编辑服务器上的脚本文件', async () => {
    const file = path.join(tmp, 'scripts', 'edit-me.sh')
    await fs.mkdir(path.dirname(file), { recursive: true })

    // 不存在：可以新建
    const fresh = await readScriptFile(file)
    expect([fresh.exists, fresh.mtimeMs, fresh.content]).toEqual([false, null, ''])
    const created = await writeScriptFile({ path: file, content: 'echo 1\n', expectedMtime: null, eol: 'lf', bom: false })
    expect([created.exists, created.content]).toEqual([true, 'echo 1\n'])
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o111).not.toBe(0) // 新建的给了可执行权限

    // CRLF + BOM 的文件：编辑器里看到的是 LF，写回去还是 CRLF + BOM
    const crlf = '﻿line1\r\nchanged\r\n'
    await fs.writeFile(file, '﻿line1\r\nline2\r\n')
    const opened = await readScriptFile(file)
    expect([opened.content, opened.eol, opened.bom]).toEqual(['line1\nline2\n', 'crlf', true])
    const saved = await writeScriptFile({ path: file, content: 'line1\nchanged\n', expectedMtime: opened.mtimeMs, eol: opened.eol, bom: opened.bom })
    expect(await fs.readFile(file, 'utf8')).toBe(crlf)

    // 打开之后文件在别处被改了：拒绝覆盖
    await fs.utimes(file, new Date(), new Date(Date.now() + 5000))
    await expect(
      writeScriptFile({ path: file, content: 'mine', expectedMtime: saved.mtimeMs, eol: 'lf', bom: false }),
    ).rejects.toThrow(/被别处修改过/)
    expect(await fs.readFile(file, 'utf8')).toBe(crlf)

    await expect(readScriptFile('relative/path.sh')).rejects.toThrow(/绝对路径/)
    await expect(readScriptFile(path.dirname(file))).rejects.toThrow(/不是一个文件/)
    await fs.writeFile(path.join(tmp, 'scripts', 'bin'), Buffer.from([0x7f, 0x45, 0x00, 0x01]))
    await expect(readScriptFile(path.join(tmp, 'scripts', 'bin'))).rejects.toThrow(/二进制/)
    await expect(
      writeScriptFile({ path: path.join(tmp, 'no-such-dir', 'x.sh'), content: '', expectedMtime: null, eol: 'lf', bom: false }),
    ).rejects.toThrow(/目录不存在/)
  })
})

describe('漫画封面', () => {
  it('上传后免密码可读，并落成媒体库目录里的 folder.jpg；清除后一并删掉', async () => {
    const app = await buildApp({ password: 'secret', serveWeb: false })
    const auth = { authorization: 'Bearer secret' }
    const id = createMedia(MediaSaveInput.parse({ media: { kind: 'comic', title: '封面漫画', libraryId: 'anime' } }))
    await executeComicImport(
      ComicImportRequest.parse({
        mediaId: id,
        linkMode: 'copy',
        sourceType: 'dir',
        sourceRef: 'cover',
        items: [{ path: path.join(tmp, 'downloads', '[漫画] 测试漫画', 'vol2'), season: 1, episode: 1 }],
      }),
    )
    const dir = path.join(lib, '封面漫画')
    const multipart = (data: string, type: string) => {
      const boundary = 'automediatestboundary'
      return {
        headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="cover"\r\nContent-Type: ${type}\r\n\r\n${data}\r\n--${boundary}--\r\n`,
        ),
      }
    }

    const bad = await app.inject({ method: 'POST', url: `/api/media/${id}/poster`, ...multipart('x', 'text/plain') })
    expect(bad.statusCode).toBe(400)

    const up = await app.inject({ method: 'POST', url: `/api/media/${id}/poster`, ...multipart('JPEG-ONE', 'image/jpeg') })
    expect(up.statusCode).toBe(200)
    const first: string = up.json().posterUrl
    expect(first).toMatch(/^\/api\/posters\/[a-f0-9]{32}\.jpg$/)
    expect(getMediaDetail(id).media.posterUrl).toBe(first)
    const img = await app.inject({ url: first }) // 不带密码
    expect([img.statusCode, img.headers['content-type'], img.body]).toEqual([200, 'image/jpeg', 'JPEG-ONE'])
    expect(await read(path.join(dir, 'folder.jpg'))).toBe('JPEG-ONE')
    expect((await app.inject({ url: '/api/posters/..%2Fautomedia.db' })).statusCode).toBe(404)

    // 换一张：旧文件删掉，媒体库里的跟着换
    const again = await app.inject({ method: 'POST', url: `/api/media/${id}/poster`, ...multipart('PNG-TWO', 'image/png') })
    const second: string = again.json().posterUrl
    expect((await app.inject({ url: first })).statusCode).toBe(404)
    expect(await read(path.join(dir, 'folder.png'))).toBe('PNG-TWO')
    expect(await has(path.join(dir, 'folder.jpg'))).toBe(false)

    // CBZ 模式：Emby 不从 cbz 里取封面，同一个文件夹里的书也不认 folder.jpg，只认 <书名>-poster.*，所以每本旁边放一份
    saveMedia(id, MediaSaveInput.parse({ media: { ...getMediaDetail(id).media, comicFormat: 'cbz' } }))
    await executeComicImport(
      ComicImportRequest.parse({
        mediaId: id,
        linkMode: 'copy',
        sourceType: 'dir',
        sourceRef: 'cover',
        items: [{ path: path.join(tmp, 'downloads', '[漫画] 测试漫画', '第01卷'), season: 1, episode: 2 }],
      }),
    )
    expect((await syncMedia(id)).warnings).toEqual([])
    const ls = async () => (await fs.readdir(dir)).sort()
    expect(await ls()).toEqual([
      'folder.png',
      '封面漫画 - 001-poster.png',
      '封面漫画 - 001.cbz',
      '封面漫画 - 002-poster.png',
      '封面漫画 - 002.cbz',
    ])
    expect(await read(path.join(dir, '封面漫画 - 002-poster.png'))).toBe('PNG-TWO')

    const del = await app.inject({ method: 'DELETE', url: `/api/media/${id}/poster`, headers: auth })
    expect(del.json().posterUrl).toBe('')
    expect((await app.inject({ url: second })).statusCode).toBe(404)
    expect(await ls()).toEqual(['封面漫画 - 001.cbz', '封面漫画 - 002.cbz'])
    await deleteMedia(id)
    await app.close()
  })
})

describe('只监听内网地址', () => {
  const rules = parseListen('100.99.255.255, 192.168.5.255')!

  it('网段的几种写法', () => {
    expect(rules.map(describeRule)).toEqual(['100.99.0.0/16', '192.168.5.0/24'])
    expect(parseListen('100.64.0.0/10,10.0.0.5 fd7a:115c:a1e0::/48')!.map(describeRule)).toEqual([
      '100.64.0.0/10',
      '10.0.0.5/32',
      'fd7a:115c:a1e0::/48',
    ])
    expect(parseListen(undefined)).toBeNull()
    expect(parseListen('  ')).toBeNull()
    for (const bad of ['192.168.5', '192.168.5.0/33', 'lan', '192.168.5.0/24/1']) expect(() => parseListen(bad)).toThrow(/AUTOMEDIA_LISTEN/)
  })

  it('判断一个地址在不在网段里', () => {
    const inside = matcher(rules)
    expect(['192.168.5.3', '::ffff:192.168.5.200', '100.99.12.34'].map(inside)).toEqual([true, true, true])
    expect(['192.168.6.3', '100.100.1.1', '8.8.8.8', '127.0.0.1', undefined, 'garbage'].map(inside)).toEqual([false, false, false, false, false, false])
  })

  it('从本机网卡里挑出要监听的地址', () => {
    const nic = (address: string, family: 'IPv4' | 'IPv6' = 'IPv4') =>
      ({ address, family, netmask: '', mac: '', internal: false, cidr: null, scopeid: 0 }) as never
    const interfaces = {
      lo0: [nic('127.0.0.1')],
      en0: [nic('192.168.5.3'), nic('fe80::1', 'IPv6')],
      utun4: [nic('100.99.12.34'), nic('fd7a:115c:a1e0::1234', 'IPv6')],
      en5: [nic('203.0.113.7')], // 公网地址：不监听
    }
    expect(localAddresses(rules, interfaces).sort()).toEqual(['100.99.12.34', '192.168.5.3'])
  })

  it('在挑出来的地址上提供服务；网卡变化后跟着增减', async () => {
    const app = await buildApp({ password: 'secret', serveWeb: false })
    await app.ready()
    let up = true
    const logs: string[] = []
    const listeners = startRestrictedListeners({
      handler: requestHandlerOf(app),
      rules: parseListen('127.0.0.0/8')!, // 测试机上一定存在的「内网」地址
      port: 0,
      includeLoopback: true,
      rescanMs: 50,
      log: (m) => logs.push(m),
      interfaces: () =>
        up ? { lo: [{ address: '127.0.0.1', family: 'IPv4', netmask: '', mac: '', internal: true, cidr: null }] } : {},
    })
    await new Promise((r) => setTimeout(r, 150))
    expect(listeners.addresses()).toEqual(['127.0.0.1'])
    const port = listeners.portOf('127.0.0.1')!
    const res = await fetch(`http://127.0.0.1:${port}/api/health`)
    expect([res.status, await res.json()]).toEqual([200, { ok: true }])
    expect((await fetch(`http://127.0.0.1:${port}/api/media`)).status).toBe(401) // 密码校验照常

    up = false // 这个地址从本机上消失了
    await new Promise((r) => setTimeout(r, 200))
    expect(listeners.addresses()).toEqual([])
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow()
    expect(logs.some((l) => l.includes('不再监听 127.0.0.1'))).toBe(true)
    listeners.stop()
    await app.close()
  })
})

describe('按种子标题自动匹配', () => {
  it('编辑距离', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3)
    expect(levenshtein('', 'abc')).toBe(3)
    expect(levenshtein('重启人生', '重启人生')).toBe(0)
    expect(levenshtein('重启人生', '重生人生')).toBe(1) // 按字符而不是 UTF-16 单元算
  })

  it('从种子名里拆出可能的作品名', () => {
    expect(titleCandidates('[VCB-Studio] ReLIFE [Ma10p_1080p]')).toEqual(['relife', 'vcb studio', 'vcb studio relife'])
    expect(titleCandidates('[Nekomoe kissaten][Kusuriya no Hitorigoto][01-24][1080p][JPSC]')).toContain('kusuriya no hitorigoto')
    expect(titleCandidates('[漫画] Another Comic Vol.1.zip')[0]).toBe('another comic')
    expect(titleCandidates('Some.Show.S01.1080p.BluRay.x265-GRP')[0]).toBe('some show grp')
  })

  it('按相似度排序，导入过的排在最后', () => {
    const list = [
      { id: 1, title: 'Re:Zero', originalTitle: 'Re:ゼロから始める異世界生活', imported: false },
      { id: 2, title: '重启人生', originalTitle: 'ReLIFE', imported: false },
      { id: 3, title: 'ReLIFE 完结篇', originalTitle: '', imported: true },
      { id: 4, title: 'Lycoris Recoil', originalTitle: '', imported: false },
    ]
    const ranked = rankBySimilarity('[VCB-Studio] ReLIFE [Ma10p_1080p]', list, (m) => m.imported)
    expect(ranked.map((r) => r.item.id)).toEqual([2, 1, 4, 3])
    expect(ranked[0].score).toBe(1) // 原名完全一致
    expect(ranked[3].score).toBe(-1)
    // 都被排除时没有可以自动选的
    expect(rankBySimilarity('ReLIFE', list, () => true).every((r) => r.score === -1)).toBe(true)
  })

  it('统计还空着的集：一本一个种子的漫画，只导入了一部分时不算「已全部导入」', async () => {
    const src = path.join(tmp, 'downloads', '分卷漫画')
    for (const v of ['v1', 'v2', 'v3']) {
      await fs.mkdir(path.join(src, v), { recursive: true })
      await fs.writeFile(path.join(src, v, '1.jpg'), v)
    }
    const id = createMedia(
      MediaSaveInput.parse({
        media: { kind: 'comic', title: '分卷漫画', libraryId: 'anime' },
        episodes: [1, 2, 3].map((number) => ({ season: 1, number })),
      }),
    )
    const counts = () => {
      const m = listMedia().find((x) => x.id === id)!
      return [m.episodeCount, m.missingCount]
    }
    const importVols = (vols: number[]) =>
      executeComicImport(
        ComicImportRequest.parse({
          mediaId: id,
          linkMode: 'copy',
          sourceType: 'dir',
          sourceRef: src,
          items: vols.map((n) => ({ path: path.join(src, `v${n}`), season: 1, episode: n })),
        }),
      )
    expect(counts()).toEqual([3, 3])
    await importVols([1])
    expect(counts()).toEqual([3, 2])
    await importVols([2, 3])
    expect(counts()).toEqual([3, 0])
  })
})

describe('HTTP', () => {
  it('密码作为 Bearer token', async () => {
    const app = await buildApp({ password: 'secret', serveWeb: false })
    expect((await app.inject({ url: '/api/health' })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/media' })).statusCode).toBe(401)
    expect((await app.inject({ url: '/api/media', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401)
    const ok = await app.inject({ url: '/api/media', headers: { authorization: 'Bearer secret' } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().some((m: { title: string }) => m.title === 'ReLIFE')).toBe(true)
    const bad = await app.inject({ method: 'POST', url: '/api/media', headers: { authorization: 'Bearer secret' }, payload: { media: { title: '' } } })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toContain('标题不能为空')
    await app.close()
  })
})
