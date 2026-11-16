import { formatSize, naturalCompare, type TorrentItem, type TorrentState } from '@automedia/shared'
import { A, useNavigate } from '@solidjs/router'
import { For, Show, createMemo, createResource, createSignal } from 'solid-js'
import { api, upload } from '../api'
import { PathInput, Section, fmtDate, toast, useAction } from '../ui'

interface UploadBatch {
  media: string
  name: string
  path: string
  mtime: number
}

/** 记在浏览器里的开关 */
function persisted(key: string, initial: boolean) {
  let start = initial
  try {
    const v = localStorage.getItem(key)
    if (v !== null) start = v === '1'
  } catch {
    /* ignore */
  }
  const [value, setValue] = createSignal(start)
  return [
    value,
    (v: boolean) => {
      setValue(v)
      try {
        localStorage.setItem(key, v ? '1' : '0')
      } catch {
        /* ignore */
      }
    },
  ] as const
}

const wizardUrl = (type: 'torrent' | 'dir', ref: string) => `/import?type=${type}&ref=${encodeURIComponent(ref)}`
const comicWizardUrl = (type: 'torrent' | 'dir', ref: string) => `/import-comic?type=${type}&ref=${encodeURIComponent(ref)}`

/** 分类下拉框里「全部」的取值（qB 里没有分类的种子，分类是空串，所以不能用空串表示全部） */
const ALL = '*'
const CATEGORY_KEY = 'automedia.category'

