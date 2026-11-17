import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  Automation,
  AutomationInput,
  AutomationListItem,
  AutomationRun,
  AutomationRunStatus,
  AutomationTriggerKind,
} from '@automedia/shared'
import { Cron } from 'croner'
import { desc, eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db'
import { DATA_DIR, PORT, loadPassword } from '../env'
import { AppError, badRequest, errMsg, notFound } from '../errors'
import { getSettings } from '../settings'

/**
 * 自动化：用户自己写的脚本，按定时或手动执行。
 * 脚本以运行 automedia 的那个系统用户的身份执行，能做那个用户能做的任何事 ——
 * 所以这个功能可以用环境变量 AUTOMEDIA_AUTOMATION=off 整个关掉。
 */
export const automationEnabled = () => process.env.AUTOMEDIA_AUTOMATION !== 'off'

const OUTPUT_LIMIT = 256 * 1024
const KEEP_RUNS = 50
const scriptsDir = () => path.join(DATA_DIR, 'automation')

// ───────────────────────── 存取 ─────────────────────────

type Row = typeof schema.automations.$inferSelect
type RunRow = typeof schema.automationRuns.$inferSelect

const toAutomation = (r: Row): Automation => ({ ...r, source: r.source as Automation['source'] })
const toRun = (r: RunRow, withOutput: boolean): AutomationRun => ({
  ...r,
  trigger: r.trigger as AutomationTriggerKind,
  status: r.status as AutomationRunStatus,
  output: withOutput ? r.output : undefined,
})

export function getAutomation(id: number): Automation {
  const row = db().select().from(schema.automations).where(eq(schema.automations.id, id)).get()
  if (!row) throw notFound(`脚本 #${id} 不存在`)
  return toAutomation(row)
}

/** cron 表达式之后的几次执行时间；表达式不合法时抛错 */
export function cronPreview(cron: string, count = 3): number[] {
  let job: Cron
  try {
    job = new Cron(cron.trim(), { paused: true, utcOffset })
  } catch (e) {
    throw badRequest(`定时表达式无效：${errMsg(e)}`)
  }
  const next = job.nextRuns(count).map((d) => d.getTime())
  job.stop()
  return next
}

async function validate(input: AutomationInput): Promise<void> {
  for (const t of input.triggers) if (t.type === 'schedule') cronPreview(t.cron, 1)
  if (input.source === 'file') {
    if (!input.filePath.trim()) throw badRequest('请填写脚本文件的路径')
    const st = await fs.stat(input.filePath.trim()).catch(() => null)
    if (!st?.isFile()) throw badRequest(`服务器上没有这个文件：${input.filePath}`)
  } else if (!input.content.trim()) throw badRequest('脚本内容是空的')
  const keys = input.env.map((e) => e.key)
  if (new Set(keys).size !== keys.length) throw badRequest('环境变量有重名的')
}

export async function createAutomation(input: AutomationInput): Promise<Automation> {
  await validate(input)
  const now = Date.now()
  const row = db()
    .insert(schema.automations)
    .values({ ...input, createdAt: now, updatedAt: now })
    .returning()
    .get()
  const a = toAutomation(row)
  reschedule(a)
  return a
}

export async function updateAutomation(id: number, input: AutomationInput): Promise<Automation> {
  getAutomation(id)
  await validate(input)
  db()
    .update(schema.automations)
    .set({ ...input, updatedAt: Date.now() })
    .where(eq(schema.automations.id, id))
    .run()
  const a = getAutomation(id)
  reschedule(a)
  return a
}

export async function deleteAutomation(id: number): Promise<void> {
  getAutomation(id)
  unschedule(id)
  await stopRun(id).catch(() => {})
  db().delete(schema.automationRuns).where(eq(schema.automationRuns.automationId, id)).run()
  db().delete(schema.automations).where(eq(schema.automations.id, id)).run()
}

export function listAutomations(): AutomationListItem[] {
  const d = db()
  const rows = d.select().from(schema.automations).all().map(toAutomation)
  return rows
    .map((a) => {
      const last = d
        .select()
        .from(schema.automationRuns)
        .where(eq(schema.automationRuns.automationId, a.id))
        .orderBy(desc(schema.automationRuns.id))
        .limit(1)
        .get()
      return { ...a, running: running.has(a.id), nextRun: nextRunOf(a.id), lastRun: last ? toRun(last, false) : null }
    })
    .sort((x, y) => x.name.localeCompare(y.name, 'zh'))
}

export function listRuns(automationId: number): AutomationRun[] {
  return db()
    .select()
    .from(schema.automationRuns)
    .where(eq(schema.automationRuns.automationId, automationId))
    .orderBy(desc(schema.automationRuns.id))
    .limit(KEEP_RUNS)
    .all()
    .map((r) => toRun(r, false))
}

export function getRun(runId: number): AutomationRun {
  const row = db().select().from(schema.automationRuns).where(eq(schema.automationRuns.id, runId)).get()
  if (!row) throw notFound('没有这条执行记录')
  const run = toRun(row, true)
  // 还在跑的：输出在内存里，没落库
  const live = [...running.values()].find((r) => r.runId === runId)
  if (live) run.output = live.output
  return run
}

// ───────────────────────── 提供给脚本的环境变量 ─────────────────────────

export interface ProvidedVar {
  name: string
  description: string
  value: string
  secret?: boolean
}

export function providedEnv(ctx?: { automation: Automation; trigger: AutomationTriggerKind; runId: number }): ProvidedVar[] {
  const s = getSettings()
  return [
    { name: 'AUTOMEDIA_API_URL', description: '本机 API 的地址，配合下面的密码可以直接调接口', value: `http://127.0.0.1:${PORT}/api` },
    { name: 'AUTOMEDIA_PASSWORD', description: '访问密码。调接口时放在请求头里：Authorization: Bearer $AUTOMEDIA_PASSWORD', value: loadPassword().password, secret: true },
    { name: 'AUTOMEDIA_DATA_DIR', description: '数据目录（数据库、封面等）', value: DATA_DIR },
    { name: 'AUTOMEDIA_LIBRARIES', description: '所有媒体库，JSON 数组：[{"id","name","path"}]', value: JSON.stringify(s.libraries) },
    { name: 'AUTOMEDIA_LIBRARY_PATHS', description: '所有媒体库的目录，每行一个', value: s.libraries.map((l) => l.path).join('\n') },
    { name: 'AUTOMEDIA_SUBTITLE_DIR', description: '字幕存放目录', value: s.subtitleDir },
    { name: 'AUTOMEDIA_QB_URL', description: 'qBittorrent WebUI 地址', value: s.qb.url },
    { name: 'AUTOMEDIA_QB_USERNAME', description: 'qBittorrent 用户名', value: s.qb.username },
    { name: 'AUTOMEDIA_QB_PASSWORD', description: 'qBittorrent 密码', value: s.qb.password, secret: true },
    { name: 'AUTOMEDIA_SCRIPT_ID', description: '当前脚本的 ID', value: ctx ? String(ctx.automation.id) : '' },
    { name: 'AUTOMEDIA_SCRIPT_NAME', description: '当前脚本的名称', value: ctx?.automation.name ?? '' },
    { name: 'AUTOMEDIA_TRIGGER', description: '这次是怎么触发的：schedule（定时）或 manual（手动）', value: ctx?.trigger ?? '' },
    { name: 'AUTOMEDIA_RUN_ID', description: '这次执行的编号', value: ctx ? String(ctx.runId) : '' },
  ]
}

// ───────────────────────── 执行 ─────────────────────────

/** 把「bash -e」「"C:\Program Files\x.exe" --flag」这样的命令行拆成参数，支持单双引号 */
export function parseArgv(s: string): string[] {
  const out: string[] = []
  for (const m of s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

export const defaultInterpreter = () =>
  process.platform === 'win32' ? 'powershell -NoProfile -ExecutionPolicy Bypass -File' : 'sh'

/** 直接编写的脚本落成临时文件时用什么扩展名（PowerShell 的 -File 只认 .ps1） */
function scriptExt(interpreter: string): string {
  const i = interpreter.toLowerCase()
  if (/powershell|pwsh/.test(i)) return '.ps1'
  if (/python/.test(i)) return '.py'
  if (/\bnode\b|node\.exe|\bbun\b|\bdeno\b/.test(i)) return '.mjs'
  if (/\bcmd\b|cmd\.exe/.test(i)) return '.cmd'
  return '.sh'
}

interface Live {
  runId: number
  child: ChildProcess
  output: string
  stopped?: 'timeout' | 'killed'
  done: Promise<void>
}
/** automationId → 正在跑的那一次。同一个脚本不会同时跑两次 */
const running = new Map<number, Live>()

function killTree(child: ChildProcess) {
  if (!child.pid) return
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {})
  else {
    // 脚本是单独的进程组（见 spawn 的 detached），连它起的子进程一起结束
    const kill = (sig: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, sig)
      } catch {
        /* 已经退出了 */
      }
    }
    kill('SIGTERM')
    setTimeout(() => kill('SIGKILL'), 5000).unref()
  }
}

