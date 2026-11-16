import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount, type JSX } from 'solid-js'
import { Portal } from 'solid-js/web'
import { api } from './api'

// ───────────────────────── toast ─────────────────────────

interface ToastItem {
  id: number
  kind: 'ok' | 'err'
  text: string
}
const [toasts, setToasts] = createSignal<ToastItem[]>([])
let seq = 0

function push(kind: ToastItem['kind'], text: string) {
  const id = ++seq
  setToasts((t) => [...t, { id, kind, text }])
  setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'err' ? 9000 : 3500)
}

export const toast = {
  ok: (text: string) => push('ok', text),
  err: (e: unknown) => push('err', e instanceof Error ? e.message : String(e)),
}

export function Toasts() {
  return (
    <Portal>
      <div class="fixed right-4 bottom-4 z-[100] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
        <For each={toasts()}>
          {(t) => (
            <div
              class="cursor-pointer rounded-md border px-3 py-2 text-sm whitespace-pre-wrap shadow-lg"
              classList={{
                'border-emerald-200 bg-emerald-50 text-emerald-800': t.kind === 'ok',
                'border-red-200 bg-red-50 text-red-800': t.kind === 'err',
              }}
              onClick={() => setToasts((list) => list.filter((x) => x.id !== t.id))}
            >
              {t.text}
            </div>
          )}
        </For>
      </div>
    </Portal>
  )
}

/** 包一层：失败时弹 toast，并把 busy 状态暴露出来给按钮用 */
export function useAction<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  const [busy, setBusy] = createSignal(false)
  const run = async (...args: A) => {
    if (busy()) return
    setBusy(true)
    try {
      await fn(...args)
    } catch (e) {
      toast.err(e)
    } finally {
      setBusy(false)
    }
  }
  return [run, busy] as const
}

// ───────────────────────── 基础组件 ─────────────────────────

export function Modal(props: {
  title: string
  onClose: () => void
  children: JSX.Element
  footer?: JSX.Element
  wide?: boolean
}) {
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
  onMount(() => document.addEventListener('keydown', onKey))
  onCleanup(() => document.removeEventListener('keydown', onKey))
  return (
    <Portal>
      <div
        class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-10"
        onClick={(e) => e.target === e.currentTarget && props.onClose()}
      >
        <div class="card flex max-h-full w-full flex-col shadow-xl" classList={{ 'max-w-5xl': props.wide, 'max-w-xl': !props.wide }}>
          <div class="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <h2 class="text-base font-semibold">{props.title}</h2>
            <button class="btn btn-sm" onClick={props.onClose}>
              关闭
            </button>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto p-4">{props.children}</div>
          <Show when={props.footer}>
            <div class="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-3">{props.footer}</div>
          </Show>
        </div>
      </div>
    </Portal>
  )
}

export function Field(props: { label: string; hint?: string; class?: string; children: JSX.Element }) {
  return (
    <label class={`block ${props.class ?? ''}`}>
      <span class="label">{props.label}</span>
      {props.children}
      <Show when={props.hint}>
        <span class="mt-1 block text-xs text-slate-400">{props.hint}</span>
      </Show>
    </label>
  )
}

export function Section(props: { title: string; desc?: string; children: JSX.Element; actions?: JSX.Element }) {
  return (
    <section class="card mb-4">
      <div class="flex items-center justify-between gap-4 border-b border-slate-100 px-4 py-3">
        <div>
          <h2 class="font-semibold">{props.title}</h2>
          <Show when={props.desc}>
            <p class="mt-0.5 text-xs text-slate-500">{props.desc}</p>
          </Show>
        </div>
        {props.actions}
      </div>
      <div class="p-4">{props.children}</div>
    </section>
  )
}

// ───────────────────────── 目录选择 ─────────────────────────

interface DirListing {
  path: string
  parent: string | null
  dirs: { name: string; path: string }[]
}

