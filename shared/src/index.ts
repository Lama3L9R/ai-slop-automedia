import { z } from 'zod'

// ───────────────────────── enums ─────────────────────────

export const LinkMode = z.enum(['symlink', 'hardlink', 'copy'])
export type LinkMode = z.infer<typeof LinkMode>

/** series = Emby 剧集目录结构；movie = Emby 电影目录结构。数据结构完全相同（Media → Season → Episode）。 */
export const MediaKind = z.enum(['series', 'movie'])
export type MediaKind = z.infer<typeof MediaKind>

export const FileKind = z.enum(['video', 'subtitle', 'audio'])
export type FileKind = z.infer<typeof FileKind>

export const TorrentState = z.enum(['new', 'imported', 'ignored'])
export type TorrentState = z.infer<typeof TorrentState>

export const SourceType = z.enum(['torrent', 'dir'])
export type SourceType = z.infer<typeof SourceType>

export const ExistingMode = z.enum(['skip', 'safe', 'force'])
export type ExistingMode = z.infer<typeof ExistingMode>

// ───────────────────────── AI 默认模版 ─────────────────────────

export const DEFAULT_FILE_LINE = '${path} | ${size}'
export const DEFAULT_EPISODE_LINE = 'S${s}E${e} | ${title} | ${airDate}'
export const DEFAULT_MEDIA_TEMPLATE =
  '标题：${title}\n原名：${originalTitle}\n年份：${year}\nTVDB：${tvdbId}  TMDB：${tmdbId}'

export const DEFAULT_VIDEO_PROMPT = `下面是一个下载目录中的视频文件列表，请把它们匹配到《\${title}》的季和集。

规则：
- 只导入正片本体，以及 OVA / OAD / SP 等有实际内容的特别篇。
- 忽略 Menu、OP / ED（含 NCOP / NCED）、PV、CM、Trailer、Preview、访谈、Sample 等。
- 正片按文件名中的集号匹配。
- 特别篇放入第 0 季，集号优先对照下方「已知剧集」，对不上就从 1 开始顺延。
- 目录结构或文件名能看出是第 N 季时使用对应季号，无法判断时默认第 1 季。
- 拿不准的文件宁可忽略。

作品信息：
\${media}

已知剧集：
\${episodes}

文件列表（每行一个，方括号内是文件序号）：
\${files}`

export const DEFAULT_SUBTITLE_PROMPT = `下面是一批字幕文件，请把它们匹配到《\${title}》的季和集，并给出语言标签。

规则：
- 按文件名中的集号匹配，季号判断方式与视频相同；特别篇放入第 0 季。
- 语言标签 tag：简体 chs，繁体 cht，日文 jpn，英文 eng；简日双语用 chs，繁日双语用 cht；看不出来就留空字符串。
- 字体文件、说明文档等非字幕内容忽略。

作品信息：
\${media}

已知剧集：
\${episodes}

文件列表（每行一个，方括号内是文件序号）：
\${files}`

// ───────────────────────── settings ─────────────────────────

export const LibrarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
})
export type Library = z.infer<typeof LibrarySchema>

export const SettingsSchema = z.object({
  /** Emby 媒体库根目录，可以有多个（动画 / 电影 / …） */
  libraries: z.array(LibrarySchema).default([]),
  defaultLinkMode: LinkMode.default('symlink'),
  /** 上传的字幕解压后存放的位置 */
  subtitleDir: z.string().default(''),
  qb: z
    .object({
      url: z.string().default('http://127.0.0.1:8080'),
      username: z.string().default(''),
      password: z.string().default(''),
      /** 只显示这些分类下的种子；留空 = 全部 */
      categories: z.array(z.string()).default([]),
    })
    .prefault({}),
  /** qB 报告的路径前缀 → 本机实际路径前缀（同机部署一般不需要） */
  pathMappings: z.array(z.object({ from: z.string(), to: z.string() })).default([]),
  tmdb: z
    .object({
      apiKey: z.string().default(''),
      language: z.string().default('zh-CN'),
    })
    .prefault({}),
  /** 访问 TMDB / AI / 图片时使用的 HTTP 代理，留空 = 直连 */
  proxyUrl: z.string().default(''),
  nfo: z
    .object({
      /** 写入 <lockdata>true</lockdata>，阻止 Emby 用在线数据覆盖 */
      lockData: z.boolean().default(true),
    })
    .prefault({}),
  ai: z
    .object({
      baseUrl: z.string().default('https://api.openai.com/v1'),
      apiKey: z.string().default(''),
      model: z.string().default(''),
      jsonMode: z.boolean().default(true),
      fileLine: z.string().default(DEFAULT_FILE_LINE),
      episodeLine: z.string().default(DEFAULT_EPISODE_LINE),
      mediaTemplate: z.string().default(DEFAULT_MEDIA_TEMPLATE),
      videoPrompt: z.string().default(DEFAULT_VIDEO_PROMPT),
      subtitlePrompt: z.string().default(DEFAULT_SUBTITLE_PROMPT),
    })
    .prefault({}),
})
export type Settings = z.infer<typeof SettingsSchema>

