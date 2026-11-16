import type { Episode, LookupBy, MediaInput, MediaKind, ProviderSearchResult, Season } from '@automedia/shared'

export interface ProviderMedia {
  media: Omit<MediaInput, 'libraryId' | 'comicFormat'>
  seasons: Season[]
  episodes: Episode[]
}

/**
 * 元数据来源。Media 的数据结构对所有类型统一（Media → Season → Episode），
 * provider 只负责把上游数据翻译成这个结构；拉下来之后用户可以随意修改。
 * 新增来源（TVDB、Bangumi…）只需实现这个接口并在 providers/index.ts 注册。
 */
export interface MetadataProvider {
  id: string
  label: string
  /** 支持的查找方式 */
  lookups: LookupBy[]
  search(kind: MediaKind, by: LookupBy, query: string): Promise<ProviderSearchResult[]>
  fetch(kind: MediaKind, id: string): Promise<ProviderMedia>
  /** 已有 Media 刷新时，从它的外部 ID 推出本 provider 的 id；推不出返回 null */
  resolveId(media: Pick<MediaInput, 'kind' | 'tvdbId' | 'tmdbId' | 'imdbId'>): Promise<string | null>
}
