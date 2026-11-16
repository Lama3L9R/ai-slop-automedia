import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import zlib from 'node:zlib'
import { ImportRequest, MediaSaveInput, guessSubtitleSuffix, naturalCompare } from '@automedia/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { parseItems, render } from '../src/ai/suggest'
import { buildApp } from '../src/app'
import { openDb } from '../src/db'
import { executeImport, planImport } from '../src/import/engine'
import { parseEpisodes } from '../src/media/existing'
import { createMedia, deleteMedia, getMediaDetail, removeLinks, saveMedia } from '../src/media/store'
import { imagesIdle, syncMedia } from '../src/media/sync'
import { saveSettings } from '../src/settings'
import { readTree } from '../src/sources/tree'
import { saveUpload } from '../src/subtitles/upload'

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
  await imagesIdle()
  await fs.rm(tmp, { recursive: true, force: true })
})

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
