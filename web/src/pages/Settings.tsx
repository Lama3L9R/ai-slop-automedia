import {
  DEFAULT_EPISODE_LINE,
  DEFAULT_FILE_LINE,
  DEFAULT_MEDIA_TEMPLATE,
  DEFAULT_SUBTITLE_PROMPT,
  DEFAULT_VIDEO_PROMPT,
  SettingsSchema,
  type Settings,
} from '@automedia/shared'
import { For, Show, createResource, createSignal } from 'solid-js'
import { createStore, reconcile, unwrap } from 'solid-js/store'
import { api } from '../api'
import { Field, PathInput, Section, toast, useAction } from '../ui'

function Template(props: {
  label: string
  hint: string
  value: string
  rows: number
  fallback: string
  onChange: (v: string) => void
}) {
  return (
    <div class="mb-4">
      <div class="mb-1 flex items-center justify-between">
        <span class="label mb-0">{props.label}</span>
        <button type="button" class="btn btn-sm" onClick={() => props.onChange(props.fallback)}>
          恢复默认
        </button>
      </div>
      <textarea
        class="input font-mono text-xs"
        rows={props.rows}
        value={props.value}
        onInput={(e) => props.onChange(e.currentTarget.value)}
      />
      <p class="mt-1 text-xs text-slate-400">{props.hint}</p>
    </div>
  )
}

