import {
  pad2,
  type Episode,
  type Link,
  type MediaDetail,
  type MediaInput,
  type MediaKind,
  type Season,
  type Settings,
} from '@automedia/shared'
import { A, useNavigate, useParams } from '@solidjs/router'
import { For, Show, batch, createEffect, createMemo, createResource, createSignal, on } from 'solid-js'
import { createStore, reconcile, unwrap } from 'solid-js/store'
import { api, upload } from '../api'
import { Field, Section, baseName, toast, useAction } from '../ui'
import { Poster } from './MediaList'

interface Form {
  media: MediaInput
  seasons: Season[]
  episodes: Episode[]
}

const blankEpisode = (season: number, number: number): Episode => ({
  season,
  number,
  title: '',
  overview: '',
  airDate: '',
  runtime: null,
  stillUrl: '',
})
const blankSeason = (number: number): Season => ({ number, title: '', overview: '', posterUrl: '' })
const numOrNull = (v: string) => (v.trim() === '' || Number.isNaN(Number(v)) ? null : Number(v))
const splitList = (v: string) =>
  v
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)

type Loaded = MediaDetail & { warnings?: string[] }

export default function MediaDetailPage() {
  const params = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [settings] = createResource(() => api<Settings>('/settings'))
  const [detail, setDetail] = createSignal<MediaDetail>()
  const [form, setForm] = createStore<Form>({ media: {} as MediaInput, seasons: [], episodes: [] })
  const [dirty, setDirty] = createSignal(false)
  const [moreCols, setMoreCols] = createSignal(false)
  /** 当前季号 → 加载时的季号。保存时据此告诉服务端哪些季改了号，已导入的文件要跟着换季 */
  const [seasonOrigin, setSeasonOrigin] = createSignal(new Map<number, number>())
  let grid!: HTMLDivElement

  function load(d: Loaded) {
    const { id: _i, folderPath: _f, createdAt: _c, updatedAt: _u, ...media } = d.media
    const episodes = [...d.episodes]
    // 已经导入了文件、但元数据里还没有的集：先以空行出现，方便直接补
    for (const l of d.links)
      if (!episodes.some((e) => e.season === l.season && e.number === l.episode))
        episodes.push(blankEpisode(l.season, l.episode))
    const seasons = [...d.seasons]
    for (const e of episodes) if (!seasons.some((s) => s.number === e.season)) seasons.push(blankSeason(e.season))
    episodes.sort((a, b) => a.season - b.season || a.number - b.number)
    seasons.sort((a, b) => a.number - b.number)
    setForm(reconcile({ media, seasons, episodes }))
    setSeasonOrigin(new Map(seasons.map((s) => [s.number, s.number])))
    setDetail(d)
    setDirty(false)
    if (d.warnings?.length) toast.err(`磁盘同步有 ${d.warnings.length} 个问题：\n${d.warnings.join('\n')}`)
  }

  createEffect(
    on(
      () => params.id,
      (id) => {
        setDetail(undefined)
        api<MediaDetail>(`/media/${id}`).then(load, toast.err)
      },
    ),
  )

  const edit: typeof setForm = ((...args: unknown[]) => {
    setDirty(true)
    return (setForm as (...a: unknown[]) => void)(...args)
  }) as typeof setForm

  /** 已导入的文件记的是保存时的季号；页面上改过季号、还没保存时，要按新季号显示 */
  const currentSeason = (orig: number) => {
    for (const [cur, o] of seasonOrigin()) if (o === orig) return cur
    return orig
  }
  const linksOf = (season: number, number: number): Link[] =>
    detail()?.links.filter((l) => currentSeason(l.season) === season && l.episode === number) ?? []
  const videoCount = createMemo(() => detail()?.links.filter((l) => l.kind === 'video').length ?? 0)
  const payload = () => ({
    ...structuredClone(unwrap(form)),
    seasonMoves: [...seasonOrigin()].filter(([cur, orig]) => cur !== orig).map(([cur, orig]) => ({ from: orig, to: cur })),
  })

  const [save, saving] = useAction(async () => {
    load(await api<Loaded>(`/media/${params.id}`, { method: 'PUT', body: payload() }))
    toast.ok('已保存，NFO 已更新')
  })
  const [refresh, refreshing] = useAction(async (mode: 'fill' | 'overwrite') => {
    if (dirty() && !confirm('有未保存的修改，刷新会丢弃它们。继续？')) return
    if (mode === 'overwrite' && !confirm('用上游数据覆盖已有字段？（上游没有的季和集不会被删除）')) return
    load(await api<Loaded>(`/media/${params.id}/refresh`, { body: { mode } }))
    toast.ok('已从上游刷新')
  })
  const [sync, syncing] = useAction(async () => {
    if (dirty() && !confirm('有未保存的修改，这个操作只会按已保存的数据重写。继续？')) return
    const d = await api<Loaded>(`/media/${params.id}/sync`, { method: 'POST' })
    setDetail(d)
    if (d.warnings?.length) toast.err(d.warnings.join('\n'))
    else toast.ok('NFO 已重写，缺失的链接已补回')
  })
  const [remove] = useAction(async () => {
    if (!confirm(`删除「${form.media.title}」？\n会移除本工具在媒体库里创建的链接、NFO 和图片，不会动下载的源文件。`)) return
    await api(`/media/${params.id}`, { method: 'DELETE' })
    navigate('/')
  })
  const [removeLink] = useAction(async (l: Link) => {
    if (!confirm(`移除这个文件？\n${baseName(l.targetPath)}\n只删除媒体库里的链接，不动源文件。`)) return
    await api(`/links/${l.id}`, { method: 'DELETE' })
    setDetail(await api<MediaDetail>(`/media/${params.id}`))
  })

  let fileInput!: HTMLInputElement
  const [uploadSubs, uploading] = useAction(async (files: File[]) => {
    const r = await upload<{ path: string }>('/subtitles/upload', files, { mediaId: params.id })
    navigate(`/import?type=dir&ref=${encodeURIComponent(r.path)}&media=${params.id}`)
  })

  function addEpisodes(season: number, count: number) {
    const max = Math.max(0, ...form.episodes.filter((e) => e.season === season).map((e) => e.number))
    edit('episodes', (list) => [...list, ...Array.from({ length: count }, (_, i) => blankEpisode(season, max + 1 + i))])
  }
  function addSeason() {
    const next = Math.max(0, ...form.seasons.map((s) => s.number)) + 1
    const v = prompt('季号（特别篇 / OVA 用 0）', String(next))
    if (v === null) return
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0) return toast.err('季号必须是非负整数')
    if (form.seasons.some((s) => s.number === n)) return toast.err(`第 ${n} 季已经存在`)
    edit('seasons', (list) => [...list, blankSeason(n)].sort((a, b) => a.number - b.number))
  }

  /** 改季号：这一季的所有集、已导入的文件一起换到新季号。返回是否成功。 */
  function renumberSeason(from: number, raw: string): boolean {
    const to = Number(raw.trim())
    if (raw.trim() === '' || !Number.isInteger(to) || to < 0) return (toast.err('季号必须是非负整数'), false)
    if (to === from) return true
    if (form.seasons.some((s) => s.number === to))
      return (toast.err(`第 ${to} 季已经存在。想对调的话，先把其中一季改成一个没用过的季号`), false)
    batch(() => {
      edit('episodes', (e) => e.season === from, 'season', to)
      edit('seasons', (list) =>
        list.map((s) => (s.number === from ? { ...s, number: to } : s)).sort((a, b) => a.number - b.number),
      )
      setSeasonOrigin((m) => {
        const next = new Map(m)
        const orig = next.get(from)
        next.delete(from)
        if (orig !== undefined) next.set(to, orig)
        return next
      })
    })
    return true
  }

  /**
   * 剧集表格的键盘导航：Tab / Shift+Tab 和 ↑↓ 在同一列里上下移动（可以跨季），
   * ←→ 在光标已经到文字开头 / 结尾时移到左右的格子。到表格边缘就交还给浏览器默认行为。
   */
  function onGridKey(e: KeyboardEvent) {
    const el = e.target as HTMLInputElement | HTMLTextAreaElement
    const col = el.dataset?.col
    // isComposing：输入法选字时的方向键不能抢
    if (!col || e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return
    let dRow = 0
    let dCol = 0
    if (e.key === 'Tab') dRow = e.shiftKey ? -1 : 1
    else if (e.shiftKey) return
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const up = e.key === 'ArrowUp'
      if (el instanceof HTMLTextAreaElement) {
        // 多行文本：光标还能在行间移动时不跳格
        const beyond = up ? el.value.slice(0, el.selectionStart) : el.value.slice(el.selectionEnd)
        if (beyond.includes('\n')) return
      }
      dRow = up ? -1 : 1
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const left = e.key === 'ArrowLeft'
      if (el.selectionStart !== el.selectionEnd) return
      if (left ? el.selectionStart !== 0 : el.selectionEnd !== el.value.length) return
      dCol = left ? -1 : 1
    } else return

    const cells = dRow
      ? [...grid.querySelectorAll<HTMLInputElement>(`[data-col="${col}"]`)]
      : [...(el.closest('tr')?.querySelectorAll<HTMLInputElement>('[data-col]') ?? [])]
    const target = cells[cells.indexOf(el as HTMLInputElement) + dRow + dCol]
    if (!target) return
    e.preventDefault()
    target.focus()
    target.select()
  }

  const text = (key: keyof MediaInput) => ({
    value: (form.media[key] as string) ?? '',
    onInput: (e: InputEvent & { currentTarget: HTMLInputElement | HTMLTextAreaElement }) =>
      edit('media', key, e.currentTarget.value as never),
  })

  return (
    <Show when={detail()} fallback={<p class="text-slate-400">加载中…</p>}>
      <div class="sticky top-[49px] z-20 -mx-4 mb-4 flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50/95 px-4 py-2 backdrop-blur">
        <A href="/" class="btn btn-sm">
          ← 返回
        </A>
        <h1 class="mr-auto truncate text-lg font-semibold">{form.media.title}</h1>
        <Show when={dirty()}>
          <span class="badge bg-amber-100 text-amber-800">有未保存的修改</span>
        </Show>
        <input
          ref={fileInput}
          type="file"
          multiple
          class="hidden"
          accept=".zip,.7z,.rar,.ass,.ssa,.srt,.sup,.vtt"
          onChange={(e) => {
            const files = [...(e.currentTarget.files ?? [])]
            e.currentTarget.value = ''
            if (files.length) void uploadSubs(files)
          }}
        />
        <button class="btn" disabled={uploading()} onClick={() => fileInput.click()}>
          {uploading() ? '上传中…' : '上传字幕'}
        </button>
        <A class="btn" href="/sources">
          导入文件
        </A>
        <button class="btn" disabled={refreshing()} onClick={() => void refresh('fill')} title="只补全空字段和缺失的季 / 集">
          从上游补全
        </button>
        <button class="btn" disabled={refreshing()} onClick={() => void refresh('overwrite')}>
          从上游覆盖
        </button>
        <button class="btn" disabled={syncing()} onClick={() => void sync()} title="按当前数据重写 NFO，并补回丢失的链接">
          重写 NFO
        </button>
        <button class="btn btn-danger" onClick={() => void remove()}>
          删除
        </button>
        <button class="btn btn-primary" disabled={saving() || !dirty()} onClick={() => void save()}>
          保存
        </button>
      </div>

      <Section title="基本信息" desc={detail()!.media.folderPath || '尚未导入任何文件，媒体库里还没有它的目录。'}>
        <div class="flex gap-4">
          <Poster url={form.media.posterUrl} class="hidden h-60 w-40 shrink-0 sm:flex" />
          <div class="grid flex-1 gap-3 sm:grid-cols-4">
            <Field class="sm:col-span-2" label="标题">
              <input class="input" {...text('title')} />
            </Field>
            <Field class="sm:col-span-2" label="原名">
              <input class="input" {...text('originalTitle')} />
            </Field>
            <Field label="类型">
              <select class="input" value={form.media.kind} onChange={(e) => edit('media', 'kind', e.currentTarget.value as MediaKind)}>
                <option value="series">剧集</option>
                <option value="movie">电影</option>
              </select>
            </Field>
            <Field label="媒体库">
              <select class="input" value={form.media.libraryId} onChange={(e) => edit('media', 'libraryId', e.currentTarget.value)}>
                <option value="">（未选择）</option>
                <For each={settings()?.libraries}>{(l) => <option value={l.id}>{l.name}</option>}</For>
              </select>
            </Field>
            <Field label="年份">
              <input
                class="input"
                type="number"
                value={form.media.year ?? ''}
                onInput={(e) => edit('media', 'year', numOrNull(e.currentTarget.value))}
              />
            </Field>
            <Field label="首播日期">
              <input class="input" type="date" {...text('premiered')} />
            </Field>
            <Field label="TVDB ID">
              <input class="input font-mono" {...text('tvdbId')} />
            </Field>
            <Field label="TMDB ID">
              <input class="input font-mono" {...text('tmdbId')} />
            </Field>
            <Field label="IMDb ID">
              <input class="input font-mono" {...text('imdbId')} />
            </Field>
            <Field label="评分">
              <input
                class="input"
                type="number"
                step="0.1"
                value={form.media.rating ?? ''}
                onInput={(e) => edit('media', 'rating', numOrNull(e.currentTarget.value))}
              />
            </Field>
            <Field label="状态">
              <input class="input" placeholder="Continuing / Ended" {...text('status')} />
            </Field>
            <Field label="排序标题">
              <input class="input" {...text('sortTitle')} />
            </Field>
            <Field class="sm:col-span-2" label="类型标签（逗号分隔）">
              <input
                class="input"
                value={form.media.genres.join(', ')}
                onChange={(e) => edit('media', 'genres', splitList(e.currentTarget.value))}
              />
            </Field>
            <Field class="sm:col-span-2" label="制作公司 / 电视台（逗号分隔）">
              <input
                class="input"
                value={form.media.studios.join(', ')}
                onChange={(e) => edit('media', 'studios', splitList(e.currentTarget.value))}
              />
            </Field>
            <Field class="sm:col-span-2" label="海报 URL">
              <input class="input font-mono text-xs" {...text('posterUrl')} />
            </Field>
            <Field class="sm:col-span-2" label="背景图 URL">
              <input class="input font-mono text-xs" {...text('fanartUrl')} />
            </Field>
            <Field class="sm:col-span-4" label="简介">
              <textarea class="input" rows={3} {...text('overview')} />
            </Field>
          </div>
        </div>
      </Section>

      <div class="mb-2 flex items-center gap-3">
        <h2 class="font-semibold">季与集</h2>
        <span class="text-xs text-slate-400">
          {form.episodes.length} 集，已导入 {videoCount()} 个视频
        </span>
        <span class="ml-auto hidden text-xs text-slate-400 md:inline">Tab / ↑↓ 上下移动，←→ 左右移动；季号可以直接改</span>
        <label class="flex items-center gap-1 text-xs text-slate-500">
          <input type="checkbox" checked={moreCols()} onChange={(e) => setMoreCols(e.currentTarget.checked)} />
          显示简介和剧照列
        </label>
        <button class="btn btn-sm" onClick={addSeason}>
          ＋ 添加季
        </button>
      </div>

      <div ref={grid} onKeyDown={onGridKey}>
      <For each={form.seasons} fallback={<p class="card p-6 text-center text-slate-400">还没有季。点「添加季」开始，或者直接导入文件。</p>}>
        {(season) => {
          const episodes = createMemo(() => form.episodes.filter((e) => e.season === season.number))
          const setSeason = (key: keyof Season, v: string) => edit('seasons', (s) => s.number === season.number, key, v as never)
          return (
            <section class="card mb-4">
              <div class="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2">
                <label class="flex shrink-0 items-center gap-1 font-semibold" title="改季号：这一季的集和已导入的文件会一起换到新季号（保存后生效）。特别篇 / OVA 用 0">
                  第
                  <input
                    class="input input-sm w-12 text-center font-semibold"
                    inputmode="numeric"
                    value={season.number}
                    onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                    onChange={(e) => {
                      if (!renumberSeason(season.number, e.currentTarget.value)) e.currentTarget.value = String(season.number)
                    }}
                  />
                  季
                  <Show when={season.number === 0}>
                    <span class="badge bg-slate-100 font-normal text-slate-500">特别篇</span>
                  </Show>
                </label>
                <input
                  class="input input-sm w-48"
                  placeholder="季标题（如 完结篇）"
                  value={season.title}
                  onInput={(e) => setSeason('title', e.currentTarget.value)}
                />
                <input
                  class="input input-sm min-w-40 flex-1"
                  placeholder="季简介"
                  value={season.overview}
                  onInput={(e) => setSeason('overview', e.currentTarget.value)}
                />
                <input
                  class="input input-sm w-48 font-mono"
                  placeholder="季海报 URL"
                  value={season.posterUrl}
                  onInput={(e) => setSeason('posterUrl', e.currentTarget.value)}
                />
                <button class="btn btn-sm" onClick={() => addEpisodes(season.number, 1)}>
                  ＋1 集
                </button>
                <button
                  class="btn btn-sm"
                  onClick={() => {
                    const n = Number(prompt('添加多少集？', '12'))
                    if (Number.isInteger(n) && n > 0 && n <= 2000) addEpisodes(season.number, n)
                  }}
                >
                  ＋N 集
                </button>
                <button
                  class="btn btn-sm btn-danger"
                  onClick={() => {
                    if (episodes().length && !confirm(`移除第 ${season.number} 季和它的 ${episodes().length} 集元数据？（已导入的文件不受影响）`)) return
                    edit('episodes', (list) => list.filter((e) => e.season !== season.number))
                    const n = season.number
                    edit('seasons', (list) => list.filter((s) => s.number !== n))
                    setSeasonOrigin((m) => {
                      const next = new Map(m)
                      next.delete(n)
                      return next
                    })
                  }}
                >
                  移除季
                </button>
              </div>
              <Show when={episodes().length} fallback={<p class="px-3 py-4 text-center text-xs text-slate-400">这一季还没有集。</p>}>
                <div class="overflow-x-auto">
                  <table class="w-full text-xs">
                    <thead class="text-left text-slate-400">
                      <tr>
                        <th class="w-16 px-3 py-1.5 font-normal">集</th>
                        <th class="min-w-48 px-1 font-normal">标题</th>
                        <th class="w-32 px-1 font-normal">播出日期</th>
                        <th class="w-16 px-1 font-normal">时长</th>
                        <Show when={moreCols()}>
                          <th class="min-w-64 px-1 font-normal">简介</th>
                          <th class="min-w-40 px-1 font-normal">剧照 URL</th>
                        </Show>
                        <th class="px-1 font-normal">已导入的文件</th>
                        <th class="w-10" />
                      </tr>
                    </thead>
                    <tbody>
                      <For each={episodes()}>
                        {(ep) => {
                          const set = (key: keyof Episode, v: string | number | null) =>
                            edit('episodes', (e) => e === ep || (e.season === ep.season && e.number === ep.number), key, v as never)
                          const links = () => linksOf(ep.season, ep.number)
                          return (
                            <tr class="border-t border-slate-100 align-top">
                              <td class="px-3 py-1 font-mono leading-6 text-slate-500">
                                S{pad2(ep.season)}E{pad2(ep.number)}
                              </td>
                              <td class="p-1">
                                <input
                                  class="input input-sm"
                                  data-col="title"
                                  placeholder={links().length ? '缺元数据，可在这里补' : ''}
                                  value={ep.title}
                                  onInput={(e) => set('title', e.currentTarget.value)}
                                />
                              </td>
                              <td class="p-1">
                                <input
                                  class="input input-sm"
                                  data-col="airDate"
                                  placeholder="YYYY-MM-DD"
                                  value={ep.airDate}
                                  onInput={(e) => set('airDate', e.currentTarget.value.trim())}
                                />
                              </td>
                              <td class="p-1">
                                <input
                                  class="input input-sm"
                                  data-col="runtime"
                                  inputmode="decimal"
                                  placeholder="分钟"
                                  value={ep.runtime ?? ''}
                                  onInput={(e) => set('runtime', numOrNull(e.currentTarget.value))}
                                />
                              </td>
                              <Show when={moreCols()}>
                                <td class="p-1">
                                  <textarea class="input input-sm" data-col="overview" rows={2} value={ep.overview} onInput={(e) => set('overview', e.currentTarget.value)} />
                                </td>
                                <td class="p-1">
                                  <input class="input input-sm font-mono" data-col="stillUrl" value={ep.stillUrl} onInput={(e) => set('stillUrl', e.currentTarget.value)} />
                                </td>
                              </Show>
                              <td class="p-1">
                                <div class="flex flex-wrap gap-1 leading-6">
                                  <For each={links()}>
                                    {(l) => (
                                      <span
                                        class="badge gap-1"
                                        classList={{
                                          'bg-emerald-100 text-emerald-800': l.kind === 'video',
                                          'bg-sky-100 text-sky-800': l.kind !== 'video',
                                        }}
                                        title={`${l.targetPath}\n← ${l.sourcePath}\n${l.linkMode} · ${l.sourceName}`}
                                      >
                                        {l.suffix ? `${l.suffix}.` : ''}
                                        {l.ext}
                                        <button class="cursor-pointer opacity-60 hover:opacity-100" title="移除这个链接" onClick={() => void removeLink(l)}>
                                          ✕
                                        </button>
                                      </span>
                                    )}
                                  </For>
                                </div>
                              </td>
                              <td class="p-1 text-right">
                                <button
                                  class="btn btn-sm"
                                  title="删除这一集的元数据"
                                  onClick={() => edit('episodes', (list) => list.filter((e) => !(e.season === ep.season && e.number === ep.number)))}
                                >
                                  ✕
                                </button>
                              </td>
                            </tr>
                          )
                        }}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
            </section>
          )
        }}
      </For>
      </div>
    </Show>
  )
}