function Torrents() {
  const [list, { refetch, mutate }] = createResource(() => api<TorrentItem[]>('/torrents'))
  const [q, setQ] = createSignal('')
  const [showImported, setShowImported] = persisted('automedia.showImported', true)
  const [showIgnored, setShowIgnored] = persisted('automedia.showIgnored', false)
  const [categoryPick, setCategoryPick] = createSignal(
    (() => {
      try {
        return localStorage.getItem(CATEGORY_KEY) ?? ALL
      } catch {
        return ALL
      }
    })(),
  )
  const pickCategory = (v: string) => {
    setCategoryPick(v)
    try {
      localStorage.setItem(CATEGORY_KEY, v)
    } catch {
      /* ignore */
    }
  }
  /** 列表里实际出现的分类和各自的数量 */
  const categories = createMemo(() => {
    const m = new Map<string, number>()
    for (const t of list() ?? []) m.set(t.category, (m.get(t.category) ?? 0) + 1)
    return [...m].sort((a, b) => naturalCompare(a[0], b[0]))
  })
  // 记住的分类已经不存在了（改了设置、种子删了）就当作「全部」，免得列表莫名其妙是空的
  const category = () => (categories().some(([c]) => c === categoryPick()) ? categoryPick() : ALL)

  const counts = createMemo(() => {
    const c = { new: 0, imported: 0, ignored: 0 }
    for (const t of list() ?? []) c[t.state]++
    return c
  })
  const filtered = createMemo(() => {
    const k = q().trim().toLowerCase()
    return (list() ?? []).filter(
      (t) =>
        (showImported() || t.state !== 'imported') &&
        (showIgnored() || t.state !== 'ignored') &&
        (category() === ALL || t.category === category()) &&
        (!k || t.name.toLowerCase().includes(k)),
    )
  })

  const [setState] = useAction(async (t: TorrentItem, state: TorrentState) => {
    await api(`/torrents/${t.hash}/state`, { method: 'PUT', body: { state, name: t.name } })
    mutate((items) => items?.map((x) => (x.hash === t.hash ? { ...x, state } : x)))
  })

  return (
    <Section
      title="BT 下载"
      desc="来自 qBittorrent，按设置里的分类过滤。状态只记在本工具里，不会改动 qB。"
      actions={
        <button class="btn" disabled={list.loading} onClick={() => void refetch()}>
          刷新
        </button>
      }
    >
      <div class="mb-3 flex flex-wrap items-center gap-4">
        <input class="input max-w-xs" placeholder="搜索种子名" value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
        <select class="input w-44" value={category()} onChange={(e) => pickCategory(e.currentTarget.value)}>
          <option value={ALL}>全部分类（{list()?.length ?? 0}）</option>
          <For each={categories()}>
            {([c, n]) => (
              <option value={c}>
                {c || '未分类'}（{n}）
              </option>
            )}
          </For>
        </select>
        <label class="flex items-center gap-1">
          <input type="checkbox" checked={showImported()} onChange={(e) => setShowImported(e.currentTarget.checked)} />
          显示已导入（{counts().imported}）
        </label>
        <label class="flex items-center gap-1">
          <input type="checkbox" checked={showIgnored()} onChange={(e) => setShowIgnored(e.currentTarget.checked)} />
          显示已忽略（{counts().ignored}）
        </label>
        <span class="ml-auto text-xs text-slate-400">
          显示 {filtered().length} / {list()?.length ?? 0}
        </span>
      </div>

      <Show when={!list.error} fallback={<p class="rounded bg-red-50 p-3 text-red-700">{String(list.error?.message ?? list.error)}</p>}>
        <Show when={list()} fallback={<p class="py-8 text-center text-slate-400">正在读取 qBittorrent…</p>}>
          <table class="w-full">
            <thead class="text-left text-xs text-slate-400">
              <tr>
                <th class="py-1.5 font-normal">名称</th>
                <th class="w-24 px-2 font-normal">分类</th>
                <th class="w-20 px-2 text-right font-normal">大小</th>
                <th class="w-24 px-2 font-normal">添加时间</th>
                <th class="w-80 font-normal" />
              </tr>
            </thead>
            <tbody>
              <For each={filtered()} fallback={<tr><td colSpan={5} class="py-8 text-center text-slate-400">没有符合条件的种子。</td></tr>}>
                {(t) => (
                  <tr class="border-t border-slate-100" classList={{ 'opacity-50': t.state === 'ignored' }}>
                    <td class="py-2 pr-2">
                      <div class="break-all">{t.name}</div>
                      <div class="mt-0.5 flex flex-wrap items-center gap-1 text-xs">
                        <Show when={t.state === 'imported'}>
                          <span class="badge bg-emerald-100 text-emerald-800">已导入</span>
                        </Show>
                        <Show when={t.state === 'ignored'}>
                          <span class="badge bg-slate-200 text-slate-600">已忽略</span>
                        </Show>
                        <Show when={t.progress < 1}>
                          <span class="badge bg-amber-100 text-amber-800">下载中 {Math.floor(t.progress * 100)}%</span>
                        </Show>
                        <For each={t.importedTo}>
                          {(m) => (
                            <A href={`/media/${m.id}`} class="text-indigo-600 hover:underline">
                              → {m.title}（{m.count} 个文件）
                            </A>
                          )}
                        </For>
                      </div>
                    </td>
                    <td class="px-2 text-xs text-slate-500">{t.category}</td>
                    <td class="px-2 text-right text-xs whitespace-nowrap text-slate-500">{formatSize(t.size)}</td>
                    <td class="px-2 text-xs text-slate-500">{fmtDate(t.addedOn * 1000)}</td>
                    <td class="py-1 text-right whitespace-nowrap">
                      <A class="btn btn-sm btn-primary" href={wizardUrl('torrent', t.hash)}>
                        {t.importedTo.length ? '重新导入' : '导入'}
                      </A>{' '}
                      <A class="btn btn-sm" href={comicWizardUrl('torrent', t.hash)} title="当作漫画导入：压缩包原地解压，图片链接进图片库">
                        漫画
                      </A>{' '}
                      <Show
                        when={t.state === 'imported'}
                        fallback={
                          <button class="btn btn-sm" onClick={() => void setState(t, 'imported')}>
                            标为已导入
                          </button>
                        }
                      >
                        <button class="btn btn-sm" onClick={() => void setState(t, 'new')}>
                          取消已导入
                        </button>
                      </Show>{' '}
                      <Show
                        when={t.state === 'ignored'}
                        fallback={
                          <button class="btn btn-sm" onClick={() => void setState(t, 'ignored')}>
                            忽略
                          </button>
                        }
                      >
                        <button class="btn btn-sm" onClick={() => void setState(t, 'new')}>
                          取消忽略
                        </button>
                      </Show>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </Show>
    </Section>
  )
}

function Directories() {
  const navigate = useNavigate()
  const [dir, setDir] = createSignal('')
  const [uploads, { refetch }] = createResource(() => api<UploadBatch[]>('/subtitles/uploads'))
  let fileInput!: HTMLInputElement
  const [doUpload, uploading] = useAction(async (files: File[]) => {
    const r = await upload<{ path: string }>('/subtitles/upload', files)
    toast.ok('上传完成')
    void refetch()
    navigate(wizardUrl('dir', r.path))
  })

  return (
    <>
      <Section title="从目录导入" desc="不走 BT 的内容：自己的视频、手动下载的文件等。选一个服务器上的目录打开导入向导。">
        <div class="flex gap-2">
          <div class="flex-1">
            <PathInput value={dir()} onChange={setDir} placeholder="/Volumes/Data/my-videos" />
          </div>
          <button class="btn btn-primary" disabled={!dir().trim()} onClick={() => navigate(wizardUrl('dir', dir().trim()))}>
            打开向导
          </button>
          <button class="btn" disabled={!dir().trim()} onClick={() => navigate(comicWizardUrl('dir', dir().trim()))}>
            漫画向导
          </button>
        </div>
      </Section>

      <Section
        title="上传的字幕"
        desc="压缩包（zip / 7z / rar）或零散字幕文件，解压后保存在设置的字幕目录里。也可以在某个媒体的页面里上传，会自动归到它名下。"
        actions={
          <>
            <input
              ref={fileInput}
              type="file"
              multiple
              class="hidden"
              accept=".zip,.7z,.rar,.ass,.ssa,.srt,.sup,.vtt"
              onChange={(e) => {
                const files = [...(e.currentTarget.files ?? [])]
                e.currentTarget.value = ''
                if (files.length) void doUpload(files)
              }}
            />
            <button class="btn" disabled={uploading()} onClick={() => fileInput.click()}>
              {uploading() ? '上传中…' : '上传字幕'}
            </button>
          </>
        }
      >
        <For each={uploads()} fallback={<p class="py-4 text-center text-slate-400">还没有上传过字幕。</p>}>
          {(u) => (
            <div class="flex items-center gap-3 border-t border-slate-100 py-2 first:border-t-0">
              <span class="badge bg-slate-100 text-slate-600">{u.media}</span>
              <span class="min-w-0 flex-1 truncate" title={u.path}>
                {u.name}
              </span>
              <span class="text-xs text-slate-400">{fmtDate(u.mtime)}</span>
              <A class="btn btn-sm" href={wizardUrl('dir', u.path)}>
                打开向导
              </A>
            </div>
          )}
        </For>
      </Section>
    </>
  )
}

export default function SourcesPage() {
  return (
    <>
      <h1 class="mb-4 text-lg font-semibold">来源</h1>
      <Torrents />
      <Directories />
    </>
  )
}