// ───────────────────────── media ─────────────────────────

const int = z.number().int()

export const MediaInput = z.object({
  kind: MediaKind.default('series'),
  title: z.string().trim().min(1, '标题不能为空'),
  originalTitle: z.string().default(''),
  sortTitle: z.string().default(''),
  year: int.nullable().default(null),
  premiered: z.string().default(''),
  status: z.string().default(''),
  overview: z.string().default(''),
  rating: z.number().nullable().default(null),
  genres: z.array(z.string()).default([]),
  studios: z.array(z.string()).default([]),
  tvdbId: z.string().default(''),
  tmdbId: z.string().default(''),
  imdbId: z.string().default(''),
  posterUrl: z.string().default(''),
  fanartUrl: z.string().default(''),
  libraryId: z.string().default(''),
})
export type MediaInput = z.infer<typeof MediaInput>

export const SeasonInput = z.object({
  number: int.min(0),
  title: z.string().default(''),
  overview: z.string().default(''),
  posterUrl: z.string().default(''),
})
export type Season = z.infer<typeof SeasonInput>

export const EpisodeInput = z.object({
  season: int.min(0),
  number: int.min(0),
  title: z.string().default(''),
  overview: z.string().default(''),
  airDate: z.string().default(''),
  runtime: z.number().nullable().default(null),
  stillUrl: z.string().default(''),
})
export type Episode = z.infer<typeof EpisodeInput>

/** 保存 Media 时整体提交：季和集是「整表替换」语义 */
export const MediaSaveInput = z.object({
  media: MediaInput,
  seasons: z.array(SeasonInput).default([]),
  episodes: z.array(EpisodeInput).default([]),
})
export type MediaSaveInput = z.infer<typeof MediaSaveInput>

export interface Media extends MediaInput {
  id: number
  /** 上次同步到磁盘时的目录（空 = 尚未落盘） */
  folderPath: string
  createdAt: number
  updatedAt: number
}

export interface MediaListItem extends Media {
  episodeCount: number
  videoCount: number
}

export interface Link {
  id: number
  mediaId: number
  season: number
  episode: number
  kind: FileKind
  /** 字幕 / 外挂音轨的语言标签，如 chs */
  suffix: string
  ext: string
  sourceType: SourceType
  sourceRef: string
  sourceName: string
  sourcePath: string
  targetPath: string
  linkMode: LinkMode
  createdAt: number
}

export interface MediaDetail {
  media: Media
  seasons: Season[]
  episodes: Episode[]
  links: Link[]
}

// ───────────────────────── provider ─────────────────────────

export const LookupBy = z.enum(['name', 'tvdb', 'tmdb', 'imdb'])
export type LookupBy = z.infer<typeof LookupBy>

export interface ProviderSearchResult {
  provider: string
  kind: MediaKind
  id: string
  title: string
  originalTitle: string
  year: number | null
  overview: string
  posterUrl: string
}

export const FromProviderInput = z.object({
  provider: z.string().default('tmdb'),
  kind: MediaKind,
  id: z.string().min(1),
  libraryId: z.string().default(''),
})

export const RefreshInput = z.object({
  /** fill = 只补全空字段和缺失的季/集；overwrite = 用上游数据覆盖 */
  mode: z.enum(['fill', 'overwrite']).default('fill'),
})

// ───────────────────────── sources ─────────────────────────

export interface TorrentItem {
  hash: string
  name: string
  category: string
  tags: string
  size: number
  progress: number
  qbState: string
  addedOn: number
  /** 映射后的本机路径 */
  contentPath: string
  state: TorrentState
  /** 已经从这个种子导入过的 Media */
  importedTo: { id: number; title: string; count: number }[]
}

export interface TreeNode {
  name: string
  /** 绝对路径 */
  path: string
  /** 相对来源根目录的路径，用 / 分隔 */
  rel: string
  isDir: boolean
  size: number
  kind: FileKind | null
  children?: TreeNode[]
}

export interface SourceTree {
  type: SourceType
  ref: string
  name: string
  root: string
  nodes: TreeNode[]
  /** 这个来源下已经导入过的文件 */
  links: (Link & { mediaTitle: string })[]
}

export const TorrentStateInput = z.object({
  state: TorrentState,
  name: z.string().default(''),
})

// ───────────────────────── import ─────────────────────────

