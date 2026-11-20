import { rankBySimilarity, type MediaListItem } from '@automedia/shared'

/** 已经导入过东西的媒体不参与自动匹配（漫画：有页面的集；其他：有视频） */
export const hasImports = (m: MediaListItem) => m.videoCount > 0

/**
 * 「导入到」下拉框的选项：按和来源名（种子标题）的 Levenshtein 相似度排序，
 * 已经导入过的排在最后。top = 最像的那个（没有可比较的就是 null）。
 */
export function rankedMediaOptions(sourceName: string, list: MediaListItem[]) {
  const ranked = rankBySimilarity(sourceName, list, hasImports)
  return {
    options: ranked.map(({ item: m, score }) => ({
      value: m.id,
      label: `${m.title}${m.year ? ` (${m.year})` : ''}`,
      hint: score < 0 ? '已导入过' : `${Math.round(score * 100)}%`,
    })),
    top: ranked[0] && ranked[0].score > 0 ? ranked[0] : null,
  }
}
