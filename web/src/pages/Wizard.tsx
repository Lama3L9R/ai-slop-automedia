import {
  formatSize,
  guessSubtitleSuffix,
  naturalCompare,
  pad2,
  type AiSuggestResult,
  type ExistingMode,
  type ImportPlan,
  type ImportItem,
  type ImportResult,
  type LinkMode,
  type MediaListItem,
  type Settings,
  type SourceTree,
  type TreeNode,
} from '@automedia/shared'
import { A, useSearchParams } from '@solidjs/router'
import { For, Show, batch, createEffect, createMemo, createResource, createSignal, on } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import { api } from '../api'
import { Combobox, Modal, baseName, toast, useAction } from '../ui'

interface Assign {
  season: number | null
  episode: number | null
  /** 字幕 / 外挂音轨的语言标签 */
  suffix: string
}

const KIND_LABEL = { video: '视频', subtitle: '字幕', audio: '音轨' } as const
const intOrNull = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : null)
const depthOf = (n: TreeNode) => n.rel.split('/').length - 1

/** 深度优先展开成文件列表（即界面上从上到下的顺序） */
function flatten(nodes: TreeNode[], out: TreeNode[] = []): TreeNode[] {
  for (const n of nodes) {
    if (n.isDir) flatten(n.children ?? [], out)
    else out.push(n)
  }
  return out
}