export const ImportItem = z.object({
  path: z.string().min(1),
  season: int.min(0),
  episode: int.min(0),
  kind: FileKind,
  suffix: z
    .string()
    .trim()
    .regex(/^[\w.\-&+]*$/, '语言标签只能包含字母、数字和 . - _ & +')
    .default(''),
})
export type ImportItem = z.infer<typeof ImportItem>

export const ImportRequest = z.object({
  mediaId: int,
  linkMode: LinkMode,
  sourceType: SourceType,
  sourceRef: z.string(),
  sourceName: z.string().default(''),
  items: z.array(ImportItem).min(1, '没有要导入的文件'),
  /** 执行前先移除「这个来源 → 这个 Media」此前导入的全部链接（重新导入） */
  replaceSource: z.boolean().default(false),
  /** 来源是种子时，导入成功后标记为已导入 */
  markImported: z.boolean().default(true),
  /**
   * 媒体库里已经有这一集的文件、且不是本工具创建的（Sonarr 导入的、手动放的）时怎么办：
   * - skip：不动它，这个文件不导入
   * - safe：只在确定不会丢数据时替换（已有文件是链接，或与源文件大小相同的副本）
   * - force：一律替换
   */
  existing: ExistingMode.default('safe'),
})
export type ImportRequest = z.infer<typeof ImportRequest>

export interface PlanItem {
  path: string
  season: number
  episode: number
  kind: FileKind
  suffix: string
  target: string
  /** ok = 新建；replace = 会替换已有的文件 / 链接；error = 无法导入 */
  status: 'ok' | 'replace' | 'error'
  message: string
  /** 会被删除的、不是本工具创建的已有文件（当前磁盘上的路径） */
  removes: string[]
}

export interface ImportPlan {
  items: PlanItem[]
  /** 媒体库里已有这部作品的目录（如 Sonarr 建的）：导入时会接管它并改成本工具的命名 */
  adopt: { from: string; to: string } | null
}

export interface ImportResult {
  items: (PlanItem & { done: boolean })[]
  warnings: string[]
}

// ───────────────────────── AI ─────────────────────────

export const AiSuggestInput = z.object({
  mediaId: int,
  task: z.enum(['video', 'subtitle']),
  files: z
    .array(z.object({ index: int, rel: z.string(), size: z.number() }))
    .min(1, '没有可供匹配的文件'),
  /** 只渲染提示词，不调用模型 */
  dryRun: z.boolean().default(false),
})

export interface AiSuggestResult {
  system: string
  prompt: string
  raw: string
  items: { index: number; season: number; episode: number; suffix: string }[]
}

// ───────────────────────── 纯函数工具 ─────────────────────────

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
/** 自然排序：2 排在 10 前面 */
export const naturalCompare = (a: string, b: string) => collator.compare(a, b)

const VIDEO_EXT = new Set(['mkv', 'mp4', 'm4v', 'm2ts', 'ts', 'avi', 'mov', 'wmv', 'webm', 'flv', 'rmvb', 'mpg', 'mpeg', 'iso'])
const SUBTITLE_EXT = new Set(['ass', 'ssa', 'srt', 'sup', 'vtt', 'smi', 'sub', 'idx'])
const AUDIO_EXT = new Set(['mka', 'flac', 'ac3', 'eac3', 'dts', 'aac', 'm4a', 'mp3', 'wav', 'opus'])

export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase()
}

export function fileKindOf(name: string): FileKind | null {
  const ext = extOf(name)
  if (VIDEO_EXT.has(ext)) return 'video'
  if (SUBTITLE_EXT.has(ext)) return 'subtitle'
  if (AUDIO_EXT.has(ext)) return 'audio'
  return null
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const v = bytes / 1024 ** i
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(v >= 10 ? 1 : 2)} ${units[i]}`
}

export const pad2 = (n: number) => String(n).padStart(2, '0')

const SUFFIX_RULES: [RegExp, string][] = [
  [/^(chs|sc|gb|gbk|zh-?hans|zh-?cn|简体|简中|简|jpsc|scjp|chs_jpn|sc_jp)$/, 'chs'],
  [/^(cht|tc|big5|zh-?hant|zh-?tw|zh-?hk|繁体|繁中|繁|jptc|tcjp|cht_jpn|tc_jp)$/, 'cht'],
  [/^(jpn|jp|ja|jap|日文|日语)$/, 'jpn'],
  [/^(eng|en|英文|英语)$/, 'eng'],
]

/** 从字幕文件名猜语言标签（Movie.sc.ass / [CHS] / .zh-Hans. …），猜不到返回空串 */
export function guessSubtitleSuffix(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').toLowerCase()
  // 从后往前找：语言标记通常在文件名末尾
  const tokens = base.split(/[.\[\]()\s&+,]+/).filter(Boolean).reverse()
  for (const t of tokens) {
    for (const [re, suffix] of SUFFIX_RULES) if (re.test(t)) return suffix
  }
  return ''
}