/** 开始执行，返回这次执行的编号（不等它跑完）。同一个脚本正在跑时抛 409 */
export async function startRun(id: number, trigger: AutomationTriggerKind): Promise<number> {
  if (!automationEnabled()) throw new AppError(403, '自动化功能已被关闭（AUTOMEDIA_AUTOMATION=off）')
  const a = getAutomation(id)
  if (trigger === 'manual' && !a.manual) throw new AppError(403, '这个脚本没有开启「允许手动触发」')
  if (running.has(id)) throw new AppError(409, '这个脚本正在运行')

  const d = db()
  const runId = d
    .insert(schema.automationRuns)
    .values({ automationId: id, trigger, status: 'running', startedAt: Date.now() })
    .returning({ id: schema.automationRuns.id })
    .get().id

  const finish = (status: AutomationRunStatus, exitCode: number | null, output: string) => {
    d.update(schema.automationRuns)
      .set({ status, exitCode, output, finishedAt: Date.now() })
      .where(eq(schema.automationRuns.id, runId))
      .run()
    // 每个脚本只留最近的若干条记录
    const old = d
      .select({ id: schema.automationRuns.id })
      .from(schema.automationRuns)
      .where(eq(schema.automationRuns.automationId, id))
      .orderBy(desc(schema.automationRuns.id))
      .offset(KEEP_RUNS)
      .limit(1000)
      .all()
    if (old.length) d.delete(schema.automationRuns).where(inArray(schema.automationRuns.id, old.map((r) => r.id))).run()
  }

  let tmpFile = ''
  let child: ChildProcess
  try {
    const interpreter = a.interpreter.trim()
    let script = a.filePath.trim()
    let argv: string[]
    if (a.source === 'inline') {
      const interp = interpreter || defaultInterpreter()
      await fs.mkdir(scriptsDir(), { recursive: true })
      tmpFile = script = path.join(scriptsDir(), `script-${id}-run-${runId}${scriptExt(interp)}`)
      // 在网页里写的脚本换行可能是 CRLF，sh 会把 \r 当成命令的一部分
      // Windows PowerShell 5 把不带 BOM 的脚本当成本地编码读，中文会乱，所以给 .ps1 加上 BOM
      const content =
        process.platform !== 'win32'
          ? a.content.replace(/\r\n/g, '\n')
          : tmpFile.endsWith('.ps1')
            ? '﻿' + a.content
            : a.content
      await fs.writeFile(tmpFile, content, { mode: 0o700 })
      argv = [...parseArgv(interp), script]
    } else if (interpreter) argv = [...parseArgv(interpreter), script]
    else if (process.platform === 'win32' && /\.ps1$/i.test(script)) argv = [...parseArgv(defaultInterpreter()), script]
    else if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(script)) argv = ['cmd', '/c', script]
    else argv = [script] // 直接执行：需要有可执行权限和 shebang

    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const v of providedEnv({ automation: a, trigger, runId })) env[v.name] = v.value
    for (const v of a.env) env[v.key] = v.value
    child = spawn(argv[0], argv.slice(1), {
      cwd: a.cwd.trim() || (a.source === 'file' ? path.dirname(script) : scriptsDir()),
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    if (tmpFile) await fs.rm(tmpFile, { force: true })
    finish('failed', null, `无法启动：${errMsg(e)}`)
    return runId
  }

  let resolveDone!: () => void
  const live: Live = { runId, child, output: '', done: new Promise<void>((r) => (resolveDone = r)) }
  running.set(id, live)
  const append = (chunk: Buffer | string) => {
    live.output += chunk.toString()
    if (live.output.length > OUTPUT_LIMIT)
      live.output = '…（前面的输出太长，已截掉）\n' + live.output.slice(-OUTPUT_LIMIT + 1024)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  const timer = setTimeout(() => {
    live.stopped = 'timeout'
    append(`\n[automedia] 超过 ${a.timeoutSec} 秒，已强制结束\n`)
    killTree(child)
  }, a.timeoutSec * 1000)

  let settled = false
  const settle = (status: AutomationRunStatus, code: number | null) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    running.delete(id)
    finish(status, code, live.output)
    if (tmpFile) void fs.rm(tmpFile, { force: true })
    resolveDone()
  }
  child.on('error', (e) => {
    append(`无法启动：${errMsg(e)}\n`)
    settle('failed', null)
  })
  child.on('close', (code) => settle(live.stopped ?? (code === 0 ? 'success' : 'failed'), code))
  return runId
}

