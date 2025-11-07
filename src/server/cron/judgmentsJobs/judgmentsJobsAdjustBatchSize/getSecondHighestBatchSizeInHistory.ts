export const getSecondHighestBatchSizeInHistory = (snapshots: {total: number}[], cur: number): number | null => {
  const totals = [
    ...snapshots.map((s) => {
      return s.total
    }),
    cur,
  ].filter((n) => {
    return Number(n) > 0
  })
  const uniqueDesc = Array.from(new Set(totals)).sort((a, b) => {
    return b - a
  })
  return uniqueDesc.length >= 2 ? (uniqueDesc[1] ?? null) : null
}
