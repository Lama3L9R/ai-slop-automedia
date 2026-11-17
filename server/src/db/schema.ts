import type { AutomationTrigger } from '@automedia/shared'
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
})

export const media = sqliteTable('media', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind').notNull().default('series'),
  title: text('title').notNull(),
  originalTitle: text('original_title').notNull().default(''),
  sortTitle: text('sort_title').notNull().default(''),
  year: integer('year'),
  premiered: text('premiered').notNull().default(''),
  status: text('status').notNull().default(''),
  overview: text('overview').notNull().default(''),
  rating: real('rating'),
  genres: text('genres', { mode: 'json' }).$type<string[]>().notNull(),
  studios: text('studios', { mode: 'json' }).$type<string[]>().notNull(),
  tvdbId: text('tvdb_id').notNull().default(''),
  tmdbId: text('tmdb_id').notNull().default(''),
  imdbId: text('imdb_id').notNull().default(''),
  posterUrl: text('poster_url').notNull().default(''),
  fanartUrl: text('fanart_url').notNull().default(''),
  libraryId: text('library_id').notNull().default(''),
  comicFormat: text('comic_format').notNull().default('images'),
  folderPath: text('folder_path').notNull().default(''),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const seasons = sqliteTable(
  'seasons',
  {
    mediaId: integer('media_id').notNull(),
    number: integer('number').notNull(),
    title: text('title').notNull().default(''),
    overview: text('overview').notNull().default(''),
    posterUrl: text('poster_url').notNull().default(''),
  },
  (t) => [primaryKey({ columns: [t.mediaId, t.number] })],
)

export const episodes = sqliteTable(
  'episodes',
  {
    mediaId: integer('media_id').notNull(),
    season: integer('season').notNull(),
    number: integer('number').notNull(),
    title: text('title').notNull().default(''),
    overview: text('overview').notNull().default(''),
    airDate: text('air_date').notNull().default(''),
    runtime: real('runtime'),
    stillUrl: text('still_url').notNull().default(''),
  },
  (t) => [primaryKey({ columns: [t.mediaId, t.season, t.number] })],
)

/** 本工具在媒体库里创建的每一个链接 / 拷贝 */
export const links = sqliteTable(
  'links',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    mediaId: integer('media_id').notNull(),
    season: integer('season').notNull(),
    episode: integer('episode').notNull(),
    kind: text('kind').notNull(),
    suffix: text('suffix').notNull().default(''),
    ext: text('ext').notNull(),
    sourceType: text('source_type').notNull(),
    sourceRef: text('source_ref').notNull(),
    sourceName: text('source_name').notNull().default(''),
    sourcePath: text('source_path').notNull(),
    targetPath: text('target_path').notNull(),
    linkMode: text('link_mode').notNull(),
    /** 漫画页在这一集里的顺序，从 1 开始；其他类型恒为 0 */
    position: integer('position').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('links_target_idx').on(t.targetPath),
    index('links_media_idx').on(t.mediaId),
    index('links_source_idx').on(t.sourceType, t.sourceRef),
  ],
)

/** 本工具生成的 NFO / 图片，用来在元数据变更后清理过期文件 */
export const artifacts = sqliteTable('artifacts', {
  path: text('path').primaryKey(),
  mediaId: integer('media_id').notNull(),
  sourceUrl: text('source_url').notNull().default(''),
})

/** 自动化脚本 */
export const automations = sqliteTable('automations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  source: text('source').notNull().default('inline'),
  content: text('content').notNull().default(''),
  filePath: text('file_path').notNull().default(''),
  interpreter: text('interpreter').notNull().default(''),
  cwd: text('cwd').notNull().default(''),
  env: text('env', { mode: 'json' }).$type<{ key: string; value: string }[]>().notNull(),
  triggers: text('triggers', { mode: 'json' }).$type<AutomationTrigger[]>().notNull(),
  manual: integer('manual', { mode: 'boolean' }).notNull().default(false),
  timeoutSec: integer('timeout_sec').notNull().default(3600),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const automationRuns = sqliteTable(
  'automation_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    automationId: integer('automation_id').notNull(),
    trigger: text('trigger').notNull(),
    status: text('status').notNull(),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
    exitCode: integer('exit_code'),
    output: text('output').notNull().default(''),
  },
  (t) => [index('automation_runs_idx').on(t.automationId)],
)

/** 种子的导入状态（只存在本工具里，不改 qB） */
export const torrents = sqliteTable('torrents', {
  hash: text('hash').primaryKey(),
  name: text('name').notNull().default(''),
  state: text('state').notNull().default('new'),
  updatedAt: integer('updated_at').notNull(),
})