export async function stopRun(id: number): Promise<void> {
  const live = running.get(id)
  if (!live) return
  live.stopped = 'killed'
  live.output += '\n[automedia] 已手动停止\n'
  killTree(live.child)
  await live.done
}

/** 等某个脚本当前这次执行结束（测试用） */
export const idle = (id: number) => running.get(id)?.done ?? Promise.resolve()

// ───────────────────────── 定时 ─────────────────────────

const jobs = new Map<number, Cron[]>()

/**
 * 排定时用的 UTC 偏移（分钟）。不直接用 Node 的「本地时间」：Node 自带一份时区数据，
 * 当地的时区规则改了而 Node 没更新时，它算出来的本地时间会和系统差一小时。
 * 所以以操作系统给出的偏移为准，并定期复查（夏令时切换时偏移会变）。
 */
let utcOffset = -new Date().getTimezoneOffset()

function systemUtcOffset(): Promise<number | null> {
  return new Promise((resolve) => {
    const done = (minutes: number) => resolve(Number.isFinite(minutes) && Math.abs(minutes) <= 16 * 60 ? minutes : null)
    if (process.platform === 'win32')
      execFile(
        'powershell',
        ['-NoProfile', '-Command', '[int][System.TimeZoneInfo]::Local.GetUtcOffset([DateTime]::Now).TotalMinutes'],
        { timeout: 15_000, windowsHide: true },
        (err, out) => (err ? resolve(null) : done(Number(out.trim()))),
      )
    else
      execFile('date', ['+%z'], { timeout: 15_000 }, (err, out) => {
        const m = /^([+-])(\d{2})(\d{2})$/.exec(out?.trim() ?? '')
        if (err || !m) return resolve(null)
        done((m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])))
      })
  })
}

