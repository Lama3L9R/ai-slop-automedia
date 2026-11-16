import { extOf, formatSize, pad2, type AiSuggestResult, type MediaDetail } from '@automedia/shared'
import { AppError, badRequest, errMsg } from '../errors'
import { getMediaDetail } from '../media/store'
import { getSettings } from '../settings'
import { extFetch } from '../util/http'

type Vars = Record<string, string | number | null | undefined>

/** 把模版里的 ${name} 换成变量值；不认识的变量原样保留。单遍替换，文件名里的 ${} 不会被二次展开。 */
export function render(tpl: string, vars: Vars): string {
  return tpl.replace(/\$\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k] ?? '') : m))
}

/** 输出格式固定由程序规定（不放进用户可编辑的模版），这样怎么改提示词都不会破坏解析 */
export const SYSTEM_PROMPT = `你是一个媒体文件整理助手。用户会给出一份文件列表（每行开头方括号里的数字是文件序号）和整理规则。
你只输出一个 JSON 对象，不要输出任何解释，不要使用 Markdown 代码块。格式：
{"items":[{"i":0,"s":1,"e":1,"tag":""}]}
- i：文件序号；s：季号（特别篇为 0）；e：集号；tag：字幕语言标签，视频文件留空字符串。
- 不需要导入的文件不要出现在 items 里。
- 每个文件最多出现一次。`

interface FileInput {
  index: number
  rel: string
  size: number
}

export function buildPrompt(detail: MediaDetail, task: 'video' | 'subtitle', files: FileInput[]): string {
  const ai = getSettings().ai
  const { media, seasons, episodes } = detail
  const mediaVars: Vars = {
    title: media.title,
    originalTitle: media.originalTitle,
    year: media.year,
    kind: media.kind,
    tvdbId: media.tvdbId,
    tmdbId: media.tmdbId,
    imdbId: media.imdbId,
    overview: media.overview,
    seasonCount: seasons.length,
    episodeCount: episodes.length,
  }
  const fileLines = files.map((f) => {
    const slash = f.rel.lastIndexOf('/')
    const line = render(ai.fileLine, {
      index: f.index,
      path: f.rel,
      dir: slash < 0 ? '' : f.rel.slice(0, slash),
      fileName: f.rel.slice(slash + 1),
      ext: extOf(f.rel),
      size: formatSize(f.size),
      sizeBytes: f.size,
    })
    return `[${f.index}] ${line}`
  })
  const episodeLines = episodes.map((e) =>
    render(ai.episodeLine, {
      season: e.season,
      episode: e.number,
      s: pad2(e.season),
      e: pad2(e.number),
      title: e.title,
      airDate: e.airDate,
      overview: e.overview,
      seasonTitle: seasons.find((s) => s.number === e.season)?.title ?? '',
    }),
  )
  return render(task === 'video' ? ai.videoPrompt : ai.subtitlePrompt, {
    ...mediaVars,
    media: render(ai.mediaTemplate, mediaVars),
    episodes: episodeLines.length ? episodeLines.join('\n') : '（没有已知剧集信息）',
    files: fileLines.join('\n'),
  })
}

/** 从模型输出里抠出 items：容忍 <think> 块、代码围栏、前后多余文字 */
export function parseItems(content: string, validIndexes: Set<number>): AiSuggestResult['items'] {
  const text = content.replace(/<think>[\s\S]*?<\/think>/g, '')
  const start = text.search(/[{[]/)
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
  if (start < 0 || end <= start) throw new AppError(502, '模型没有返回 JSON')
  let data: unknown
  try {
    data = JSON.parse(text.slice(start, end + 1))
  } catch {
    throw new AppError(502, '模型返回的 JSON 无法解析')
  }
  const list = Array.isArray(data) ? data : (data as { items?: unknown }).items
  if (!Array.isArray(list)) throw new AppError(502, '模型返回的 JSON 里没有 items 数组')

  const isIdx = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
  const out = new Map<number, AiSuggestResult['items'][number]>()
  for (const row of list as Record<string, unknown>[]) {
    if (!row || typeof row !== 'object') continue
    const { i, s, e, tag } = row
    if (!isIdx(i) || !isIdx(s) || !isIdx(e) || !validIndexes.has(i) || out.has(i)) continue
    const suffix = typeof tag === 'string' && /^[\w.\-&+]*$/.test(tag.trim()) ? tag.trim() : ''
    out.set(i, { index: i, season: s, episode: e, suffix })
  }
  return [...out.values()]
}

export async function suggest(input: {
  mediaId: number
  task: 'video' | 'subtitle'
  files: FileInput[]
  dryRun: boolean
}): Promise<AiSuggestResult> {
  const prompt = buildPrompt(getMediaDetail(input.mediaId), input.task, input.files)
  if (input.dryRun) return { system: SYSTEM_PROMPT, prompt, raw: '', items: [] }

  const ai = getSettings().ai
  if (!ai.baseUrl.trim() || !ai.model.trim()) throw badRequest('还没有配置 AI 接口地址和模型（设置 → AI）')
  const url = ai.baseUrl.trim().replace(/\/+$/, '') + '/chat/completions'
  const post = (jsonMode: boolean) =>
    extFetch(url, {
      method: 'POST',
      timeoutMs: 180_000,
      headers: {
        'content-type': 'application/json',
        ...(ai.apiKey.trim() ? { authorization: `Bearer ${ai.apiKey.trim()}` } : {}),
      },
      body: JSON.stringify({
        model: ai.model.trim(),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
    })

  let res
  try {
    res = await post(ai.jsonMode)
    // 不是所有兼容接口都支持 response_format，被拒绝时去掉重试一次
    if (res.status === 400 && ai.jsonMode) res = await post(false)
  } catch (e) {
    throw new AppError(502, `调用 AI 接口失败：${errMsg(e)}`)
  }
  const body = await res.text()
  if (!res.ok) throw new AppError(502, `AI 接口返回 HTTP ${res.status}：${body.slice(0, 300)}`)
  let raw: string
  try {
    const content = (JSON.parse(body) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message
      ?.content
    if (typeof content !== 'string' || !content.trim()) throw new Error('empty')
    raw = content
  } catch {
    throw new AppError(502, `AI 接口返回的内容不是标准的 chat completion：${body.slice(0, 300)}`)
  }
  return {
    system: SYSTEM_PROMPT,
    prompt,
    raw,
    items: parseItems(raw, new Set(input.files.map((f) => f.index))),
  }
}
