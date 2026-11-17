import { naturalCompare, type Link } from '@automedia/shared'
import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup } from 'solid-js'
import { api, apiBlob } from '../api'
import { uploadCover } from '../cover'
import { Modal, baseName, toast, useAction } from '../ui'

/**
 * 一集漫画的页面列表：左边是顺序，右边是当前选中那一页的预览。
 * 调整顺序 / 移除页面只改本地列表，点「保存」后服务端把媒体库里的文件按新顺序重新编号。
 */
export default function ComicPages(props: {
  mediaId: number
  season: number
  episode: number
  title: string
  onClose: () => void
  onSaved: () => void
  /** 把某一页设成了这部漫画的封面 */
  onCover?: (posterUrl: string) => void
}) {
  const [original, setOriginal] = createSignal<Link[]>([])
  const [pages, setPages] = createSignal<Link[]>([])
  const [current, setCurrent] = createSignal(0)
  const [dragFrom, setDragFrom] = createSignal<number | null>(null)
  let listEl: HTMLDivElement | undefined

  const query = { season: props.season, episode: props.episode }
  const [loaded] = createResource(async () => {
    const list = await api<Link[]>(`/media/${props.mediaId}/pages`, { query })
    setOriginal(list)
    setPages(list)
    return true
  })

  const dirty = createMemo(() => pages().length !== original().length || pages().some((p, i) => p.id !== original()[i]?.id))
  const removed = () => original().length - pages().length

  // 预览：一次只取当前这一页，换页时释放上一张
  const [previewUrl, setPreviewUrl] = createSignal('')
  let seq = 0
  createEffect(
    on(
      () => pages()[current()]?.id,
      (id) => {
        const mine = ++seq
        if (id === undefined) return setPreviewUrl('')
        apiBlob(`/links/${id}/file`).then(
          (blob) => {
            if (mine !== seq) return
            const url = URL.createObjectURL(blob)
            setPreviewUrl((old) => (old && URL.revokeObjectURL(old), url))
          },
          () => mine === seq && setPreviewUrl(''),
        )
      },
    ),
  )
  onCleanup(() => previewUrl() && URL.revokeObjectURL(previewUrl()))

  const select = (i: number) => {
    setCurrent(Math.max(0, Math.min(pages().length - 1, i)))
    queueMicrotask(() => listEl?.children[current()]?.scrollIntoView({ block: 'nearest' }))
  }
  /** 把第 from 页挪到第 to 位，选中项跟着它走 */
  function move(from: number, to: number) {
    if (to < 0 || to >= pages().length || from === to) return
    const next = [...pages()]
    const [p] = next.splice(from, 1)
    next.splice(to, 0, p)
    setPages(next)
    select(to)
  }
  function remove(i: number) {
    setPages(pages().filter((_, j) => j !== i))
    select(Math.min(i, pages().length - 1))
  }

  function onKey(e: KeyboardEvent) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    const d = e.key === 'ArrowUp' ? -1 : 1
    if (e.altKey) move(current(), current() + d)
    else select(current() + d)
  }

  const [save, saving] = useAction(async () => {
    const list = await api<Link[]>(`/media/${props.mediaId}/pages`, {
      method: 'PUT',
      body: { ...query, order: pages().map((p) => p.id) },
    })
    setOriginal(list)
    setPages(list)
    select(current())
    toast.ok('顺序已保存，媒体库已更新')
    props.onSaved()
  })
  const [setAsCover, covering] = useAction(async () => {
    const p = pages()[current()]
    if (!p) return
    const url = await uploadCover(props.mediaId, await apiBlob(`/links/${p.id}/file`))
    toast.ok('已把这一页设为漫画封面')
    props.onCover?.(url)
  })
  const close = () => {
    if (!dirty() || confirm('页面顺序还没保存，确定关闭？')) props.onClose()
  }

  return (
    <Modal
      wide
      title={`页面顺序 · ${props.title}`}
      onClose={close}
      footer={
        <>
          <span class="mr-auto text-xs text-slate-500">
            共 {pages().length} 页{removed() ? `，将移除 ${removed()} 页` : ''}。第一页是这一集的封面。 ↑↓ 翻页，Alt + ↑↓ 移动当前页，也可以拖动。
          </span>
          <button class="btn" disabled={covering() || !pages().length} onClick={() => void setAsCover()} title="把右边正在预览的这一页设为整部漫画的封面">
            {covering() ? '处理中…' : '设为漫画封面'}
          </button>
          <button class="btn" onClick={() => (setPages([...pages()].sort((a, b) => naturalCompare(a.sourcePath, b.sourcePath))), select(0))}>
            按文件名排序
          </button>
          <button class="btn" disabled={!dirty()} onClick={() => (setPages(original()), select(0))}>
            还原
          </button>
          <button class="btn btn-primary" disabled={!dirty() || saving()} onClick={() => void save()}>
            {saving() ? '保存中…' : '保存顺序'}
          </button>
        </>
      }
    >
      <Show when={loaded()} fallback={<p class="py-10 text-center text-slate-400">加载中…</p>}>
        <Show when={pages().length || original().length} fallback={<p class="py-10 text-center text-slate-400">这一集还没有导入页面。</p>}>
          <div class="flex gap-4">
            <div
              ref={listEl}
              tabindex="0"
              class="h-[65vh] w-96 shrink-0 overflow-y-auto rounded border border-slate-200 focus:border-indigo-500 focus:outline-none"
              onKeyDown={onKey}
            >
              <For each={pages()}>
                {(p, i) => (
                  <div
                    class="flex cursor-pointer items-center gap-2 border-b border-slate-100 px-2 py-1 text-xs"
                    classList={{
                      'bg-indigo-100': i() === current(),
                      'hover:bg-slate-50': i() !== current(),
                      'opacity-40': dragFrom() === i(),
                    }}
                    draggable={true}
                    onDragStart={() => setDragFrom(i())}
                    onDragEnd={() => setDragFrom(null)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault()
                      const from = dragFrom()
                      setDragFrom(null)
                      if (from !== null) move(from, i())
                    }}
                    onClick={() => select(i())}
                  >
                    <span class="w-9 shrink-0 font-mono text-slate-400">{String(i() + 1).padStart(4, '0')}</span>
                    <span class="min-w-0 flex-1 truncate" title={p.sourcePath}>
                      {baseName(p.sourcePath)}
                    </span>
                    <Show when={p.position !== i() + 1}>
                      <span class="shrink-0 text-amber-700" title="原来的位置">
                        原 {p.position}
                      </span>
                    </Show>
                    <button class="btn btn-sm" title="放到最前（当封面）" onClick={(e) => (e.stopPropagation(), move(i(), 0))}>
                      ⤒
                    </button>
                    <button class="btn btn-sm" title="上移" onClick={(e) => (e.stopPropagation(), move(i(), i() - 1))}>
                      ↑
                    </button>
                    <button class="btn btn-sm" title="下移" onClick={(e) => (e.stopPropagation(), move(i(), i() + 1))}>
                      ↓
                    </button>
                    <button
                      class="btn btn-sm btn-danger"
                      title="从这一集里移除这一页（只删媒体库里的链接，不动源文件）"
                      onClick={(e) => (e.stopPropagation(), remove(i()))}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </For>
            </div>
            <div class="flex h-[65vh] min-w-0 flex-1 flex-col items-center justify-center rounded bg-slate-50">
              <Show when={previewUrl()} fallback={<span class="text-slate-400">{pages().length ? '加载预览…' : '没有页面'}</span>}>
                <img src={previewUrl()} class="max-h-full max-w-full object-contain" />
              </Show>
            </div>
          </div>
        </Show>
      </Show>
    </Modal>
  )
}