async function refreshClock(): Promise<void> {
  const real = await systemUtcOffset()
  if (real === null || real === utcOffset) return
  console.log(`[automation] 按系统时区排定时：UTC${real >= 0 ? '+' : '-'}${String(Math.abs(real) / 60).replace(/\.5$/, ':30')}（Node 自己算的是 ${-new Date().getTimezoneOffset()} 分钟）`)
  utcOffset = real
  for (const row of db().select().from(schema.automations).all()) reschedule(toAutomation(row))
}

function unschedule(id: number) {
  for (const j of jobs.get(id) ?? []) j.stop()
  jobs.delete(id)
}

function reschedule(a: Automation) {
  unschedule(a.id)
  if (!automationEnabled() || !a.enabled) return
  const list: Cron[] = []
  for (const t of a.triggers) {
    if (t.type !== 'schedule') continue
    try {
      list.push(
        new Cron(t.cron.trim(), { utcOffset }, () => {
          // 上一次还没跑完就跳过这一次
          if (running.has(a.id)) return
          startRun(a.id, 'schedule').catch((e) => console.warn(`[automation] ${a.name} 启动失败：${errMsg(e)}`))
        }),
      )
    } catch (e) {
      console.warn(`[automation] ${a.name} 的定时表达式无效：${errMsg(e)}`)
    }
  }
  if (list.length) jobs.set(a.id, list)
}

function nextRunOf(id: number): number | null {
  const times = (jobs.get(id) ?? []).map((j) => j.nextRun()?.getTime()).filter((t): t is number => t !== undefined)
  return times.length ? Math.min(...times) : null
}

/** 服务启动时调用：把上次进程退出时还「在跑」的记录收尾，然后装上所有定时 */
export async function startScheduler(): Promise<void> {
  const d = db()
  d.update(schema.automationRuns)
    .set({ status: 'failed', finishedAt: Date.now(), output: '[automedia] 服务重启，这次执行被中断了\n' })
    .where(eq(schema.automationRuns.status, 'running'))
    .run()
  if (!automationEnabled()) return
  for (const row of d.select().from(schema.automations).all()) reschedule(toAutomation(row))
  await refreshClock()
  setInterval(() => void refreshClock().catch(() => {}), 30 * 60 * 1000).unref()
}

export function stopScheduler(): void {
  for (const id of [...jobs.keys()]) unschedule(id)
}
