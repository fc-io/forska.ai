const getArticleCountLabel = (count: number) => {
  return count === 1 ? '1 article' : `${count.toLocaleString()} articles`
}

export const getCompareProjectExportCountLabel = (count: number | null) => {
  return count === null ? 'Counting articles…' : getArticleCountLabel(count)
}