export default function SettingsPage() {
  const [s, setS] = createStore<Settings>(SettingsSchema.parse({}))
  const [loaded] = createResource(async () => {
    setS(reconcile(await api<Settings>('/settings')))
    return true
  })
  const [categories, setCategories] = createSignal<string | null>(null)
  const categoriesText = () => categories() ?? s.qb.categories.join(', ')

  const [save, saving] = useAction(async () => {
    const body = structuredClone(unwrap(s))
    body.qb.categories = categoriesText()
      .split(/[,，]/)
      .map((c) => c.trim())
      .filter(Boolean)
    body.libraries = body.libraries.filter((l) => l.name.trim() && l.path.trim())
    body.pathMappings = body.pathMappings.filter((m) => m.from.trim())
    setS(reconcile(await api<Settings>('/settings', { method: 'PUT', body })))
    setCategories(null)
    toast.ok('设置已保存')
  })
  const [testQb, testing] = useAction(async () => {
    await save()
    const { version } = await api<{ version: string }>('/settings/test-qb', { method: 'POST' })
    toast.ok(`已连接 qBittorrent ${version}`)
  })

  return (
    <Show when={loaded()} fallback={<p class="text-slate-400">加载中…</p>}>
      <div class="mb-4 flex items-center justify-between">
        <h1 class="text-lg font-semibold">设置</h1>
        <button class="btn btn-primary" disabled={saving()} onClick={() => void save()}>
          保存设置
        </button>
      </div>

      <Section title="媒体库" desc="Emby 媒体库的根目录。每个 Media 归属其中一个，导入时在这下面按 Emby 规则建目录。">
        <For each={s.libraries} fallback={<p class="mb-3 text-slate-400">还没有媒体库，导入前至少要加一个。</p>}>
          {(lib, i) => (
            <div class="mb-2 flex gap-2">
              <input
                class="input w-40 shrink-0"
                placeholder="名称，如 动画"
                value={lib.name}
                onInput={(e) => setS('libraries', i(), 'name', e.currentTarget.value)}
              />
              <div class="flex-1">
                <PathInput
                  value={lib.path}
                  placeholder="/Volumes/Media/Anime"
                  onChange={(v) => setS('libraries', i(), 'path', v)}
                />
              </div>
              <button
                class="btn btn-danger"
                onClick={() => setS('libraries', (list) => list.filter((_, j) => j !== i()))}
              >
                移除
              </button>
            </div>
          )}
        </For>
        <button
          class="btn"
          onClick={() =>
            setS('libraries', (list) => [...list, { id: crypto.randomUUID().slice(0, 8), name: '', path: '' }])
          }
        >
          ＋ 添加媒体库
        </button>
      </Section>

      <Section title="导入">
        <div class="grid gap-4 sm:grid-cols-2">
          <Field label="默认链接方式" hint="符号链接可以跨磁盘；硬链接必须同一个卷；拷贝在 APFS 同卷上是瞬间完成的克隆。">
            <select
              class="input"
              value={s.defaultLinkMode}
              onChange={(e) => setS('defaultLinkMode', e.currentTarget.value as Settings['defaultLinkMode'])}
            >
              <option value="symlink">符号链接（symlink）</option>
              <option value="hardlink">硬链接（hardlink）</option>
              <option value="copy">拷贝（copy）</option>
            </select>
          </Field>
          <Field label="字幕存放目录" hint="上传的字幕压缩包解压到这里，再链接进媒体库。">
            <PathInput value={s.subtitleDir} placeholder="/Volumes/Media/Subtitles" onChange={(v) => setS('subtitleDir', v)} />
          </Field>
        </div>
      </Section>

      <Section
        title="qBittorrent"
        actions={
          <button class="btn" disabled={testing()} onClick={() => void testQb()}>
            保存并测试连接
          </button>
        }
      >
        <div class="grid gap-4 sm:grid-cols-3">
          <Field label="WebUI 地址">
            <input class="input" value={s.qb.url} onInput={(e) => setS('qb', 'url', e.currentTarget.value)} />
          </Field>
          <Field label="用户名">
            <input class="input" value={s.qb.username} onInput={(e) => setS('qb', 'username', e.currentTarget.value)} />
          </Field>
          <Field label="密码">
            <input
              class="input"
              type="password"
              autocomplete="new-password"
              value={s.qb.password}
              onInput={(e) => setS('qb', 'password', e.currentTarget.value)}
            />
          </Field>
        </div>
        <Field class="mt-4" label="只显示这些分类" hint="多个分类用逗号分隔；留空显示全部。">
          <input class="input" value={categoriesText()} placeholder="anime, tv" onInput={(e) => setCategories(e.currentTarget.value)} />
        </Field>
        <div class="mt-4">
          <span class="label">路径映射（qB 看到的路径 → 本机路径）</span>
          <p class="mb-2 text-xs text-slate-400">qB 和 automedia 在同一台机器上直接运行时不需要填。</p>
          <For each={s.pathMappings}>
            {(m, i) => (
              <div class="mb-2 flex items-center gap-2">
                <input
                  class="input font-mono"
                  placeholder="/downloads"
                  value={m.from}
                  onInput={(e) => setS('pathMappings', i(), 'from', e.currentTarget.value)}
                />
                <span>→</span>
                <input
                  class="input font-mono"
                  placeholder="/Volumes/Data/downloads"
                  value={m.to}
                  onInput={(e) => setS('pathMappings', i(), 'to', e.currentTarget.value)}
                />
                <button class="btn btn-danger" onClick={() => setS('pathMappings', (l) => l.filter((_, j) => j !== i()))}>
                  移除
                </button>
              </div>
            )}
          </For>
          <button class="btn" onClick={() => setS('pathMappings', (l) => [...l, { from: '', to: '' }])}>
            ＋ 添加映射
          </button>
        </div>
      </Section>

      <Section title="元数据" desc="上游数据只用来快速填表，拉下来之后所有字段都可以改。最终写给 Emby 的是本工具生成的 NFO。">
        <div class="grid gap-4 sm:grid-cols-3">
          <Field class="sm:col-span-2" label="TMDB API Key" hint="v3 的 API Key 或 v4 的 Read Access Token 都可以。">
            <input class="input font-mono" value={s.tmdb.apiKey} onInput={(e) => setS('tmdb', 'apiKey', e.currentTarget.value)} />
          </Field>
          <Field label="元数据语言">
            <input class="input" value={s.tmdb.language} onInput={(e) => setS('tmdb', 'language', e.currentTarget.value)} />
          </Field>
          <Field class="sm:col-span-2" label="HTTP 代理" hint="访问 TMDB、AI 接口和下载图片时使用；留空直连。">
            <input
              class="input font-mono"
              placeholder="http://127.0.0.1:7890"
              value={s.proxyUrl}
              onInput={(e) => setS('proxyUrl', e.currentTarget.value)}
            />
          </Field>
          <label class="flex items-center gap-2 self-end pb-2">
            <input type="checkbox" checked={s.nfo.lockData} onChange={(e) => setS('nfo', 'lockData', e.currentTarget.checked)} />
            <span>NFO 中锁定元数据，不让 Emby 用在线数据覆盖</span>
          </label>
        </div>
      </Section>

      <Section title="AI 自动匹配" desc="任意兼容 OpenAI chat completions 的接口。AI 只负责在导入向导里填表，结果由你检查后再执行。">
        <div class="grid gap-4 sm:grid-cols-3">
          <Field label="API URL" hint="填到 /v1 这一级，不含 /chat/completions。">
            <input class="input font-mono" value={s.ai.baseUrl} onInput={(e) => setS('ai', 'baseUrl', e.currentTarget.value)} />
          </Field>
          <Field label="API Key">
            <input
              class="input font-mono"
              type="password"
              autocomplete="new-password"
              value={s.ai.apiKey}
              onInput={(e) => setS('ai', 'apiKey', e.currentTarget.value)}
            />
          </Field>
          <Field label="模型">
            <input class="input font-mono" value={s.ai.model} onInput={(e) => setS('ai', 'model', e.currentTarget.value)} />
          </Field>
        </div>
        <label class="mt-3 mb-4 flex items-center gap-2">
          <input type="checkbox" checked={s.ai.jsonMode} onChange={(e) => setS('ai', 'jsonMode', e.currentTarget.checked)} />
          <span>请求 JSON 模式（response_format）。接口不支持时会自动去掉重试。</span>
        </label>

        <p class="mb-3 rounded bg-slate-50 p-2 text-xs text-slate-500">
          提示词由三个「行模版」拼进一个总模版。输出格式由程序固定规定，不在模版里，所以怎么改都不会影响结果解析；
          每个文件行前面会自动加上 <code>[序号]</code>。在向导里可以用「预览提示词」看最终效果。
        </p>
        <Template
          label="文件行模版（每个文件一行）"
          rows={2}
          value={s.ai.fileLine}
          fallback={DEFAULT_FILE_LINE}
          onChange={(v) => setS('ai', 'fileLine', v)}
          hint="可用变量：${path} 相对路径  ${fileName}  ${dir}  ${ext}  ${size}  ${sizeBytes}  ${index}"
        />
        <Template
          label="剧集行模版（Media 里每个已知的集一行）"
          rows={2}
          value={s.ai.episodeLine}
          fallback={DEFAULT_EPISODE_LINE}
          onChange={(v) => setS('ai', 'episodeLine', v)}
          hint="可用变量：${season} ${episode}  ${s} ${e}（补零）  ${title}  ${airDate}  ${overview}  ${seasonTitle}"
        />
        <Template
          label="作品信息模版"
          rows={4}
          value={s.ai.mediaTemplate}
          fallback={DEFAULT_MEDIA_TEMPLATE}
          onChange={(v) => setS('ai', 'mediaTemplate', v)}
          hint="可用变量：${title} ${originalTitle} ${year} ${kind} ${tvdbId} ${tmdbId} ${imdbId} ${overview} ${seasonCount} ${episodeCount}"
        />
        <Template
          label="视频匹配提示词"
          rows={16}
          value={s.ai.videoPrompt}
          fallback={DEFAULT_VIDEO_PROMPT}
          onChange={(v) => setS('ai', 'videoPrompt', v)}
          hint="可用变量：${files} 全部文件行  ${episodes} 全部剧集行  ${media} 作品信息  以及作品信息模版里的所有变量"
        />
        <Template
          label="字幕匹配提示词"
          rows={14}
          value={s.ai.subtitlePrompt}
          fallback={DEFAULT_SUBTITLE_PROMPT}
          onChange={(v) => setS('ai', 'subtitlePrompt', v)}
          hint="变量同上。"
        />
      </Section>

      <div class="flex justify-end">
        <button class="btn btn-primary" disabled={saving()} onClick={() => void save()}>
          保存设置
        </button>
      </div>
    </Show>
  )
}
