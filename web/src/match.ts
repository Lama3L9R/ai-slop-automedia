import { rankBySimilarity, type MediaListItem } from '@automedia/shared'

/**
 * 已经完全导入的媒体不参与自动匹配：至少有一集，并且没有空着（还没导入）的集。
 * 只导入了一部分的（比如漫画一本一个种子，先建好了 N 集只导入了第 1 本）照常参与。
 */
export const fullyImported = (m: MediaListItem) => m.episodeCount > 0 && m.missingCount === 0

/**
 * 「导入到」下拉框的选项：按和来源名（种子标题）的 Levenshtein 相似度排序，
 * 已经完全导入的排在最后。top = 最像的那个（没有可比较的就是 null）。
 */
export function rankedMediaOptions(sourceName: string, list: MediaListItem[]) {
  const ranked = rankBySimilarity(sourceName, list, fullyImported)
  return {
    options: ranked.map(({ item: m, score }) => ({
      value: m.id,
      label: `${m.title}${m.year ? ` (${m.year})` : ''}`,
      hint: score < 0 ? '已全部导入' : `${Math.round(score * 100)}%`,
    })),
    top: ranked[0] && ranked[0].score > 0 ? ranked[0] : null,
  }
}
