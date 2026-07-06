export type ReviewServingContributionComponentKind = 'badge' | 'count' | 'facet' | 'posting' | 'queue'

export type ReviewServingContributionRow = {articleId: string; contributionKey: string; contributionValue: number}

export type ReviewServingContributionDiff = {contributionKey: string; delta: number}

const getContributionDiffsFromRows = (input: {
  newRows: readonly ReviewServingContributionRow[]
  oldRows: readonly ReviewServingContributionRow[]
}) => {
  const oldDeltas = input.oldRows.reduce<Map<string, number>>((result, row) => {
    result.set(row.contributionKey, (result.get(row.contributionKey) ?? 0) - row.contributionValue)

    return result
  }, new Map())
  const deltas = input.newRows.reduce<Map<string, number>>((result, row) => {
    result.set(row.contributionKey, (result.get(row.contributionKey) ?? 0) + row.contributionValue)

    return result
  }, oldDeltas)

  return [...deltas.entries()]
    .filter(([, delta]) => {
      return delta !== 0
    })
    .map(([contributionKey, delta]) => {
      return {contributionKey, delta}
    })
}

export const getReviewServingContributionDiffs = (input: {
  newRows: readonly ReviewServingContributionRow[]
  oldRows: readonly ReviewServingContributionRow[]
}) => {
  return getContributionDiffsFromRows(input)
}
