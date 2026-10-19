export type ArticleMetadataLine = {label: string; value: string}

export const getArticleMetadataLineText = (line: ArticleMetadataLine) => {
  return `${line.label}: ${line.value}`
}

export const getArticleMetadataLinesText = (lines: readonly ArticleMetadataLine[]) => {
  return lines.map(getArticleMetadataLineText).join('\n')
}
