export type CovidenceMatchTier = 'strong_identifier' | 'covidence_id' | 'reference_id' | 'title_year_first_author'
export type CovidenceBaseRouteMatchTier = Exclude<CovidenceMatchTier, 'strong_identifier'>
export type CovidenceCandidateMatchKeys = {
  covidenceIds: string[]
  referenceIds: string[]
  titleYearFirstAuthorHash: string | null
}
export type CovidenceBaseRouteMatchRecord = CovidenceCandidateMatchKeys & {articleId: string}
export type CovidenceBaseRouteMatchIndex = Record<CovidenceBaseRouteMatchTier, Map<string, string[]>>
export type CovidenceMatchResolution =
  | {articleId: string; matchTier: CovidenceMatchTier; status: 'matched'}
  | {articleIds: string[]; matchTier: CovidenceMatchTier; status: 'ambiguous'}
  | {status: 'unmatched'}
export type CovidenceRouteShare = {
  dataSourceId: string | null
  dataSourceTitle: string | null
  importRoute: string
  matchedRecordCount: number
  share: number
}
export type CovidenceSameReviewRecordSample = {
  articleIds: string[]
  articleKey: string
  covidenceIds: string[]
  matchTier: CovidenceMatchTier | null
  referenceIds: string[]
  title: string | null
}
export type CovidenceSameReviewMatchSummary = {
  ambiguous: CovidenceSameReviewRecordSample[]
  ambiguousCount: number
  baseImportRoute: string
  countsByTier: Record<CovidenceMatchTier, number>
  unmatched: CovidenceSameReviewRecordSample[]
  unmatchedCount: number
}
type CovidenceSameReviewSummaryInput = {
  articleKey: string
  keys: CovidenceCandidateMatchKeys
  resolution: CovidenceMatchResolution
  title: string | null
}

export const covidenceSameReviewSuggestionThreshold = 0.9
export const covidenceSameReviewListLimit = 500

const covidenceBaseRouteMatchTiers = [
  'covidence_id',
  'reference_id',
  'title_year_first_author',
] as const satisfies CovidenceBaseRouteMatchTier[]

const getUniqueSortedValues = (values: string[]) => {
  return Array.from(new Set(values)).sort((left, right) => {
    return left.localeCompare(right)
  })
}

const getCovidenceBaseRouteRecordTierKeys = (
  record: CovidenceCandidateMatchKeys,
  tier: CovidenceBaseRouteMatchTier,
) => {
  return tier === 'covidence_id'
    ? record.covidenceIds
    : tier === 'reference_id'
      ? record.referenceIds
      : record.titleYearFirstAuthorHash
        ? [record.titleYearFirstAuthorHash]
        : []
}

const appendCovidenceBaseRouteIndexValue = (index: Map<string, string[]>, key: string, articleId: string) => {
  const articleIds = index.get(key) ?? []

  if (!articleIds.includes(articleId)) {
    index.set(key, [...articleIds, articleId])
  }

  return index
}

export const getCovidenceBaseRouteMatchIndex = (
  records: CovidenceBaseRouteMatchRecord[],
): CovidenceBaseRouteMatchIndex => {
  return records.reduce<CovidenceBaseRouteMatchIndex>(
    (index, record) => {
      covidenceBaseRouteMatchTiers.map((tier) => {
        return getCovidenceBaseRouteRecordTierKeys(record, tier).map((key) => {
          return appendCovidenceBaseRouteIndexValue(index[tier], key, record.articleId)
        })
      })

      return index
    },
    {covidence_id: new Map(), reference_id: new Map(), title_year_first_author: new Map()},
  )
}

const getCovidenceTierArticleIds = (params: {
  excludedArticleIds: ReadonlySet<string>
  index: CovidenceBaseRouteMatchIndex
  keys: CovidenceCandidateMatchKeys
  tier: CovidenceBaseRouteMatchTier
}) => {
  return getUniqueSortedValues(
    getCovidenceBaseRouteRecordTierKeys(params.keys, params.tier)
      .flatMap((key) => {
        return params.index[params.tier].get(key) ?? []
      })
      .filter((articleId) => {
        return !params.excludedArticleIds.has(articleId)
      }),
  )
}

