import type {
  ComicFormat,
  LookupBy,
  MediaDetail,
  MediaKind,
  MediaListItem,
  ProviderSearchResult,
  Settings,
} from '@automedia/shared'
import { A, useNavigate } from '@solidjs/router'
import { For, Show, createMemo, createResource, createSignal } from 'solid-js'
import { api } from '../api'
import { Field, Modal, useAction } from '../ui'

export function Poster(props: { url: string; class?: string }) {
  const [broken, setBroken] = createSignal(false)
  return (
    <div class={`flex items-center justify-center overflow-hidden rounded bg-slate-200 text-xs text-slate-400 ${props.class ?? ''}`}>
      <Show when={props.url && !broken()} fallback="无海报">
        <img src={props.url} loading="lazy" class="h-full w-full object-cover" onError={() => setBroken(true)} />
      </Show>
    </div>
  )
}

function NewMediaModal(props: { comic?: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const [settings] = createResource(() => api<Settings>('/settings'))
  const [tab, setTab] = createSignal<'provider' | 'manual'>(props.comic ? 'manual' : 'provider')
  const [kind, setKind] = createSignal<MediaKind>(props.comic ? 'comic' : 'series')
  const [libraryId, setLibraryId] = createSignal<string | null>(null)
  const library = () => libraryId() ?? settings()?.libraries[0]?.id ?? ''
  const [formatPick, setFormat] = createSignal<ComicFormat | null>(null)
  const comicFormat = () => formatPick() ?? settings()?.comicDefaultFormat ?? 'images'

  const [by, setBy] = createSignal<LookupBy>('name')
  const [query, setQuery] = createSignal('')
  const [results, setResults] = createSignal<ProviderSearchResult[] | null>(null)
  const [search, searching] = useAction(async () => {
    setResults(await api<ProviderSearchResult[]>('/providers/tmdb/search', { query: { kind: kind(), by: by(), q: query() } }))
  })
  const [add, adding] = useAction(async (r: ProviderSearchResult) => {
    const d = await api<MediaDetail>('/media/from-provider', {
      body: { provider: r.provider, kind: r.kind, id: r.id, libraryId: library() },
    })
    navigate(`/media/${d.media.id}`)
  })

  const [title, setTitle] = createSignal('')
  const [year, setYear] = createSignal('')
  const [create, creating] = useAction(async () => {
    const d = await api<MediaDetail>('/media', {
      body: {
        media: { kind: kind(), title: title(), year: year() ? Number(year()) : null, libraryId: library(), comicFormat: comicFormat() },
      },
    })
    navigate(`/media/${d.media.id}`)
  })

  const tabClass = (active: boolean) =>
    `px-3 py-1.5 border-b-2 ${active ? 'border-indigo-600 font-medium text-indigo-700' : 'border-transparent text-slate-500'}`

  return (
    <Modal title={props.comic ? '新建漫画' : '新建媒体'} onClose={props.onClose} wide>
      <div class="mb-4 flex gap-2 border-b border-slate-200" classList={{ hidden: props.comic }}>
        <button class={tabClass(tab() === 'provider')} onClick={() => setTab('provider')}>
          从 TMDB 导入
        </button>
        <button class={tabClass(tab() === 'manual')} onClick={() => setTab('manual')}>
          手动创建
        </button>
      </div>

      <div class="mb-4 grid gap-3 sm:grid-cols-2">
        <Field class={props.comic ? 'hidden' : ''} label="类型" hint="只影响落盘的目录结构（Emby 剧集 / 电影），数据结构相同。">
          <select class="input" value={kind()} onChange={(e) => (setKind(e.currentTarget.value as MediaKind), setResults(null))}>
            <option value="series">剧集</option>
            <option value="movie">电影</option>
          </select>
        </Field>
        <Field class={props.comic ? '' : 'hidden'} label="形式">
          <select class="input" value={comicFormat()} onChange={(e) => setFormat(e.currentTarget.value as ComicFormat)}>
            <option value="images">图片文件夹（Emby 图片库）</option>
              <option value="cbz">CBZ（Emby 书籍库）</option>
          </select>
        </Field>
        <Field label="媒体库">
          <select class="input" value={library()} onChange={(e) => setLibraryId(e.currentTarget.value)}>
            <option value="">（暂不选择）</option>
            <For each={settings()?.libraries}>{(l) => <option value={l.id}>{l.name}</option>}</For>
          </select>
        </Field>
      </div>

      <Show when={tab() === 'provider'}>
        <form
          class="mb-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void search()
          }}
        >
          <select class="input w-32 shrink-0" value={by()} onChange={(e) => setBy(e.currentTarget.value as LookupBy)}>
            <option value="name">按名称</option>
            <option value="tvdb">TVDB ID</option>
            <option value="tmdb">TMDB ID</option>
            <option value="imdb">IMDb ID</option>
          </select>
          <input
            class="input"
            autofocus
            placeholder={by() === 'name' ? '作品名称' : by() === 'imdb' ? 'tt1234567' : '数字 ID'}
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <button class="btn btn-primary" disabled={searching() || !query().trim()}>
            搜索
          </button>
        </form>
        <Show when={results()}>
          <For each={results()} fallback={<p class="py-6 text-center text-slate-400">没有找到。上游没有的作品可以切到「手动创建」。</p>}>
            {(r) => (
              <div class="flex gap-3 border-t border-slate-100 py-3">
                <Poster url={r.posterUrl} class="h-24 w-16 shrink-0" />
                <div class="min-w-0 flex-1">
                  <div class="font-medium">
                    {r.title} <span class="font-normal text-slate-400">{r.year ?? ''}</span>
                  </div>
                  <div class="text-xs text-slate-500">{r.originalTitle}</div>
                  <p class="mt-1 line-clamp-2 text-xs text-slate-500">{r.overview}</p>
                </div>
                <button class="btn self-center" disabled={adding()} onClick={() => void add(r)}>
                  添加
                </button>
              </div>
            )}
          </For>
        </Show>
      </Show>

      <Show when={tab() === 'manual'}>
        <form
          class="grid gap-3 sm:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
        >
          <Field class="sm:col-span-3" label="标题">
            <input class="input" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
          </Field>
          <Field label="年份">
            <input class="input" type="number" value={year()} onInput={(e) => setYear(e.currentTarget.value)} />
          </Field>
          <div class="sm:col-span-4">
            <button class="btn btn-primary" disabled={creating() || !title().trim()}>
              创建
            </button>
            <span class="ml-3 text-xs text-slate-400">
              {props.comic
                ? '媒体库要和形式对应：图片文件夹选 Emby 图片库的目录，CBZ 选书籍库的目录。季 / 集在创建后的页面里填写，也可以直接导入。'
                : '其余信息和季 / 集在创建后的页面里填写。'}
            </span>
          </div>
        </form>
      </Show>
    </Modal>
  )
}

