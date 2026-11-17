import {
  AutomationInput,
  type Automation,
  type AutomationListItem,
  type AutomationMeta,
  type AutomationRun,
  type AutomationRunStatus,
} from '@automedia/shared'
import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup } from 'solid-js'
import { createStore, reconcile, unwrap } from 'solid-js/store'
import { api } from '../api'
import { Field, Section, toast, useAction } from '../ui'

const STATUS: Record<AutomationRunStatus, { label: string; class: string }> = {
  running: { label: '运行中', class: 'bg-sky-100 text-sky-800' },
  success: { label: '成功', class: 'bg-emerald-100 text-emerald-800' },
  failed: { label: '失败', class: 'bg-red-100 text-red-800' },
  timeout: { label: '超时', class: 'bg-amber-100 text-amber-800' },
  killed: { label: '已停止', class: 'bg-slate-200 text-slate-600' },
}
const PRESETS: [string, string][] = [
  ['每 10 分钟', '*/10 * * * *'],
  ['每小时', '0 * * * *'],
  ['每天 3:00', '0 3 * * *'],
  ['每周一 3:00', '0 3 * * 1'],
]
const time = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString('zh-CN') : '—')
const duration = (r: AutomationRun) => {
  const s = Math.round(((r.finishedAt ?? Date.now()) - r.startedAt) / 1000)
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`
}

const SAMPLE_SH = `#!/bin/sh
# 自动提供的环境变量见页面下方的列表
echo "触发方式：$AUTOMEDIA_TRIGGER"

# 例：调用本机接口，列出所有媒体的标题
curl -s -H "Authorization: Bearer $AUTOMEDIA_PASSWORD" "$AUTOMEDIA_API_URL/media" | head -c 300
`
const SAMPLE_PS = `# 自动提供的环境变量见页面下方的列表
Write-Output "触发方式：$env:AUTOMEDIA_TRIGGER"
`

export default function AutomationPage() {
  const [meta] = createResource(() => api<AutomationMeta>('/automations/meta'))
  const [list, { refetch: refetchList }] = createResource(() => api<AutomationListItem[]>('/automations'))

  /** 正在编辑的脚本：数字 = 已有的，'new' = 新建还没保存的，null = 没选 */
  const [selected, setSelected] = createSignal<number | 'new' | null>(null)
  const [form, setForm] = createStore<AutomationInput>(AutomationInput.parse({ name: 'x' }))
  const [scheduleOn, setScheduleOn] = createSignal(false)
  const [cron, setCron] = createSignal('0 3 * * *')
  const [dirty, setDirty] = createSignal(false)
  const [showEnv, setShowEnv] = createSignal(false)

  const current = createMemo(() => {
    const id = selected()
    return typeof id === 'number' ? (list() ?? []).find((a) => a.id === id) : undefined
  })
  const edit: typeof setForm = ((...args: unknown[]) => {
    setDirty(true)
    return (setForm as (...a: unknown[]) => void)(...args)
  }) as typeof setForm

  function load(a: Automation | null) {
    const input = a
      ? AutomationInput.parse(a)
      : {
          ...AutomationInput.parse({ name: 'x', content: meta()?.platform === 'win32' ? SAMPLE_PS : SAMPLE_SH, manual: true }),
          name: '',
        }
    setForm(reconcile(input))
    const schedule = input.triggers.find((t) => t.type === 'schedule')
    setScheduleOn(!!schedule)
    setCron(schedule?.cron ?? '0 3 * * *')
    setDirty(false)
  }
  function select(id: number | 'new' | null) {
    if (dirty() && !confirm('当前脚本有未保存的修改，确定离开？')) return
    setSelected(id)
    setRunId(null)
    load(typeof id === 'number' ? ((list() ?? []).find((a) => a.id === id) ?? null) : null)
  }

  // ───────── 定时表达式预览 ─────────
  const [cronInfo, setCronInfo] = createSignal<{ next?: number[]; error?: string }>({})
  let cronTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(
    on([cron, scheduleOn], ([c, enabled]) => {
      clearTimeout(cronTimer)
      if (!enabled) return setCronInfo({})
      cronTimer = setTimeout(() => {
        api<{ next: number[] }>('/automations/cron', { body: { cron: c } }).then(
          (r) => cron() === c && setCronInfo({ next: r.next }),
          (e) => cron() === c && setCronInfo({ error: e instanceof Error ? e.message : String(e) }),
        )
      }, 300)
    }),
  )

  // ───────── 保存 / 删除 / 执行 ─────────
  const payload = () => ({
    ...structuredClone(unwrap(form)),
    env: form.env.filter((e) => e.key.trim()).map((e) => ({ key: e.key.trim(), value: e.value })),
    triggers: scheduleOn() ? [{ type: 'schedule' as const, cron: cron() }] : [],
  })
  const [save, saving] = useAction(async () => {
    const id = selected()
    const saved =
      typeof id === 'number'
        ? await api<Automation>(`/automations/${id}`, { method: 'PUT', body: payload() })
        : await api<Automation>('/automations', { body: payload() })
    await refetchList()
    setSelected(saved.id)
    load(saved)
    toast.ok('已保存')
  })
  const [remove] = useAction(async () => {
    const a = current()
    if (!a || !confirm(`删除脚本「${a.name}」和它的执行记录？`)) return
    await api(`/automations/${a.id}`, { method: 'DELETE' })
    setDirty(false)
    setSelected(null)
    await refetchList()
  })
  const [run, starting] = useAction(async () => {
    const a = current()
    if (!a) return
    const r = await api<{ runId: number }>(`/automations/${a.id}/run`, { method: 'POST' })
    setRunId(r.runId)
    await Promise.all([refetchList(), refetchRuns()])
  })
  const [stop] = useAction(async () => {
    const a = current()
    if (a) await api(`/automations/${a.id}/stop`, { method: 'POST' })
    await Promise.all([refetchList(), refetchRuns()])
  })

  // ───────── 执行记录 ─────────
  const [runs, { refetch: refetchRuns }] = createResource(
    () => (typeof selected() === 'number' ? (selected() as number) : null),
    (id) => api<AutomationRun[]>(`/automations/${id}/runs`),
  )
  const [runId, setRunId] = createSignal<number | null>(null)
  const [runDetail, { refetch: refetchRun }] = createResource(runId, (id) => api<AutomationRun>(`/automation-runs/${id}`))

  // 有脚本在跑时每 2 秒刷新一次状态和输出；平时 15 秒刷新一次列表（看定时有没有触发）
  let tick = 0
  const poll = setInterval(() => {
    tick++
    const busy = (list() ?? []).some((a) => a.running) || runDetail()?.status === 'running'
    if (!busy && tick % 7 !== 0) return
    void refetchList()
    if (typeof selected() === 'number') void refetchRuns()
    if (runId() !== null && (busy || runDetail()?.status === 'running')) void refetchRun()
  }, 2000)
  onCleanup(() => {
    clearInterval(poll)
    clearTimeout(cronTimer)
  })

  /** 编辑器里按 Tab 插入两个空格，而不是跳到下一个输入框 */
  function onEditorKey(e: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) {
    if (e.key !== 'Tab' || e.shiftKey || e.isComposing) return
    e.preventDefault()
    const el = e.currentTarget
    const { selectionStart: s, selectionEnd: end } = el
    el.setRangeText('  ', s, end, 'end')
    edit('content', el.value)
  }

  return (
    <>
      <div class="mb-4 flex items-center gap-3">
        <h1 class="text-lg font-semibold">自动化</h1>
        <span class="text-xs text-slate-400">自己写的脚本，按定时或手动执行。脚本以运行 automedia 的系统用户的身份执行。</span>
        <button class="btn btn-primary ml-auto" onClick={() => select('new')}>
          ＋ 新建脚本
        </button>
      </div>
      <Show when={meta() && !meta()!.enabled}>
        <p class="mb-4 rounded bg-amber-50 p-3 text-amber-800">
          自动化功能已在服务端关闭（环境变量 AUTOMEDIA_AUTOMATION=off）。可以查看和编辑脚本，但不会执行。
        </p>
      </Show>

      <div class="flex flex-col gap-4 lg:flex-row">
        <div class="card h-fit shrink-0 overflow-hidden lg:w-80">
          <For each={list()} fallback={<p class="p-6 text-center text-slate-400">还没有脚本。</p>}>
            {(a) => {
              const schedule = () => a.triggers.find((t) => t.type === 'schedule')
              return (
                <div
                  class="cursor-pointer border-b border-slate-100 px-3 py-2 last:border-b-0"
                  classList={{ 'bg-indigo-50': selected() === a.id, 'hover:bg-slate-50': selected() !== a.id }}
                  onClick={() => select(a.id)}
                >
                  <div class="flex items-center gap-2">
                    <span class="min-w-0 flex-1 truncate font-medium">{a.name}</span>
                    <Show when={a.running}>
                      <span class={`badge ${STATUS.running.class}`}>运行中</span>
                    </Show>
                    <Show when={!a.running && a.lastRun}>
                      <span class={`badge ${STATUS[a.lastRun!.status].class}`}>{STATUS[a.lastRun!.status].label}</span>
                    </Show>
                  </div>
                  <div class="mt-0.5 flex flex-wrap gap-x-2 text-xs text-slate-400">
                    <Show when={schedule()} fallback={<span>无定时</span>}>
                      <span class="font-mono" classList={{ 'line-through': !a.enabled }}>
                        {schedule()!.cron}
                      </span>
                    </Show>
                    <Show when={a.manual}>
                      <span>可手动</span>
                    </Show>
                    <Show when={a.nextRun}>
                      <span>下次 {time(a.nextRun)}</span>
                    </Show>
                  </div>
                </div>
              )
            }}
          </For>
        </div>

        <div class="min-w-0 flex-1">
          <Show when={selected() !== null} fallback={<p class="card p-10 text-center text-slate-400">在左边选一个脚本，或者新建一个。</p>}>
            <Section
              title={selected() === 'new' ? '新建脚本' : `编辑：${current()?.name ?? ''}`}
              actions={
                <div class="flex items-center gap-2">
                  <Show when={dirty()}>
                    <span class="badge bg-amber-100 text-amber-800">未保存</span>
                  </Show>
                  <Show when={current()?.running}>
                    <button class="btn btn-danger" onClick={() => void stop()}>
                      停止
                    </button>
                  </Show>
                  <Show when={current() && !current()!.running}>
                    <button
                      class="btn"
                      disabled={starting() || dirty() || !current()!.manual || !meta()?.enabled}
                      title={
                        !current()!.manual
                          ? '这个脚本没有勾选「允许手动触发」'
                          : dirty()
                            ? '先保存再执行'
                            : '现在执行一次'
                      }
                      onClick={() => void run()}
                    >
                      立即执行
                    </button>
                  </Show>
                  <Show when={current()}>
                    <button class="btn btn-danger" onClick={() => void remove()}>
                      删除
                    </button>
                  </Show>
                  <button class="btn btn-primary" disabled={saving() || (!dirty() && selected() !== 'new')} onClick={() => void save()}>
                    保存
                  </button>
                </div>
              }
            >
              <div class="grid gap-4 sm:grid-cols-4">
                <Field class="sm:col-span-2" label="名称">
                  <input class="input" value={form.name} onInput={(e) => edit('name', e.currentTarget.value)} />
                </Field>
                <Field class="sm:col-span-2" label="脚本来源">
                  <select class="input" value={form.source} onChange={(e) => edit('source', e.currentTarget.value as AutomationInput['source'])}>
                    <option value="inline">直接在这里编写</option>
                    <option value="file">服务器上已有的脚本文件</option>
                  </select>
                </Field>

                <Show when={form.source === 'inline'}>
                  <Field class="sm:col-span-4" label="脚本内容">
                    <textarea
                      class="input font-mono text-xs leading-5"
                      rows={16}
                      spellcheck={false}
                      wrap="off"
                      value={form.content}
                      onInput={(e) => edit('content', e.currentTarget.value)}
                      onKeyDown={onEditorKey}
                    />
                  </Field>
                </Show>
                <Show when={form.source === 'file'}>
                  <Field class="sm:col-span-4" label="脚本文件的路径" hint="服务器上的绝对路径。每次执行都读这个文件的最新内容。">
                    <input
                      class="input font-mono"
                      placeholder="/Users/me/scripts/cleanup.sh"
                      value={form.filePath}
                      onInput={(e) => edit('filePath', e.currentTarget.value)}
                    />
                  </Field>
                </Show>

                <Field
                  class="sm:col-span-2"
                  label="用什么执行"
                  hint={
                    form.source === 'inline'
                      ? `比如 bash、zsh、python3、node。留空用 ${meta()?.defaultInterpreter ?? 'sh'}`
                      : '比如 bash、python3。留空则直接执行这个文件（需要有执行权限和 #! 行）'
                  }
                >
                  <input
                    class="input font-mono"
                    placeholder={form.source === 'inline' ? meta()?.defaultInterpreter : '直接执行'}
                    value={form.interpreter}
                    onInput={(e) => edit('interpreter', e.currentTarget.value)}
                  />
                </Field>
                <Field label="工作目录" hint="留空用脚本所在的目录">
                  <input class="input font-mono" value={form.cwd} onInput={(e) => edit('cwd', e.currentTarget.value)} />
                </Field>
                <Field label="超时（秒）" hint="超过就强制结束">
                  <input
                    class="input"
                    type="number"
                    min="1"
                    value={form.timeoutSec}
                    onInput={(e) => edit('timeoutSec', Math.max(1, Math.round(Number(e.currentTarget.value) || 0)))}
                  />
                </Field>
              </div>

              <h3 class="mt-6 mb-2 font-semibold">执行时机</h3>
              <div class="rounded border border-slate-200 p-3">
                <label class="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={scheduleOn()}
                    onChange={(e) => (setScheduleOn(e.currentTarget.checked), setDirty(true))}
                  />
                  <span>定时执行</span>
                </label>
                <Show when={scheduleOn()}>
                  <div class="mt-2 flex flex-wrap items-center gap-2">
                    <input
                      class="input w-48 font-mono"
                      placeholder="分 时 日 月 周"
                      value={cron()}
                      onInput={(e) => (setCron(e.currentTarget.value), setDirty(true))}
                    />
                    <For each={PRESETS}>
                      {([label, value]) => (
                        <button class="btn btn-sm" onClick={() => (setCron(value), setDirty(true))}>
                          {label}
                        </button>
                      )}
                    </For>
                    <label class="ml-auto flex items-center gap-1 text-xs text-slate-500" title="关掉后定时不再触发，手动触发不受影响">
                      <input type="checkbox" checked={form.enabled} onChange={(e) => edit('enabled', e.currentTarget.checked)} />
                      启用
                    </label>
                  </div>
                  <p class="mt-2 text-xs" classList={{ 'text-red-700': !!cronInfo().error, 'text-slate-400': !cronInfo().error }}>
                    <Show when={!cronInfo().error} fallback={cronInfo().error}>
                      cron 表达式（分 时 日 月 周），按服务器的本地时间。
                      <Show when={cronInfo().next?.length}> 接下来：{cronInfo().next!.map(time).join('、')}</Show>
                    </Show>
                  </p>
                </Show>
                <label class="mt-3 flex items-center gap-2 border-t border-slate-100 pt-3">
                  <input type="checkbox" checked={form.manual} onChange={(e) => edit('manual', e.currentTarget.checked)} />
                  <span>允许手动触发</span>
                  <span class="text-xs text-slate-400">勾选后才能在这里点「立即执行」，或通过接口触发</span>
                </label>
              </div>

              <h3 class="mt-6 mb-2 font-semibold">环境变量</h3>
              <For each={form.env}>
                {(v, i) => (
                  <div class="mb-2 flex items-center gap-2">
                    <input
                      class="input w-56 font-mono"
                      placeholder="NAME"
                      value={v.key}
                      onInput={(e) => edit('env', i(), 'key', e.currentTarget.value)}
                    />
                    <span>=</span>
                    <input class="input font-mono" value={v.value} onInput={(e) => edit('env', i(), 'value', e.currentTarget.value)} />
                    <button class="btn btn-danger" onClick={() => edit('env', (l) => l.filter((_, j) => j !== i()))}>
                      移除
                    </button>
                  </div>
                )}
              </For>
              <div class="flex items-center gap-3">
                <button class="btn" onClick={() => edit('env', (l) => [...l, { key: '', value: '' }])}>
                  ＋ 添加变量
                </button>
                <button class="text-xs text-indigo-600 hover:underline" onClick={() => setShowEnv(!showEnv())}>
                  {showEnv() ? '收起' : '查看'}自动提供的环境变量（{meta()?.env.length ?? 0} 个）
                </button>
              </div>
              <Show when={showEnv()}>
                <table class="mt-2 w-full text-xs">
                  <tbody>
                    <For each={meta()?.env}>
                      {(v) => (
                        <tr class="border-t border-slate-100 align-top">
                          <td class="py-1 pr-3 font-mono whitespace-nowrap">{v.name}</td>
                          <td class="py-1 pr-3 text-slate-500">{v.description}</td>
                          <td class="max-w-64 truncate py-1 font-mono text-slate-400" title={v.value}>
                            {v.secret ? '（不显示）' : v.value.replace(/\n/g, ' ⏎ ')}
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </Show>
            </Section>

            <Show when={current()}>
              <Section title="执行记录" desc="每个脚本保留最近 50 次。点一条看输出。">
                <div class="flex flex-col gap-4 lg:flex-row">
                  <div class="max-h-96 shrink-0 overflow-y-auto lg:w-80">
                    <For each={runs()} fallback={<p class="py-4 text-center text-slate-400">还没有执行过。</p>}>
                      {(r) => (
                        <div
                          class="flex cursor-pointer items-center gap-2 border-b border-slate-100 px-2 py-1.5 text-xs"
                          classList={{ 'bg-indigo-50': runId() === r.id, 'hover:bg-slate-50': runId() !== r.id }}
                          onClick={() => setRunId(r.id)}
                        >
                          <span class={`badge ${STATUS[r.status].class}`}>{STATUS[r.status].label}</span>
                          <span class="flex-1">{time(r.startedAt)}</span>
                          <span class="text-slate-400">
                            {r.trigger === 'manual' ? '手动' : '定时'} · {duration(r)}
                          </span>
                        </div>
                      )}
                    </For>
                  </div>
                  <div class="min-w-0 flex-1">
                    <Show when={runDetail()} fallback={<p class="py-4 text-center text-slate-400">选一条记录查看输出。</p>}>
                      <div class="mb-1 text-xs text-slate-400">
                        #{runDetail()!.id} · {STATUS[runDetail()!.status].label}
                        {runDetail()!.exitCode !== null ? ` · 退出码 ${runDetail()!.exitCode}` : ''} · {duration(runDetail()!)}
                      </div>
                      <pre class="max-h-96 overflow-auto rounded bg-slate-50 p-2 font-mono text-xs whitespace-pre-wrap">
                        {runDetail()!.output || '（没有输出）'}
                      </pre>
                    </Show>
                  </div>
                </div>
              </Section>
            </Show>
          </Show>
        </div>
      </div>
    </>
  )
}