const getCovidenceTierResolution = (
  matchTier: CovidenceMatchTier,
  articleIds: string[],
): CovidenceMatchResolution | null => {
  return articleIds.length === 0
    ? null
    : articleIds.length === 1 && articleIds[0]
      ? {articleId: articleIds[0], matchTier, status: 'matched'}
      : {articleIds, matchTier, status: 'ambiguous'}
}

export const resolveCovidenceMatchTier = (params: {
  excludedArticleIds?: ReadonlySet<string>
  index: CovidenceBaseRouteMatchIndex
  keys: CovidenceCandidateMatchKeys
  strongIdentifierArticleIds: string[]
}): CovidenceMatchResolution => {
  const excludedArticleIds = params.excludedArticleIds ?? new Set<string>()
  const strongIdentifierArticleIds = getUniqueSortedValues(
    params.strongIdentifierArticleIds.filter((articleId) => {
      return !excludedArticleIds.has(articleId)
    }),
  )
  const strongIdentifierResolution = getCovidenceTierResolution('strong_identifier', strongIdentifierArticleIds)

  return (
    strongIdentifierResolution
    ?? covidenceBaseRouteMatchTiers.reduce<CovidenceMatchResolution | null>((resolution, tier) => {
      return (
        resolution
        ?? getCovidenceTierResolution(
          tier,
          getCovidenceTierArticleIds({excludedArticleIds, index: params.index, keys: params.keys, tier}),
        )
      )
    }, null) ?? {status: 'unmatched'}
  )
}

export const getSuggestedCovidenceBaseImportRoute = (routeShares: CovidenceRouteShare[]) => {
  const sortedRouteShares = [...routeShares].sort((left, right) => {
    return right.share - left.share || left.importRoute.localeCompare(right.importRoute)
  })
  const suggestion = sortedRouteShares.find((routeShare) => {
    return routeShare.share >= covidenceSameReviewSuggestionThreshold
  })

  return {routeShares: sortedRouteShares, suggestion: suggestion ?? null}
}

const getCovidenceSameReviewRecordSample = (
  input: CovidenceSameReviewSummaryInput,
): CovidenceSameReviewRecordSample => {
  return {
    articleIds: input.resolution.status === 'ambiguous' ? input.resolution.articleIds : [],
    articleKey: input.articleKey,
    covidenceIds: input.keys.covidenceIds,
    matchTier: input.resolution.status === 'unmatched' ? null : input.resolution.matchTier,
    referenceIds: input.keys.referenceIds,
    title: input.title,
  }
}

export const getCovidenceSameReviewMatchSummary = (
  baseImportRoute: string,
  inputs: CovidenceSameReviewSummaryInput[],
): CovidenceSameReviewMatchSummary => {
  const ambiguousInputs = inputs.filter((input) => {
    return input.resolution.status === 'ambiguous'
  })
  const unmatchedInputs = inputs.filter((input) => {
    return input.resolution.status === 'unmatched'
  })

  return {
    ambiguous: ambiguousInputs.slice(0, covidenceSameReviewListLimit).map(getCovidenceSameReviewRecordSample),
    ambiguousCount: ambiguousInputs.length,
    baseImportRoute,
    countsByTier: inputs.reduce<Record<CovidenceMatchTier, number>>(
      (counts, input) => {
        if (input.resolution.status === 'matched') {
          counts[input.resolution.matchTier] += 1
        }

        return counts
      },
      {covidence_id: 0, reference_id: 0, strong_identifier: 0, title_year_first_author: 0},
    ),
    unmatched: unmatchedInputs.slice(0, covidenceSameReviewListLimit).map(getCovidenceSameReviewRecordSample),
    unmatchedCount: unmatchedInputs.length,
  }
}