const KIND_LABEL: Record<MediaKind, string> = { series: '剧集', movie: '电影', comic: '漫画' }

export const ComicListPage = () => <MediaListPage comic />

export default function MediaListPage(props: { comic?: boolean }) {
  const noun = () => (props.comic ? '漫画' : '媒体')
  const [list] = createResource(async () =>
    (await api<MediaListItem[]>('/media')).filter((m) => (m.kind === 'comic') === !!props.comic),
  )
  const [q, setQ] = createSignal('')
  const [creating, setCreating] = createSignal(false)
  const filtered = createMemo(() => {
    const k = q().trim().toLowerCase()
    const all = list() ?? []
    return k ? all.filter((m) => `${m.title} ${m.originalTitle}`.toLowerCase().includes(k)) : all
  })

  return (
    <>
      <div class="mb-4 flex items-center gap-3">
        <h1 class="text-lg font-semibold">{noun()}</h1>
        <input class="input max-w-xs" placeholder="搜索标题" value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
        <span class="text-xs text-slate-400">{filtered().length} 个</span>
        <button class="btn btn-primary ml-auto" onClick={() => setCreating(true)}>
          ＋ 新建{noun()}
        </button>
      </div>

      <Show when={!list.loading} fallback={<p class="text-slate-400">加载中…</p>}>
        <div class="grid grid-cols-2 gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
          <For
            each={filtered()}
            fallback={
              <p class="col-span-full py-16 text-center text-slate-400">
                {list()?.length ? `没有匹配的${noun()}。` : `还没有${noun()}。先去「设置」加一个媒体库，再点右上角新建。`}
              </p>
            }
          >
            {(m) => (
              <A href={`/media/${m.id}`} class="card block overflow-hidden hover:border-indigo-400">
                <Poster url={m.posterUrl} class="aspect-[2/3] w-full rounded-none" />
                <div class="p-2">
                  <div class="truncate font-medium" title={m.title}>
                    {m.title}
                  </div>
                  <div class="mt-0.5 flex items-center justify-between text-xs text-slate-500">
                    <span>
                      {m.year ?? '—'} · {KIND_LABEL[m.kind]}
                    </span>
                    <span classList={{ 'text-emerald-600': m.videoCount > 0 }}>
                      {props.comic ? `${m.videoCount} 集` : `${m.videoCount}/${m.episodeCount}`}
                    </span>
                  </div>
                </div>
              </A>
            )}
          </For>
        </div>
      </Show>

      <Show when={creating()}>
        <NewMediaModal comic={props.comic} onClose={() => setCreating(false)} />
      </Show>
    </>
  )
}