export function DirPicker(props: { initial?: string; onPick: (path: string) => void; onClose: () => void }) {
  const [path, setPath] = createSignal(props.initial ?? '')
  const [listing] = createResource(path, async (p) => {
    try {
      return await api<DirListing>('/fs/dirs', { query: { path: p } })
    } catch (e) {
      // 初始路径不存在时退回根目录
      if (p) return api<DirListing>('/fs/dirs', { query: { path: '' } })
      throw e
    }
  })
  return (
    <Modal
      title="选择目录"
      onClose={props.onClose}
      footer={
        <button class="btn btn-primary" disabled={!listing()?.path} onClick={() => props.onPick(listing()!.path)}>
          选择这个目录
        </button>
      }
    >
      <div class="mb-2 rounded bg-slate-100 px-2 py-1 font-mono text-xs break-all">{listing()?.path || '（根）'}</div>
      <div class="max-h-96 overflow-y-auto rounded border border-slate-200">
        <Show when={listing()?.parent !== null && listing()?.parent !== undefined}>
          <button class="block w-full px-3 py-1.5 text-left hover:bg-slate-100" onClick={() => setPath(listing()!.parent!)}>
            ⬑ 上一级
          </button>
        </Show>
        <For each={listing()?.dirs} fallback={<div class="px-3 py-4 text-center text-slate-400">没有子目录</div>}>
          {(d) => (
            <button class="block w-full px-3 py-1.5 text-left hover:bg-slate-100" onClick={() => setPath(d.path)}>
              📁 {d.name}
            </button>
          )}
        </For>
      </div>
    </Modal>
  )
}

export function PathInput(props: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [open, setOpen] = createSignal(false)
  return (
    <div class="flex gap-2">
      <input
        class="input font-mono"
        value={props.value}
        placeholder={props.placeholder}
        onInput={(e) => props.onChange(e.currentTarget.value)}
      />
      <button type="button" class="btn" onClick={() => setOpen(true)}>
        浏览
      </button>
      <Show when={open()}>
        <DirPicker
          initial={props.value}
          onClose={() => setOpen(false)}
          onPick={(p) => {
            props.onChange(p)
            setOpen(false)
          }}
        />
      </Show>
    </div>
  )
}

// ───────────────────────── 可输入筛选的下拉框 ─────────────────────────

export function Combobox(props: {
  options: { value: number; label: string }[]
  value: number | null
  onChange: (value: number) => void
  placeholder?: string
  empty?: string
  class?: string
}) {
  const [open, setOpen] = createSignal(false)
  /** 正在输入的筛选文字；null = 没在输入，显示当前选中项 */
  const [text, setText] = createSignal<string | null>(null)
  const [active, setActive] = createSignal(0)
  let list: HTMLDivElement | undefined

  const selectedLabel = () => props.options.find((o) => o.value === props.value)?.label ?? ''
  const filtered = createMemo(() => {
    const k = (text() ?? '').trim().toLowerCase()
    return k ? props.options.filter((o) => o.label.toLowerCase().includes(k)) : props.options
  })
  const close = () => {
    setOpen(false)
    setText(null)
  }
  const pick = (o: { value: number }) => {
    close()
    if (o.value !== props.value) props.onChange(o.value)
  }
  const move = (delta: number) => {
    const n = filtered().length
    if (!n) return
    setActive((i) => Math.min(n - 1, Math.max(0, i + delta)))
    queueMicrotask(() => list?.children[active()]?.scrollIntoView({ block: 'nearest' }))
  }

  return (
    <div class={`relative ${props.class ?? ''}`}>
      <input
        class="input"
        role="combobox"
        aria-expanded={open()}
        autocomplete="off"
        placeholder={props.placeholder}
        value={text() ?? selectedLabel()}
        onFocus={(e) => {
          setOpen(true)
          e.currentTarget.select()
        }}
        onClick={() => setOpen(true)}
        onBlur={close}
        onInput={(e) => {
          setText(e.currentTarget.value)
          setActive(0)
          setOpen(true)
        }}
        onKeyDown={(e) => {
          if (e.isComposing) return
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            if (!open()) setOpen(true)
            else move(e.key === 'ArrowDown' ? 1 : -1)
          } else if (e.key === 'Enter') {
            const o = open() && filtered()[active()]
            if (o) {
              e.preventDefault()
              pick(o)
            }
          } else if (e.key === 'Escape' && open()) {
            e.stopPropagation()
            close()
          }
        }}
      />
      <Show when={open()}>
        <div
          ref={list}
          class="absolute top-full right-0 left-0 z-40 mt-1 max-h-80 overflow-y-auto rounded-md border border-slate-300 bg-white shadow-lg"
        >
          <For each={filtered()} fallback={<div class="px-2 py-2 text-slate-400">{props.empty ?? '没有匹配项'}</div>}>
            {(o, i) => (
              <div
                class="cursor-pointer truncate px-2 py-1.5"
                classList={{ 'bg-indigo-100': i() === active(), 'font-semibold text-indigo-700': o.value === props.value }}
                title={o.label}
                // mousedown 而不是 click：赶在输入框失焦（会关闭下拉）之前选中
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(o)
                }}
                onMouseEnter={() => setActive(i())}
              >
                {o.label}
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

export const fmtDate =(ms: number) => (ms ? new Date(ms).toLocaleDateString('zh-CN') : '')
export const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p
