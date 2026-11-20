import {
  extOf,
  formatSize,
  isArchive,
  isImage,
  naturalCompare,
  pad2,
  type ComicImportResult,
  type ComicPlanItem,
  type LinkMode,
  type MediaListItem,
  type PageImport,
  type Settings,
  type SourceTree,
  type TreeNode,
} from '@automedia/shared'
import { A, useSearchParams } from '@solidjs/router'
import { For, Show, batch, createEffect, createMemo, createResource, createSignal, on, untrack } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import { api } from '../api'
import { rankedMediaOptions } from '../match'
import { Combobox, Modal, toast, useAction } from '../ui'
import { NewMediaModal } from './MediaList'

/**
 * 漫画导入向导。和视频向导的区别：要分配季 / 集的不是单个文件，而是「一集的来源」——
 * 一个压缩包，或者一个直接装着图片的文件夹。压缩包在导入时原地解压。
 */
interface Unit {
  path: string
  rel: string
  kind: 'archive' | 'dir'
  /** 压缩包的大小 */
  size: number
  /** 图片数量；压缩包没解压时不知道 */
  images: number | null
  /** 压缩包是否已经解压 */
  extracted: boolean
  /** 压缩包解压后里面有多个图片文件夹（它们会各自列出来） */
  folders: number
  /** 图片实际所在的目录（相对路径），用来对上「已导入」的记录 */
  imageRel: string
}

interface Assign {
  season: number | null
  episode: number | null
}

const intOrNull = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : null)
const stem = (name: string) => name.replace(/\.[^.]+$/, '')
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + '/')
const slash = (p: string) => p.replace(/\\/g, '/')
/** 来源名去掉文件后缀当作新漫画的标题。只去掉真正的文件后缀，「Vol.1」「Dr.Stone」这类名字里的点不动 */
const FILE_EXT = new Set(['pdf', 'epub', 'mobi'])
const titleFromName = (name: string) =>
  (isArchive(name) || isImage(name) || FILE_EXT.has(extOf(name)) ? stem(name) : name).trim()

/** 从目录树里找出所有可以当作「一集」的来源 */
function collectUnits(nodes: TreeNode[]): Unit[] {
  const dirs = new Map<string, Unit>()
  const archives: Unit[] = []
  /** 每个目录下（递归）的图片总数 */
  const totals = new Map<string, number>()
  const walk = (list: TreeNode[]): number => {
    let total = 0
    for (const n of list) {
      if (n.isDir) {
        const children = n.children ?? []
        const sub = walk(children)
        totals.set(n.rel, sub)
        total += sub
        // 直接装着图片的文件夹才是候选（只装着子文件夹的那层不是）
        if (children.some((c) => !c.isDir && isImage(c.name)))
          dirs.set(n.rel, { path: n.path, rel: n.rel, kind: 'dir', size: 0, images: sub, extracted: true, folders: 0, imageRel: n.rel })
      } else if (isImage(n.name)) total++
      else if (isArchive(n.name))
        archives.push({ path: n.path, rel: n.rel, kind: 'archive', size: n.size, images: null, extracted: false, folders: 0, imageRel: stem(n.rel) })
    }
    return total
  }
  walk(nodes)

  for (const a of archives) {
    if (!totals.has(a.imageRel)) continue
    // 已经解压过：解压目录里只有一个图片文件夹时，它和压缩包是一回事，只留压缩包这一行
    a.extracted = true
    a.images = totals.get(a.imageRel)!
    const under = [...dirs.values()].filter((d) => inside(d.rel, a.imageRel))
    if (under.length <= 1) for (const d of under) dirs.delete(d.rel)
    else a.folders = under.length
  }
  return [...archives, ...dirs.values()].sort((x, y) => naturalCompare(x.rel, y.rel))
}