export default function WizardPage() {
  const [params] = useSearchParams<{ type: string; ref: string; media?: string }>()
  const sourceType = () => (params.type === 'torrent' ? 'torrent' : 'dir') as 'torrent' | 'dir'
  const sourceRef = () => String(params.ref ?? '')

  const [tree, { refetch }] = createResource(
    () => ({ type: sourceType(), ref: sourceRef() }),
    (q) => api<SourceTree>('/sources/tree', { query: q }),
  )
  const [mediaList] = createResource(async () =>
    (await api<MediaListItem[]>('/media'))
      .filter((m) => m.kind !== 'comic')
      .sort((a, b) => naturalCompare(a.title, b.title)),
  )
  const [settings] = createResource(() => api<Settings>('/settings'))

  const [mediaId, setMediaId] = createSignal<number | null>(params.media ? Number(params.media) : null)
  const [linkModeOverride, setLinkMode] = createSignal<LinkMode | null>(null)
  const linkMode = () => linkModeOverride() ?? settings()?.defaultLinkMode ?? 'symlink'

  const [assign, setAssign] = createStore<Record<string, Assign>>({})
  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set())
  const [showOther, setShowOther] = createSignal(false)
  let lastClicked: string | null = null

  const allFiles = createMemo(() => flatten(tree()?.nodes ?? []))
  const importable = createMemo(() => allFiles().filter((n) => n.kind))
  /** 目录 rel → 它下面（递归）所有可导入的文件 */
  const dirFiles = createMemo(() => {
    const map = new Map<string, TreeNode[]>()
    const walk = (nodes: TreeNode[]): TreeNode[] => {
      const mine: TreeNode[] = []
      for (const n of nodes) {
        if (n.isDir) {
          const sub = walk(n.children ?? [])
          map.set(n.rel, sub)
          mine.push(...sub)
        } else if (n.kind) mine.push(n)
      }
      return mine
    }
    walk(tree()?.nodes ?? [])
    return map
  })
  const priorLinks = createMemo(() => {
    const map = new Map<string, SourceTree['links']>()
    for (const l of tree()?.links ?? []) map.set(l.sourcePath, [...(map.get(l.sourcePath) ?? []), l])
    return map
  })

  /** 用某个 Media 之前的导入记录填表（重新导入时就是上次的结果） */
  function prefill(id: number | null) {
    const next: Record<string, Assign> = {}
    for (const n of importable())
      next[n.path] = { season: null, episode: null, suffix: n.kind === 'video' ? '' : guessSubtitleSuffix(n.name) }
    if (id !== null)
      for (const l of tree()?.links ?? [])
        if (l.mediaId === id && next[l.sourcePath])
          next[l.sourcePath] = { season: l.season, episode: l.episode, suffix: l.suffix }
    setAssign(reconcile(next))
  }

  createEffect(
    on(tree, (t) => {
      if (!t) return
      // 没有可导入文件的目录（Scans、CDs…）默认折叠
      setCollapsed(new Set([...dirFiles()].filter(([, files]) => !files.length).map(([rel]) => rel)))
      setSelected(new Set<string>())
      if (mediaId() === null && t.links.length) {
        const freq = new Map<number, number>()
        for (const l of t.links) freq.set(l.mediaId, (freq.get(l.mediaId) ?? 0) + 1)
        setMediaId([...freq].sort((a, b) => b[1] - a[1])[0][0])
      }
      prefill(mediaId())
    }),
  )

  const isAssigned = (p: string) => assign[p]?.season != null && assign[p]?.episode != null
  const assignedFiles = createMemo(() => importable().filter((n) => isAssigned(n.path)))
  const hasPrior = createMemo(() => (tree()?.links ?? []).some((l) => l.mediaId === mediaId()))

  function changeMedia(id: number | null) {
    setMediaId(id)
    // 还没动手填过才用历史记录覆盖，避免冲掉刚填好的编号
    if (!assignedFiles().length || confirm('用这个媒体之前的导入记录重新填表？（取消 = 保留当前填写的内容）')) prefill(id)
  }

  // ───────────── 可见行 ─────────────
  const rows = createMemo(() => {
    const out: TreeNode[] = []
    const closed = collapsed()
    const other = showOther()
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.isDir) {
          if (!other && !dirFiles().get(n.rel)?.length) continue
          out.push(n)
          if (!closed.has(n.rel)) walk(n.children ?? [])
        } else if (n.kind || other) out.push(n)
      }
    }
    walk(tree()?.nodes ?? [])
    return out
  })

  // ───────────── 选择 ─────────────
  function toggleFile(n: TreeNode, shift: boolean) {
    if (!n.kind) return
    const next = new Set(selected())
    const visible = rows().filter((r) => r.kind)
    const from = lastClicked ? visible.findIndex((r) => r.path === lastClicked) : -1
    const to = visible.findIndex((r) => r.path === n.path)
    if (shift && from >= 0 && to >= 0) {
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) next.add(visible[i].path)
    } else if (next.has(n.path)) next.delete(n.path)
    else next.add(n.path)
    lastClicked = n.path
    setSelected(next)
  }
  function toggleDir(n: TreeNode) {
    const files = dirFiles().get(n.rel) ?? []
    const next = new Set(selected())
    const all = files.length > 0 && files.every((f) => next.has(f.path))
    for (const f of files) all ? next.delete(f.path) : next.add(f.path)
    setSelected(next)
  }
  const selectKind = (kind: 'video' | 'subtitle') =>
    setSelected(new Set(importable().filter((n) => n.kind === kind).map((n) => n.path)))
  const selectedFiles = createMemo(() => importable().filter((n) => selected().has(n.path)))

  // ───────────── 批量设置 ─────────────
  const [season, setSeason] = createSignal('1')
  const [startEp, setStartEp] = createSignal('1')
  const [bulkSuffix, setBulkSuffix] = createSignal('')

  /**
   * 给选中的文件编号：按界面上的顺序（自然排序），第一个 = 起始集，之后依次 +1。
   * 视频、各语言的字幕各自独立计数，所以把一季的视频和简繁字幕一起选中也能一次编对。
   */
  function applyNumbers() {
    const s = intOrNull(season())
    const start = intOrNull(startEp())
    if (s === null || start === null) return toast.err('季号和起始集号必须是非负整数')
    if (!selectedFiles().length) return toast.err('先在下面选中文件')
    const counters = new Map<string, number>()
    batch(() => {
      for (const n of selectedFiles()) {
        const group = n.kind === 'video' ? 'video' : `${n.kind}|${assign[n.path]?.suffix ?? ''}`
        const ep = counters.get(group) ?? start
        counters.set(group, ep + 1)
        setAssign(n.path, { season: s, episode: ep })
      }
    })
  }
  function clearNumbers() {
    batch(() => {
      for (const n of selectedFiles()) setAssign(n.path, { season: null, episode: null })
    })
  }
  function applySuffix() {
    const v = bulkSuffix().trim()
    if (!/^[\w.\-&+]*$/.test(v)) return toast.err('语言标签只能包含字母、数字和 . - _ & +')
    batch(() => {
      for (const n of selectedFiles()) if (n.kind !== 'video') setAssign(n.path, 'suffix', v)
    })
  }

  // ───────────── AI ─────────────
  const [promptPreview, setPromptPreview] = createSignal<AiSuggestResult | null>(null)
  const [runAi, aiBusy] = useAction(async (task: 'video' | 'subtitle', dryRun: boolean) => {
    const id = mediaId()
    if (id === null) throw new Error('请先选择媒体，AI 需要它的剧集信息')
    const want = (n: TreeNode) => n.kind === task
    const picked = selectedFiles().filter(want)
    const files = picked.length ? picked : importable().filter(want)
    if (!files.length) throw new Error(`没有${KIND_LABEL[task]}文件可以匹配`)
    const res = await api<AiSuggestResult>('/ai/suggest', {
      body: { mediaId: id, task, dryRun, files: files.map((f, i) => ({ index: i, rel: f.rel, size: f.size })) },
    })
    if (dryRun) return void setPromptPreview(res)
    batch(() => {
      for (const f of files) setAssign(f.path, { season: null, episode: null })
      for (const it of res.items) {
        const f = files[it.index]
        if (!f) continue
        setAssign(f.path, { season: it.season, episode: it.episode })
        if (task === 'subtitle' && it.suffix) setAssign(f.path, 'suffix', it.suffix)
      }
    })
    toast.ok(`AI 匹配了 ${res.items.length} / ${files.length} 个${KIND_LABEL[task]}文件，其余视为不导入。请检查后再执行。`)
  })

  // ───────────── 预览 / 执行 ─────────────
  const [replaceOverride, setReplace] = createSignal<boolean | null>(null)
  const replaceSource = () => replaceOverride() ?? hasPrior()
  const [markImported, setMarkImported] = createSignal(true)
  const [existing, setExisting] = createSignal<ExistingMode>('safe')
  const [plan, setPlan] = createSignal<ImportPlan | null>(null)
  const [result, setResult] = createSignal<ImportResult | null>(null)

  function buildRequest() {
    const id = mediaId()
    if (id === null) throw new Error('请先选择要导入到哪个媒体')
    const items: ImportItem[] = assignedFiles().map((n) => ({
      path: n.path,
      season: assign[n.path].season!,
      episode: assign[n.path].episode!,
      kind: n.kind!,
      suffix: n.kind === 'video' ? '' : assign[n.path].suffix.trim(),
    }))
    if (!items.length) throw new Error('还没有给任何文件设置季和集')
    return {
      mediaId: id,
      linkMode: linkMode(),
      sourceType: sourceType(),
      sourceRef: sourceRef(),
      sourceName: tree()?.name ?? '',
      items,
      replaceSource: replaceSource(),
      markImported: markImported(),
      existing: existing(),
    }
  }
  const [preview, previewing] = useAction(async () => {
    setResult(null)
    setPlan(await api<ImportPlan>('/import/preview', { body: buildRequest() }))
  })
  const [execute, executing] = useAction(async () => {
    const res = await api<ImportResult>('/import/execute', { body: buildRequest() })
    setResult(res)
    setReplace(null)
    void refetch()
  })
  const relOf = (p: string) => allFiles().find((n) => n.path === p)?.rel ?? baseName(p)
  /** 预览 / 结果按季集排序，有问题的排最前 */
  const shown = createMemo(() =>
    [...(result()?.items ?? plan()?.items ?? [])].sort(
      (a, b) =>
        Number(b.status === 'error') - Number(a.status === 'error') ||
        a.season - b.season ||
        a.episode - b.episode ||
        naturalCompare(a.target, b.target),
    ),
  )
  const okCount = () => shown().filter((i) => i.status !== 'error').length

  const counts = createMemo(() => {
    const c = { video: 0, subtitle: 0, audio: 0 }
    for (const n of assignedFiles()) c[n.kind!]++
    return c
  })

  return (
    <div class="pb-20">
      <div class="mb-3 flex items-center gap-2">
        <A href="/sources" class="btn btn-sm">
          ← 来源
        </A>
        <div class="min-w-0">
          <h1 class="truncate text-lg font-semibold">{tree()?.name ?? '导入向导'}</h1>
          <div class="truncate font-mono text-xs text-slate-400">{tree()?.root}</div>
        </div>
      </div>

      <Show when={!tree.error} fallback={<p class="rounded bg-red-50 p-3 text-red-700">{String(tree.error?.message ?? tree.error)}</p>}>
        <div class="card sticky top-[49px] z-20 mb-3 shadow-sm">
          <div class="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2">
            <span class="text-xs text-slate-500">导入到</span>
            <Combobox
              class="w-80"
              placeholder="输入标题筛选，选择媒体"
              empty="没有匹配的媒体"
              value={mediaId()}
              options={(mediaList() ?? []).map((m) => ({ value: m.id, label: `${m.title}${m.year ? ` (${m.year})` : ''}` }))}
              onChange={changeMedia}
            />
            <A href="/" target="_blank" class="text-xs text-indigo-600 hover:underline">
              新建媒体 ↗
            </A>
            <span class="ml-auto text-xs text-slate-500">AI</span>
            <button class="btn btn-sm" disabled={aiBusy()} onClick={() => void runAi('video', false)}>
              {aiBusy() ? '匹配中…' : '自动匹配视频'}
            </button>
            <button class="btn btn-sm" disabled={aiBusy()} onClick={() => void runAi('subtitle', false)}>
              自动匹配字幕
            </button>
            <button class="btn btn-sm" disabled={aiBusy()} onClick={() => void runAi('video', true)} title="只渲染提示词，不调用模型">
              预览提示词
            </button>
          </div>
          <div class="flex flex-wrap items-center gap-2 px-3 py-2">
            <span class="badge bg-indigo-100 text-indigo-800">已选 {selectedFiles().length}</span>
            <span class="text-xs text-slate-500">季</span>
            <input class="input input-sm w-14" value={season()} onInput={(e) => setSeason(e.currentTarget.value)} />
            <span class="text-xs text-slate-500">起始集</span>
            <input class="input input-sm w-14" value={startEp()} onInput={(e) => setStartEp(e.currentTarget.value)} />
            <button class="btn btn-sm btn-primary" onClick={applyNumbers} title="按列表顺序，第一个 = 起始集，之后 +1。视频和各语言字幕分别计数。">
              依次编号
            </button>
            <button class="btn btn-sm" onClick={clearNumbers}>
              不导入
            </button>
            <span class="ml-2 text-xs text-slate-500">语言标签</span>
            <input class="input input-sm w-20" placeholder="chs" value={bulkSuffix()} onInput={(e) => setBulkSuffix(e.currentTarget.value)} />
            <button class="btn btn-sm" onClick={applySuffix}>
              设置
            </button>
            <span class="ml-auto" />
            <button class="btn btn-sm" onClick={() => selectKind('video')}>
              选中全部视频
            </button>
            <button class="btn btn-sm" onClick={() => selectKind('subtitle')}>
              选中全部字幕
            </button>
            <button class="btn btn-sm" onClick={() => setSelected(new Set<string>())}>
              取消选择
            </button>
            <label class="flex items-center gap-1 text-xs text-slate-500">
              <input type="checkbox" checked={showOther()} onChange={(e) => setShowOther(e.currentTarget.checked)} />
              显示其他文件
            </label>
          </div>
        </div>

        <Show when={tree()} fallback={<p class="py-10 text-center text-slate-400">正在读取文件列表…</p>}>
          <div class="card overflow-hidden">
            <div class="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-400">
              <span class="flex-1 pl-7">文件（点击选择，Shift + 点击连选，点文件夹的勾选框选中整个文件夹）</span>
              <span class="w-20 text-right">大小</span>
              <span class="w-14 text-center">季</span>
              <span class="w-14 text-center">集</span>
              <span class="w-20 text-center">语言标签</span>
            </div>
            <For each={rows()} fallback={<p class="py-10 text-center text-slate-400">这里没有可导入的视频或字幕文件。</p>}>
              {(n) => (
                <Show
                  when={!n.isDir}
                  fallback={(() => {
                    const files = () => dirFiles().get(n.rel) ?? []
                    const picked = () => files().filter((f) => selected().has(f.path)).length
                    const assigned = () => files().filter((f) => isAssigned(f.path)).length
                    return (
                      <div
                        class="flex cursor-pointer items-center gap-2 border-b border-slate-100 bg-slate-50/60 px-2 py-1 hover:bg-slate-100"
                        style={{ 'padding-left': `${depthOf(n) * 20 + 8}px` }}
                        onClick={() =>
                          setCollapsed((c) => {
                            const next = new Set(c)
                            next.has(n.rel) ? next.delete(n.rel) : next.add(n.rel)
                            return next
                          })
                        }
                      >
                        <input
                          type="checkbox"
                          disabled={!files().length}
                          checked={files().length > 0 && picked() === files().length}
                          ref={(el) => createEffect(() => (el.indeterminate = picked() > 0 && picked() < files().length))}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => toggleDir(n)}
                        />
                        <span class="w-3 text-slate-400">{collapsed().has(n.rel) ? '▸' : '▾'}</span>
                        <span class="min-w-0 flex-1 truncate font-medium">📁 {n.name}</span>
                        <span class="text-xs text-slate-400">
                          {files().length} 个文件{assigned() ? `，将导入 ${assigned()}` : ''}
                        </span>
                      </div>
                    )
                  })()}
                >
                  <div
                    class="flex items-center gap-2 border-b border-slate-100 px-2 py-0.5"
                    classList={{
                      'cursor-pointer hover:bg-slate-50': !!n.kind,
                      'bg-indigo-50 hover:bg-indigo-100': selected().has(n.path),
                      'text-slate-400': !n.kind,
                    }}
                    style={{ 'padding-left': `${depthOf(n) * 20 + 8}px` }}
                    onClick={(e) => toggleFile(n, e.shiftKey)}
                  >
                    <input type="checkbox" class="pointer-events-none" disabled={!n.kind} checked={selected().has(n.path)} />
                    <span
                      class="badge w-9 justify-center"
                      classList={{
                        'bg-emerald-100 text-emerald-800': n.kind === 'video',
                        'bg-sky-100 text-sky-800': n.kind === 'subtitle',
                        'bg-violet-100 text-violet-800': n.kind === 'audio',
                        'bg-slate-100': !n.kind,
                      }}
                    >
                      {n.kind ? KIND_LABEL[n.kind] : '其他'}
                    </span>
                    <div class="min-w-0 flex-1 py-0.5">
                      <div class="truncate select-none" title={n.rel}>
                        {n.name}
                      </div>
                      <For each={priorLinks().get(n.path)}>
                        {(l) => (
                          <div class="truncate text-xs text-emerald-700">
                            已导入 → {l.mediaTitle} S{pad2(l.season)}E{pad2(l.episode)}
                            {l.suffix ? ` [${l.suffix}]` : ''}
                          </div>
                        )}
                      </For>
                    </div>
                    <span class="w-20 text-right text-xs text-slate-400">{formatSize(n.size)}</span>
                    <Show when={n.kind} fallback={<span class="w-[12.5rem]" />}>
                      <input
                        class="input input-sm w-14 text-center"
                        classList={{ 'border-emerald-400 bg-emerald-50': isAssigned(n.path) }}
                        placeholder="季"
                        value={assign[n.path]?.season ?? ''}
                        onClick={(e) => e.stopPropagation()}
                        onInput={(e) => setAssign(n.path, 'season', intOrNull(e.currentTarget.value))}
                      />
                      <input
                        class="input input-sm w-14 text-center"
                        classList={{ 'border-emerald-400 bg-emerald-50': isAssigned(n.path) }}
                        placeholder="集"
                        value={assign[n.path]?.episode ?? ''}
                        onClick={(e) => e.stopPropagation()}
                        onInput={(e) => setAssign(n.path, 'episode', intOrNull(e.currentTarget.value))}
                      />
                      <Show when={n.kind !== 'video'} fallback={<span class="w-20" />}>
                        <input
                          class="input input-sm w-20 text-center"
                          placeholder="无"
                          value={assign[n.path]?.suffix ?? ''}
                          onClick={(e) => e.stopPropagation()}
                          onInput={(e) => setAssign(n.path, 'suffix', e.currentTarget.value)}
                        />
                      </Show>
                    </Show>
                  </div>
                </Show>
              )}
            </For>
          </div>
        </Show>
      </Show>

      <div class="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white">
        <div class="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 py-2">
          <span>
            将导入 <b>{assignedFiles().length}</b> 个文件
            <span class="text-xs text-slate-400">
              （视频 {counts().video}，字幕 {counts().subtitle}
              {counts().audio ? `，音轨 ${counts().audio}` : ''}）
            </span>
          </span>
          <select class="input w-44" value={linkMode()} onChange={(e) => setLinkMode(e.currentTarget.value as LinkMode)}>
            <option value="symlink">符号链接（symlink）</option>
            <option value="hardlink">硬链接（hardlink）</option>
            <option value="copy">拷贝（copy）</option>
          </select>
          <Show when={hasPrior()}>
            <label class="flex items-center gap-1" title="先移除这个来源之前导入到该媒体的全部链接，再按现在的表重新创建。不勾选则只新增 / 替换同名文件。">
              <input type="checkbox" checked={replaceSource()} onChange={(e) => setReplace(e.currentTarget.checked)} />
              重新导入（先清掉此来源之前的链接）
            </label>
          </Show>
          <label class="flex items-center gap-1" title="媒体库里已经有这一集的文件、且不是本工具创建的（比如 Sonarr 导入的）时怎么处理">
            <span class="text-xs text-slate-500">已有文件</span>
            <select class="input w-56" value={existing()} onChange={(e) => setExisting(e.currentTarget.value as ExistingMode)}>
              <option value="safe">替换（仅链接或同大小的副本）</option>
              <option value="force">强制替换</option>
              <option value="skip">保留，不导入这一集</option>
            </select>
          </label>
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
                    {okCount()} 个可以导入
                    {shown().length - okCount() ? `，${shown().length - okCount()} 个有问题会被跳过` : ''}
                    。方式：{linkMode()}
                  </span>
                  <button class="btn" onClick={() => setPlan(null)}>
                    返回修改
                  </button>
                  <button class="btn btn-primary" disabled={executing() || !okCount()} onClick={() => void execute()}>
                    {executing() ? '导入中…' : `执行导入（${okCount()}）`}
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
                查看媒体
              </A>
            </Show>
          }
        >
          <Show when={!result() && plan()?.adopt}>
            <div class="mb-3 rounded bg-sky-50 p-2 text-xs text-sky-800">
              媒体库里已经有这部作品的目录，导入时会接管它并改名（里面的其他文件原样保留）：
              <div class="mt-1 font-mono break-all">{plan()!.adopt!.from}</div>
              <div class="font-mono break-all">→ {plan()!.adopt!.to}</div>
            </div>
          </Show>
          <Show when={result()?.warnings.length}>
            <div class="mb-3 rounded bg-amber-50 p-2 text-xs whitespace-pre-wrap text-amber-800">{result()!.warnings.join('\n')}</div>
          </Show>
          <table class="w-full text-xs">
            <thead class="text-left text-slate-400">
              <tr>
                <th class="w-20 py-1 font-normal">集</th>
                <th class="font-normal">源文件 → 媒体库</th>
                <th class="w-56 font-normal">状态</th>
              </tr>
            </thead>
            <tbody>
              <For each={shown()}>
                {(it) => (
                  <tr class="border-t border-slate-100 align-top">
                    <td class="py-1.5 font-mono">
                      S{pad2(it.season)}E{pad2(it.episode)}
                    </td>
                    <td class="py-1.5 pr-2">
                      <div class="break-all text-slate-500">{relOf(it.path)}</div>
                      <div class="font-mono break-all">→ {it.target}</div>
                    </td>
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
                      <div class="mt-0.5 break-all whitespace-pre-wrap text-slate-500">{it.message}</div>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Modal>
      </Show>

      <Show when={promptPreview()}>
        <Modal wide title="提示词预览（未调用模型）" onClose={() => setPromptPreview(null)}>
          <p class="label">系统消息（固定）</p>
          <pre class="mb-3 rounded bg-slate-100 p-2 text-xs whitespace-pre-wrap">{promptPreview()!.system}</pre>
          <p class="label">用户消息（由设置里的模版生成）</p>
          <pre class="rounded bg-slate-100 p-2 text-xs whitespace-pre-wrap">{promptPreview()!.prompt}</pre>
        </Modal>
      </Show>
    </div>
  )
}