export default function ComicWizardPage() {
  const [params] = useSearchParams<{ type: string; ref: string; media?: string }>()
  const sourceType = () => (params.type === 'torrent' ? 'torrent' : 'dir') as 'torrent' | 'dir'
  const sourceRef = () => String(params.ref ?? '')

  const [treeRes, { refetch }] = createResource(
    () => ({ type: sourceType(), ref: sourceRef() }),
    (q) => api<SourceTree>('/sources/tree', { query: q }),
  )
  /** 读取失败时 tree() 返回 undefined，而不是把错误抛出去（抛出去会让整个页面卡在「正在读取」） */
  const tree = () => (treeRes.error ? undefined : treeRes())
  const [comics, { refetch: refetchComics }] = createResource(async () =>
    (await api<MediaListItem[]>('/media')).filter((m) => m.kind === 'comic'),
  )
  const [settings] = createResource(() => api<Settings>('/settings'))

  const [mediaId, setMediaId] = createSignal<number | null>(params.media ? Number(params.media) : null)
  const [creatingComic, setCreatingComic] = createSignal(false)
  const [linkModeOverride, setLinkMode] = createSignal<LinkMode | null>(null)
  const linkMode = () => linkModeOverride() ?? settings()?.defaultLinkMode ?? 'symlink'
  const [markImported, setMarkImported] = createSignal(true)
  /** 选中的漫画是 CBZ 形式：页面打包进 cbz，链接方式不适用 */
  const packed = () => comics()?.find((m) => m.id === mediaId())?.comicFormat === 'cbz'

  const [assign, setAssign] = createStore<Record<string, Assign>>({})
  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  let lastClicked: string | null = null

  const units = createMemo(() => collectUnits(tree()?.nodes ?? []))
  const rootRel = (abs: string) => {
    const root = slash(tree()?.root ?? '')
    const p = slash(abs)
    return p === root ? '' : p.startsWith(root + '/') ? p.slice(root.length + 1) : null
  }
  /** 每个来源之前导入到了哪里 */
  const priorOf = createMemo(() => {
    const map = new Map<string, PageImport[]>()
    for (const imp of tree()?.pageImports ?? []) {
      const rel = rootRel(imp.dir)
      if (rel === null) continue
      for (const u of units()) if (inside(rel, u.imageRel)) map.set(u.path, [...(map.get(u.path) ?? []), imp])
    }
    return map
  })

  /** 用某部漫画之前的导入记录填表 */
  function prefill(id: number | null) {
    const next: Record<string, Assign> = {}
    for (const u of units()) {
      const mine = (priorOf().get(u.path) ?? []).filter((p) => p.mediaId === id)
      const slots = new Set(mine.map((p) => `${p.season}:${p.episode}`))
      // 只有当这个来源整个对应同一集时才回填
      next[u.path] = slots.size === 1 ? { season: mine[0].season, episode: mine[0].episode } : { season: null, episode: null }
    }
    setAssign(reconcile(next))
  }

  createEffect(
    on(tree, (t) => {
      if (!t) return
      setSelected(new Set<string>())
      if (mediaId() === null && t.pageImports.length) {
        const freq = new Map<number, number>()
        for (const p of t.pageImports) freq.set(p.mediaId, (freq.get(p.mediaId) ?? 0) + p.count)
        setMediaId([...freq].sort((a, b) => b[1] - a[1])[0][0])
      }
      prefill(mediaId())
    }),
  )


  /** 下拉框按和来源名的相似度排序；没有导入记录、也没有指定媒体时，自动选中最像的那个 */
  const ranked = createMemo(() => rankedMediaOptions(tree()?.name ?? '', comics() ?? []))
  const [autoPicked, setAutoPicked] = createSignal<number | null>(null)
  let autoDone = false
  createEffect(() => {
    const t = tree()
    const list = comics()
    if (autoDone || !t || !list) return
    autoDone = true
    untrack(() => {
      if (mediaId() !== null || t.pageImports.length) return
      const top = ranked().top
      if (!top) return
      setMediaId(top.item.id)
      setAutoPicked(top.item.id)
      prefill(top.item.id)
    })
  })
  const autoHint = () => {
    const id = autoPicked()
    if (id === null || id !== mediaId()) return ''
    const o = ranked().options.find((x) => x.value === id)
    return o ? `按来源名自动选中（相似度 ${o.hint}），不对的话换一个漫画` : ''
  }

  const isAssigned = (p: string) => assign[p]?.season != null && assign[p]?.episode != null
  const assigned = createMemo(() => units().filter((u) => isAssigned(u.path)))
  const selectedUnits = createMemo(() => units().filter((u) => selected().has(u.path)))

  function changeMedia(id: number) {
    setMediaId(id)
    if (!assigned().length || confirm('用这部漫画之前的导入记录重新填表？（取消 = 保留当前填写的内容）')) prefill(id)
  }

  function toggle(u: Unit, shift: boolean) {
    const next = new Set(selected())
    const list = units()
    const from = lastClicked ? list.findIndex((x) => x.path === lastClicked) : -1
    const to = list.findIndex((x) => x.path === u.path)
    if (shift && from >= 0) for (let i = Math.min(from, to); i <= Math.max(from, to); i++) next.add(list[i].path)
    else if (next.has(u.path)) next.delete(u.path)
    else next.add(u.path)
    lastClicked = u.path
    setSelected(next)
  }

  const [season, setSeason] = createSignal('1')
  const [startEp, setStartEp] = createSignal('1')
  function applyNumbers() {
    const s = intOrNull(season())
    const start = intOrNull(startEp())
    if (s === null || start === null) return toast.err('季号和起始集号必须是非负整数')
    if (!selectedUnits().length) return toast.err('先在下面选中要导入的压缩包或文件夹')
    batch(() => selectedUnits().forEach((u, i) => setAssign(u.path, { season: s, episode: start + i })))
  }
  const clearNumbers = () => batch(() => selectedUnits().forEach((u) => setAssign(u.path, { season: null, episode: null })))

  const [extract, extracting] = useAction(async (u: Unit) => {
    await api('/comics/extract', { body: { path: u.path } })
    await refetch()
  })

  const [plan, setPlan] = createSignal<ComicPlanItem[] | null>(null)
  const [result, setResult] = createSignal<ComicImportResult | null>(null)
  function buildRequest() {
    const id = mediaId()
    if (id === null) throw new Error('请先选择要导入到哪部漫画')
    if (!assigned().length) throw new Error('还没有给任何压缩包或文件夹设置季和集')
    return {
      mediaId: id,
      linkMode: linkMode(),
      sourceType: sourceType(),
      sourceRef: sourceRef(),
      sourceName: tree()?.name ?? '',
      markImported: markImported(),
      items: assigned().map((u) => ({ path: u.path, season: assign[u.path].season!, episode: assign[u.path].episode! })),
    }
  }
  const [preview, previewing] = useAction(async () => {
    setResult(null)
    setPlan(await api<ComicPlanItem[]>('/comics/preview', { body: buildRequest() }))
  })
  const [execute, executing] = useAction(async () => {
    setResult(await api<ComicImportResult>('/comics/import', { body: buildRequest() }))
    void refetch()
  })
  const shown = createMemo(() =>
    [...(result()?.items ?? plan() ?? [])].sort(
      (a, b) => Number(b.status === 'error') - Number(a.status === 'error') || a.season - b.season || a.episode - b.episode,
    ),
  )
  const okCount = () => shown().filter((i) => i.status !== 'error').length
  const relOf = (p: string) => units().find((u) => u.path === p)?.rel ?? p

  return (
    <div class="pb-20">
      <div class="mb-3 flex items-center gap-2">
        <A href="/sources" class="btn btn-sm">
          ← 来源
        </A>
        <div class="min-w-0">
          <h1 class="truncate text-lg font-semibold">
            <span class="badge mr-2 bg-violet-100 align-middle text-violet-800">漫画</span>
            {tree()?.name ?? '漫画导入向导'}
          </h1>
          <div class="truncate font-mono text-xs text-slate-400">{tree()?.root}</div>
        </div>
      </div>

      <Show
        when={!treeRes.error}
        fallback={
          <div class="flex items-center gap-3 rounded bg-red-50 p-3 text-red-700">
            <span class="min-w-0 flex-1 break-all">读取文件列表失败：{String(treeRes.error?.message ?? treeRes.error)}</span>
            <button class="btn btn-sm shrink-0" disabled={treeRes.loading} onClick={() => void refetch()}>
              重试
            </button>
          </div>
        }
      >
        <div class="card sticky top-[49px] z-20 mb-3 shadow-sm">
          <div class="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2">
            <span class="text-xs text-slate-500">导入到</span>
            <Combobox
              class="w-80"
              placeholder="输入标题筛选，选择漫画"
              empty="没有匹配的漫画"
              value={mediaId()}
              options={ranked().options}
              onChange={changeMedia}
            />
            <button class="text-xs text-indigo-600 hover:underline" onClick={() => setCreatingComic(true)}>
              ＋ 新建漫画
            </button>
            <Show when={autoHint()}>
              <span class="text-xs text-amber-600">{autoHint()}</span>
            </Show>
            <span class="ml-auto text-xs text-slate-400">
              一个压缩包或一个图片文件夹 = 一集。压缩包会在原地解压，图片按文件名自然排序后编号，再链接进媒体库或打包成 cbz。
            </span>
          </div>
          <div class="flex flex-wrap items-center gap-2 px-3 py-2">
            <span class="badge bg-indigo-100 text-indigo-800">已选 {selectedUnits().length}</span>
            <span class="text-xs text-slate-500">季</span>
            <input class="input input-sm w-14" value={season()} onInput={(e) => setSeason(e.currentTarget.value)} />
            <span class="text-xs text-slate-500">起始集</span>
            <input class="input input-sm w-14" value={startEp()} onInput={(e) => setStartEp(e.currentTarget.value)} />
            <button class="btn btn-sm btn-primary" onClick={applyNumbers} title="按列表顺序，第一个 = 起始集，之后 +1">
              依次编号
            </button>
            <button class="btn btn-sm" onClick={clearNumbers}>
              不导入
            </button>
            <span class="ml-auto" />
            <button class="btn btn-sm" onClick={() => setSelected(new Set(units().map((u) => u.path)))}>
              全选
            </button>
            <button class="btn btn-sm" onClick={() => setSelected(new Set<string>())}>
              取消选择
            </button>
          </div>
        </div>

        <Show when={tree()} fallback={<p class="py-10 text-center text-slate-400">正在读取文件列表…</p>}>
          <div class="card overflow-hidden">
            <div class="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-400">
              <span class="flex-1 pl-7">来源（点击选择，Shift + 点击连选）</span>
              <span class="w-40 text-right">内容</span>
              <span class="w-14 text-center">季</span>
              <span class="w-14 text-center">集</span>
            </div>
            <For each={units()} fallback={<p class="py-10 text-center text-slate-400">这里没有压缩包，也没有装着图片的文件夹。</p>}>
              {(u) => (
                <div
                  class="flex cursor-pointer items-center gap-2 border-b border-slate-100 px-2 py-1 hover:bg-slate-50"
                  classList={{ 'bg-indigo-50 hover:bg-indigo-100': selected().has(u.path) }}
                  onClick={(e) => toggle(u, e.shiftKey)}
                >
                  <input type="checkbox" class="pointer-events-none" checked={selected().has(u.path)} />
                  <span
                    class="badge w-12 justify-center"
                    classList={{ 'bg-amber-100 text-amber-800': u.kind === 'archive', 'bg-sky-100 text-sky-800': u.kind === 'dir' }}
                  >
                    {u.kind === 'archive' ? '压缩包' : '文件夹'}
                  </span>
                  <div class="min-w-0 flex-1 py-0.5">
                    <div class="truncate select-none" title={u.rel}>
                      {u.rel}
                    </div>
                    <For each={priorOf().get(u.path)}>
                      {(p) => (
                        <div class="truncate text-xs text-emerald-700">
                          已导入 → {p.mediaTitle} S{pad2(p.season)}E{String(p.episode).padStart(3, '0')}（{p.count} 页）
                        </div>
                      )}
                    </For>
                  </div>
                  <span class="flex w-40 items-center justify-end gap-2 text-xs text-slate-400">
                    <Show when={u.kind === 'archive' && !u.extracted}>
                      <button
                        class="btn btn-sm"
                        disabled={extracting()}
                        title="现在就解压，看看里面的结构。一个压缩包里有多集时需要先解压，再给里面的文件夹分别编号"
                        onClick={(e) => {
                          e.stopPropagation()
                          void extract(u)
                        }}
                      >
                        解压
                      </button>
                    </Show>
                    <span>
                      {u.images !== null ? `${u.images} 张图` : formatSize(u.size)}
                      {u.folders ? `，${u.folders} 个文件夹` : ''}
                    </span>
                  </span>
                  <input
                    class="input input-sm w-14 text-center"
                    classList={{ 'border-emerald-400 bg-emerald-50': isAssigned(u.path) }}
                    placeholder="季"
                    value={assign[u.path]?.season ?? ''}
                    onClick={(e) => e.stopPropagation()}
                    onInput={(e) => setAssign(u.path, 'season', intOrNull(e.currentTarget.value))}
                  />
                  <input
                    class="input input-sm w-14 text-center"
                    classList={{ 'border-emerald-400 bg-emerald-50': isAssigned(u.path) }}
                    placeholder="集"
                    value={assign[u.path]?.episode ?? ''}
                    onClick={(e) => e.stopPropagation()}
                    onInput={(e) => setAssign(u.path, 'episode', intOrNull(e.currentTarget.value))}
                  />
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>

      <div class="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white">
        <div class="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 py-2">
          <span>
            将导入 <b>{assigned().length}</b> 集
          </span>
          <Show
            when={!packed()}
            fallback={<span class="badge bg-violet-100 text-violet-800">CBZ：每集打包成一个 .cbz（拷贝，不是链接）</span>}
          >
            <select class="input w-44" value={linkMode()} onChange={(e) => setLinkMode(e.currentTarget.value as LinkMode)}>
              <option value="symlink">符号链接（symlink）</option>
              <option value="hardlink">硬链接（hardlink）</option>
              <option value="copy">拷贝（copy）</option>
            </select>
          </Show>
          <Show when={sourceType() === 'torrent'}>
            <label class="flex items-center gap-1">
              <input type="checkbox" checked={markImported()} onChange={(e) => setMarkImported(e.currentTarget.checked)} />
              完成后标为已导入
            </label>
          </Show>
          <button class="btn btn-primary ml-auto" disabled={previewing()} onClick={() => void preview()}>
            预览并导入…
          </button>
        </div>
      </div>

      <Show when={plan()}>
        <Modal
          wide
          title={result() ? '导入结果' : '确认导入'}
          onClose={() => setPlan(null)}
          footer={
            <Show
              when={result()}
              fallback={
                <>
                  <span class="mr-auto text-xs text-slate-500">
                    {okCount()} 集可以导入
                    {shown().length - okCount() ? `，${shown().length - okCount()} 集有问题会被跳过` : ''}
                    。方式：{packed() ? '打包成 cbz' : linkMode()}
                  </span>
                  <button class="btn" onClick={() => setPlan(null)}>
                    返回修改
                  </button>
                  <button class="btn btn-primary" disabled={executing() || !okCount()} onClick={() => void execute()}>
                    {executing() ? '导入中（解压、打包可能要一会儿）…' : `执行导入（${okCount()} 集）`}
                  </button>
                </>
              }
            >
              <span class="mr-auto text-xs text-slate-500">
                成功 {result()!.items.filter((i) => i.done).length} / {result()!.items.length}
              </span>
              <A class="btn" href="/sources">
                回到来源
              </A>
              <A class="btn btn-primary" href={`/media/${mediaId()}`}>
                查看漫画
              </A>
            </Show>
          }
        >
          <Show when={result()?.warnings.length}>
            <div class="mb-3 rounded bg-amber-50 p-2 text-xs whitespace-pre-wrap text-amber-800">{result()!.warnings.join('\n')}</div>
          </Show>
          <table class="w-full text-xs">
            <thead class="text-left text-slate-400">
              <tr>
                <th class="w-24 py-1 font-normal">集</th>
                <th class="font-normal">来源 → 媒体库里的位置</th>
                <th class="w-20 font-normal">页数</th>
                <th class="w-56 font-normal">状态</th>
              </tr>
            </thead>
            <tbody>
              <For each={shown()}>
                {(it) => (
                  <tr class="border-t border-slate-100 align-top">
                    <td class="py-1.5 font-mono">
                      S{pad2(it.season)}E{String(it.episode).padStart(3, '0')}
                    </td>
                    <td class="py-1.5 pr-2">
                      <div class="break-all text-slate-500">{relOf(it.path)}</div>
                      <div class="font-mono break-all">→ {it.target}</div>
                    </td>
                    <td class="py-1.5">{it.pages ?? '解压后确定'}</td>
                    <td class="py-1.5">
                      <span
                        class="badge"
                        classList={{
                          'bg-emerald-100 text-emerald-800': it.status === 'ok',
                          'bg-amber-100 text-amber-800': it.status === 'replace',
                          'bg-red-100 text-red-800': it.status === 'error',
                        }}
                      >
                        {it.status === 'error' ? '跳过' : result() ? '完成' : it.status === 'replace' ? '替换' : '新建'}
                      </span>
                      <Show when={!result() && it.extract && it.status !== 'error'}>
                        <span class="badge ml-1 bg-slate-100 text-slate-600">先解压</span>
                      </Show>
                      <div class="mt-0.5 break-all text-slate-500">{it.message}</div>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Modal>
      </Show>

      <Show when={creatingComic()}>
        <NewMediaModal
          comic
          initialTitle={titleFromName(tree()?.name ?? '')}
          onClose={() => setCreatingComic(false)}
          onCreated={async (d) => {
            // 留在向导里：新漫画还没有导入记录，直接选中它，已经填好的季 / 集保留
            await refetchComics()
            setMediaId(d.media.id)
            setCreatingComic(false)
            toast.ok(`已创建「${d.media.title}」`)
          }}
        />
      </Show>
    </div>
  )
}
