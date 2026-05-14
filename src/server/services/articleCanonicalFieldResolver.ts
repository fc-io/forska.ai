import type {PublicationStatus} from '../../db/schemaTypes.ts'

export type CanonicalArticleScalarField = 'articleSummary' | 'articleTitle' | 'publicationStatus' | 'url'
export type CanonicalArticleField = CanonicalArticleScalarField | 'articleAuthors' | 'fullTextLinks'
export type CanonicalArticleManualFields = Partial<Record<CanonicalArticleField, boolean>>
export type CanonicalArticleFieldTrustRanks = Partial<Record<CanonicalArticleField, number>>

export type CanonicalFullTextLinkHint = {
  availability: string | null
  availabilityCode: string | null
  documentStyle: string | null
  site: string | null
  url: string
}

export type CanonicalArticleFieldCandidate = {
  articleAuthors?: string[] | null
  articleCreatedAt?: Date | string | null
  articleSummary?: string | null
  articleTitle?: string | null
  arxivId?: string | null
  biorxivId?: string | null
  createdAt?: Date | string | null
  doi?: string | null
  fieldTrustRanks?: CanonicalArticleFieldTrustRanks
  importRoute?: string | null
  manualFields?: CanonicalArticleManualFields
  medrxivId?: string | null
  publicationStatus?: PublicationStatus | null
  pubmedId?: string | null
  sourceKind?: string | null
  sourceMetadata?: unknown
  sourceRecordKey?: string | null
  url?: string | null
}

export type CurrentCanonicalArticleFields = CanonicalArticleFieldCandidate & {
  articleTitle: string | null
  id?: string | null
}

export type CanonicalFieldConflictWarning = {
  candidates: Array<{
    completeness: number
    sourceKind: string | null
    sourceRecordKey: string
    trustRank: number
    value: string
  }>
  field: CanonicalArticleScalarField
  reason: 'material-scalar-conflict'
  selectedValue: string | null
}

export type CanonicalFieldResolverResult = {
  articleAuthors: string[] | null
  articleSummary: string | null
  articleTitle: string
  arxivId: string | null
  biorxivId: string | null
  doi: string | null
  fullTextLinks: CanonicalFullTextLinkHint[]
  medrxivId: string | null
  publicationStatus: PublicationStatus | null
  pubmedId: string | null
  sourceMetadata: unknown
  url: string | null
  warnings: CanonicalFieldConflictWarning[]
}

type ScalarCandidate = {
  canonicalCreatedAtMs: number
  completeness: number
  sourceKind: string | null
  sourceRecordKey: string
  trustRank: number
  value: string
}

type RankedValueCandidate = {
  canonicalCreatedAtMs: number
  sourceKind: string | null
  sourceRecordKey: string
  trustRank: number
  value: string
}

type AuthorsCandidate = {
  canonicalCreatedAtMs: number
  sourceKind: string | null
  sourceRecordKey: string
  trustRank: number
  value: string[]
}

type PublicationStatusCandidate = RankedValueCandidate & {value: PublicationStatus}

type CurrentCandidatePair = {
  candidates: CanonicalArticleFieldCandidate[]
  current: CurrentCanonicalArticleFields | null
}

const publisherSourcePatterns = ['pubmed', 'europe-pmc', 'europepmc', 'publisher']
const landingSourcePatterns = ['doi', 'landing']
const preprintSourcePatterns = ['arxiv', 'biorxiv', 'medrxiv', 'ppr', 'preprint']
const referenceSourcePatterns = ['covidence', 'structured-file', 'structured_file', 'imported-file', 'imported_file']
const publicationStatusRank: Record<PublicationStatus, number> = {
  accepted: 3,
  preprint: 1,
  published: 4,
  retracted: 5,
  submitted: 2,
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const parseJsonValue = (value: string) => {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

const getRecordValue = (value: unknown) => {
  const parsed = typeof value === 'string' ? parseJsonValue(value) : null

  return isRecord(value) ? value : isRecord(parsed) ? parsed : null
}

const getArrayValue = (value: unknown) => {
  if (Array.isArray(value)) {
    return value.map((entry) => {
      return entry as unknown
    })
  }

  const parsed = typeof value === 'string' ? parseJsonValue(value) : null

  return Array.isArray(parsed)
    ? parsed.map((entry) => {
        return entry as unknown
      })
    : []
}

const getStringValue = (value: unknown) => {
  const trimmed = typeof value === 'number' ? String(value).trim() : typeof value === 'string' ? value.trim() : ''

  return trimmed === '' ? null : trimmed
}

const getTimestampMs = (value: Date | string | null | undefined) => {
  const dateValue = value instanceof Date ? value : value ? new Date(value) : null
  const timestamp = dateValue ? dateValue.getTime() : Number.POSITIVE_INFINITY

  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY
}

const getCompactText = (value: string) => {
  return value.replace(/\s+/g, ' ').trim()
}

const getMaterialComparisonValue = (value: string) => {
  return getCompactText(value).toLowerCase()
}

const includesAny = (value: string, patterns: string[]) => {
  return patterns.some((pattern) => {
    return value.includes(pattern)
  })
}

export const getCanonicalArticleSourceTrustRank = (candidate: {
  importRoute?: string | null
  sourceKind?: string | null
  sourceMetadata?: unknown
}) => {
  const sourceKey = [candidate.sourceKind, candidate.importRoute]
    .map((entry) => {
      return getStringValue(entry)?.toLowerCase().replaceAll('_', '-') ?? ''
    })
    .join(' ')
  const metadata = getRecordValue(candidate.sourceMetadata)
  const metadataKey = metadata
    ? [
        metadata.isPreprint === true ? 'preprint' : '',
        getStringValue(metadata.preprintSource),
        getStringValue(metadata.preprintHostLabel),
        isRecord(metadata.structuredFile) ? 'structured-file' : '',
        isRecord(metadata.covidence) ? 'covidence' : '',
      ]
        .filter((entry): entry is string => {
          return entry !== null && entry !== ''
        })
        .map((entry) => {
          return entry.toLowerCase().replaceAll('_', '-')
        })
        .join(' ')
    : ''
  const combinedKey = `${sourceKey} ${metadataKey}`
  const isPreprint = includesAny(combinedKey, preprintSourcePatterns)

  return includesAny(combinedKey, publisherSourcePatterns) && !isPreprint
    ? 0
    : includesAny(combinedKey, landingSourcePatterns)
      ? 1
      : isPreprint
        ? 2
        : includesAny(combinedKey, referenceSourcePatterns)
          ? 3
          : 4
}

const getSourceKind = (candidate: CanonicalArticleFieldCandidate) => {
  return getStringValue(candidate.sourceKind) ?? getStringValue(candidate.importRoute)
}

const getStableSourceRecordKey = (candidate: CanonicalArticleFieldCandidate, index: number) => {
  return getStringValue(candidate.sourceRecordKey) ?? getStringValue(candidate.url) ?? `candidate:${index}`
}

const getFieldTrustRanksFromMetadata = (sourceMetadata: unknown): CanonicalArticleFieldTrustRanks => {
  const metadata = getRecordValue(sourceMetadata)
  const resolverMetadata = getRecordValue(metadata?.canonicalResolver)
  const fieldTrustRanks = getRecordValue(resolverMetadata?.fieldTrustRanks)

  return fieldTrustRanks
    ? Object.fromEntries(
        Object.entries(fieldTrustRanks)
          .map((entry) => {
            return [entry[0], typeof entry[1] === 'number' && Number.isFinite(entry[1]) ? entry[1] : null]
          })
          .filter((entry): entry is [string, number] => {
            return entry[1] !== null
          }),
      )
    : {}
}

const getCandidateTrustRank = (candidate: CanonicalArticleFieldCandidate, field?: CanonicalArticleField) => {
  const fieldTrustRanks = {
    ...getFieldTrustRanksFromMetadata(candidate.sourceMetadata),
    ...(candidate.fieldTrustRanks ?? {}),
  }
  const fieldTrustRank = field ? fieldTrustRanks[field] : null

  return typeof fieldTrustRank === 'number' ? fieldTrustRank : getCanonicalArticleSourceTrustRank(candidate)
}

const getRankedCandidate = (
  candidate: CanonicalArticleFieldCandidate,
  index: number,
  field?: CanonicalArticleField,
): Omit<RankedValueCandidate, 'value'> => {
  return {
    canonicalCreatedAtMs: getTimestampMs(candidate.createdAt),
    sourceKind: getSourceKind(candidate),
    sourceRecordKey: getStableSourceRecordKey(candidate, index),
    trustRank: getCandidateTrustRank(candidate, field),
  }
}

const compareRankedCandidates = (left: RankedValueCandidate, right: RankedValueCandidate) => {
  const trustRankDiff = left.trustRank - right.trustRank
  const createdAtDiff = left.canonicalCreatedAtMs - right.canonicalCreatedAtMs
  const keyDiff = left.sourceRecordKey.localeCompare(right.sourceRecordKey)

  return trustRankDiff || createdAtDiff || keyDiff || left.value.localeCompare(right.value)
}

const compareScalarCandidates = (left: ScalarCandidate, right: ScalarCandidate) => {
  const trustRankDiff = left.trustRank - right.trustRank
  const completenessDiff = right.completeness - left.completeness
  const createdAtDiff = left.canonicalCreatedAtMs - right.canonicalCreatedAtMs
  const keyDiff = left.sourceRecordKey.localeCompare(right.sourceRecordKey)

  return trustRankDiff || completenessDiff || createdAtDiff || keyDiff || left.value.localeCompare(right.value)
}

const compareAuthorsCandidates = (left: AuthorsCandidate, right: AuthorsCandidate) => {
  const trustRankDiff = left.trustRank - right.trustRank
  const completenessDiff = right.value.length - left.value.length
  const createdAtDiff = left.canonicalCreatedAtMs - right.canonicalCreatedAtMs
  const keyDiff = left.sourceRecordKey.localeCompare(right.sourceRecordKey)

  return (
    trustRankDiff
    || completenessDiff
    || createdAtDiff
    || keyDiff
    || left.value.join('\u0000').localeCompare(right.value.join('\u0000'))
  )
}

const comparePublicationStatusCandidates = (left: PublicationStatusCandidate, right: PublicationStatusCandidate) => {
  const statusRankDiff = publicationStatusRank[right.value] - publicationStatusRank[left.value]

  return statusRankDiff || compareRankedCandidates(left, right)
}

const getManualFieldsFromMetadata = (sourceMetadata: unknown): CanonicalArticleManualFields => {
  const metadata = getRecordValue(sourceMetadata)
  const resolverMetadata = getRecordValue(metadata?.canonicalResolver)
  const manualFields = getRecordValue(resolverMetadata?.manualFields)

  return manualFields
    ? Object.fromEntries(
        Object.entries(manualFields)
          .filter((entry) => {
            return entry[1] === true
          })
          .map((entry) => {
            return [entry[0], true]
          }),
      )
    : {}
}

const getManualFields = (current: CurrentCanonicalArticleFields | null) => {
  return {...getManualFieldsFromMetadata(current?.sourceMetadata), ...(current?.manualFields ?? {})}
}

const isFieldManual = (current: CurrentCanonicalArticleFields | null, field: CanonicalArticleField) => {
  return getManualFields(current)[field] === true
}

const getScalarCandidates = (
  params: CurrentCandidatePair & {completeness: (value: string) => number; field: 'articleSummary' | 'articleTitle'},
) => {
  return [params.current, ...params.candidates]
    .filter((candidate): candidate is CanonicalArticleFieldCandidate => {
      return candidate !== null
    })
    .map((candidate, index) => {
      const value = getStringValue(candidate[params.field])
      const ranked = getRankedCandidate(candidate, index, params.field)

      return value ? {...ranked, completeness: params.completeness(value), value} : null
    })
    .filter((candidate): candidate is ScalarCandidate => {
      return candidate !== null
    })
}

const getConflictWarning = (params: {
  candidates: ScalarCandidate[]
  field: CanonicalArticleScalarField
  selectedValue: string | null
}) => {
  const first = params.candidates[0]
  const topCandidates = first
    ? params.candidates.filter((candidate) => {
        return candidate.trustRank === first.trustRank && candidate.completeness === first.completeness
      })
    : []
  const materialValueCount = new Set(
    topCandidates.map((candidate) => {
      return getMaterialComparisonValue(candidate.value)
    }),
  ).size

  return materialValueCount > 1
    ? {
        candidates: topCandidates.map((candidate) => {
          return {
            completeness: candidate.completeness,
            sourceKind: candidate.sourceKind,
            sourceRecordKey: candidate.sourceRecordKey,
            trustRank: candidate.trustRank,
            value: candidate.value,
          }
        }),
        field: params.field,
        reason: 'material-scalar-conflict' as const,
        selectedValue: params.selectedValue,
      }
    : null
}

const resolveScalarField = (
  params: CurrentCandidatePair & {
    completeness: (value: string) => number
    fallback: string | null
    field: 'articleSummary' | 'articleTitle'
  },
) => {
  const currentValue = getStringValue(params.current?.[params.field])
  const candidates = getScalarCandidates(params).sort(compareScalarCandidates)
  const warning = getConflictWarning({
    candidates,
    field: params.field,
    selectedValue: currentValue ?? candidates[0]?.value ?? params.fallback,
  })
  const selected =
    isFieldManual(params.current, params.field) && currentValue
      ? currentValue
      : warning && currentValue
        ? currentValue
        : candidates[0]?.value
  const selectedCandidate = candidates.find((candidate) => {
    return selected ? getMaterialComparisonValue(candidate.value) === getMaterialComparisonValue(selected) : false
  })

  return {
    trustRank: selectedCandidate?.trustRank,
    value: selected ?? params.fallback,
    warnings: warning ? [warning] : [],
  }
}

const getAuthorsCandidates = (params: CurrentCandidatePair) => {
  return [params.current, ...params.candidates]
    .filter((candidate): candidate is CanonicalArticleFieldCandidate => {
      return candidate !== null
    })
    .map((candidate, index) => {
      const value = candidate.articleAuthors?.filter((author) => {
        return getStringValue(author) !== null
      })
      const ranked = getRankedCandidate(candidate, index, 'articleAuthors')

      return value && value.length > 0 ? {...ranked, value} : null
    })
    .filter((candidate): candidate is AuthorsCandidate => {
      return candidate !== null
    })
}

const resolveAuthors = (params: CurrentCandidatePair) => {
  const currentAuthors = params.current?.articleAuthors ?? null
  const candidates = getAuthorsCandidates(params).sort(compareAuthorsCandidates)

  return isFieldManual(params.current, 'articleAuthors') && currentAuthors && currentAuthors.length > 0
    ? currentAuthors
    : (candidates[0]?.value ?? currentAuthors ?? null)
}

const getIdentifierValue = (
  params: CurrentCandidatePair & {field: 'arxivId' | 'biorxivId' | 'doi' | 'medrxivId' | 'pubmedId'},
) => {
  const candidates = [params.current, ...params.candidates]
    .filter((candidate): candidate is CanonicalArticleFieldCandidate => {
      return candidate !== null
    })
    .map((candidate, index) => {
      const value = getStringValue(candidate[params.field])
      const ranked = getRankedCandidate(candidate, index)

      return value ? {...ranked, value} : null
    })
    .filter((candidate): candidate is RankedValueCandidate => {
      return candidate !== null
    })
    .sort(compareRankedCandidates)

  return candidates[0]?.value ?? null
}

const getSourceMetadataRecord = (candidate: CanonicalArticleFieldCandidate) => {
  return getRecordValue(candidate.sourceMetadata)
}

const getMetadataLinks = (sourceMetadata: unknown) => {
  const metadata = getRecordValue(sourceMetadata)
  const links = metadata ? getArrayValue(metadata.fullTextLinks) : []

  return links
    .map((entry) => {
      const record = getRecordValue(entry)
      const url = getStringValue(record?.url)

      return url
        ? {
            availability: getStringValue(record?.availability),
            availabilityCode: getStringValue(record?.availabilityCode),
            documentStyle: getStringValue(record?.documentStyle),
            site: getStringValue(record?.site),
            url,
          }
        : null
    })
    .filter((entry): entry is CanonicalFullTextLinkHint => {
      return entry !== null
    })
}

const getUrlKey = (url: string) => {
  const trimmed = url.trim()
  const parsed = URL.canParse(trimmed) ? new URL(trimmed) : null

  return parsed
    ? `${parsed.protocol.toLowerCase()}//${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`
    : trimmed.toLowerCase()
}

const mergeFullTextLinkHints = (params: CurrentCandidatePair) => {
  const orderedCandidates = params.candidates
    .map((candidate, index) => {
      return {...candidate, _rank: getRankedCandidate(candidate, index, 'fullTextLinks')}
    })
    .sort((left, right) => {
      return compareRankedCandidates({...left._rank, value: ''}, {...right._rank, value: ''})
    })
  const links = [params.current, ...orderedCandidates]
    .filter((candidate): candidate is CanonicalArticleFieldCandidate => {
      return candidate !== null
    })
    .flatMap((candidate) => {
      return getMetadataLinks(candidate.sourceMetadata)
    })

  return Array.from(
    links
      .reduce<Map<string, CanonicalFullTextLinkHint>>((acc, link) => {
        const key = getUrlKey(link.url)
        const existing = acc.get(key)
        const merged = existing
          ? {
              availability: existing.availability ?? link.availability,
              availabilityCode: existing.availabilityCode ?? link.availabilityCode,
              documentStyle: existing.documentStyle ?? link.documentStyle,
              site: existing.site ?? link.site,
              url: existing.url,
            }
          : link

        acc.set(key, merged)
        return acc
      }, new Map())
      .values(),
  )
}

const getInferredPublicationStatus = (candidate: CanonicalArticleFieldCandidate) => {
  const metadata = getSourceMetadataRecord(candidate)
  const explicitStatus = candidate.publicationStatus ?? null
  const isPreprint = metadata?.isPreprint === true
  const trustRank = getCanonicalArticleSourceTrustRank(candidate)

  return explicitStatus ?? (isPreprint ? 'preprint' : trustRank <= 1 ? 'published' : null)
}

const resolvePublicationStatus = (params: CurrentCandidatePair) => {
  const currentStatus = params.current?.publicationStatus ?? null
  const candidates = [params.current, ...params.candidates]
    .filter((candidate): candidate is CanonicalArticleFieldCandidate => {
      return candidate !== null
    })
    .map((candidate, index) => {
      const value = getInferredPublicationStatus(candidate)
      const ranked = getRankedCandidate(candidate, index, 'publicationStatus')

      return value ? {...ranked, value} : null
    })
    .filter((candidate): candidate is PublicationStatusCandidate => {
      return candidate !== null
    })
    .sort(comparePublicationStatusCandidates)
  const selected =
    isFieldManual(params.current, 'publicationStatus') && currentStatus ? currentStatus : (candidates[0]?.value ?? null)
  const selectedCandidate = candidates.find((candidate) => {
    return candidate.value === selected
  })

  return {trustRank: selectedCandidate?.trustRank, value: selected}
}

const getDoiUrl = (doi: string | null) => {
  return doi ? `https://doi.org/${doi}` : null
}

const getPubmedUrl = (pmid: string | null) => {
  return pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : null
}

const getUrlCandidates = (params: CurrentCandidatePair) => {
  return [params.current, ...params.candidates]
    .filter((candidate): candidate is CanonicalArticleFieldCandidate => {
      return candidate !== null
    })
    .map((candidate, index) => {
      const value = getStringValue(candidate.url)
      const ranked = getRankedCandidate(candidate, index, 'url')

      return value ? {...ranked, value} : null
    })
    .filter((candidate): candidate is RankedValueCandidate => {
      return candidate !== null
    })
}

const getIdentifierTrustRank = (params: CurrentCandidatePair & {field: 'doi' | 'pubmedId'; value: string | null}) => {
  const candidates = [params.current, ...params.candidates]
    .filter((candidate): candidate is CanonicalArticleFieldCandidate => {
      return candidate !== null
    })
    .map((candidate, index) => {
      const value = getStringValue(candidate[params.field])
      const ranked = getRankedCandidate(candidate, index, 'url')

      return value && value === params.value ? {...ranked, value} : null
    })
    .filter((candidate): candidate is RankedValueCandidate => {
      return candidate !== null
    })
    .sort(compareRankedCandidates)

  return candidates[0]?.trustRank
}

const resolveUrl = (params: CurrentCandidatePair & {doi: string | null; pubmedId: string | null}) => {
  const currentUrl = getStringValue(params.current?.url)
  const derivedUrl = getDoiUrl(params.doi) ?? getPubmedUrl(params.pubmedId)
  const candidates = getUrlCandidates(params).sort(compareRankedCandidates)
  const selected =
    isFieldManual(params.current, 'url') && currentUrl ? currentUrl : (derivedUrl ?? candidates[0]?.value ?? null)
  const directCandidate = candidates.find((candidate) => {
    return candidate.value === selected
  })
  const derivedTrustRank =
    selected === getDoiUrl(params.doi)
      ? getIdentifierTrustRank({...params, field: 'doi', value: params.doi})
      : selected === getPubmedUrl(params.pubmedId)
        ? getIdentifierTrustRank({...params, field: 'pubmedId', value: params.pubmedId})
        : undefined

  return {trustRank: directCandidate?.trustRank ?? derivedTrustRank, value: selected}
}

const mergeSourceMetadataRecords = (params: CurrentCandidatePair) => {
  return [params.current, ...params.candidates]
    .filter((candidate): candidate is CanonicalArticleFieldCandidate => {
      return candidate !== null
    })
    .map(getSourceMetadataRecord)
    .filter((record): record is Record<string, unknown> => {
      return record !== null
    })
    .reduce<Record<string, unknown>>((acc, record) => {
      return Object.entries(record).reduce<Record<string, unknown>>((innerAcc, entry) => {
        return innerAcc[entry[0]] === undefined ? {...innerAcc, [entry[0]]: entry[1]} : innerAcc
      }, acc)
    }, {})
}

const getSourceMetadataWithResolverState = (
  params: CurrentCandidatePair & {
    fieldTrustRanks: CanonicalArticleFieldTrustRanks
    fullTextLinks: CanonicalFullTextLinkHint[]
    warnings: CanonicalFieldConflictWarning[]
  },
) => {
  const merged = mergeSourceMetadataRecords(params)
  const existingResolver = getRecordValue(merged.canonicalResolver) ?? {}
  const manualFields = getManualFields(params.current)

  return {
    ...merged,
    canonicalResolver: {
      ...existingResolver,
      fieldTrustRanks: params.fieldTrustRanks,
      manualFields,
      warnings: params.warnings,
    },
    fullTextLinks: params.fullTextLinks,
    isPreprint: Boolean(merged.isPreprint),
  }
}

export const resolveCanonicalArticleFields = (params: CurrentCandidatePair): CanonicalFieldResolverResult => {
  const articleTitle = resolveScalarField({
    ...params,
    completeness: (value) => {
      return getCompactText(value).length
    },
    fallback: 'Untitled',
    field: 'articleTitle',
  })
  const articleSummary = resolveScalarField({
    ...params,
    completeness: (value) => {
      return getCompactText(value).length
    },
    fallback: null,
    field: 'articleSummary',
  })
  const articleAuthors = resolveAuthors(params)
  const doi = getIdentifierValue({...params, field: 'doi'})
  const pubmedId = getIdentifierValue({...params, field: 'pubmedId'})
  const fullTextLinks = mergeFullTextLinkHints(params)
  const publicationStatus = resolvePublicationStatus(params)
  const warnings = [...articleTitle.warnings, ...articleSummary.warnings]
  const url = resolveUrl({...params, doi, pubmedId})
  const fieldTrustRanks = {
    ...(articleTitle.trustRank === undefined ? {} : {articleTitle: articleTitle.trustRank}),
    ...(articleSummary.trustRank === undefined ? {} : {articleSummary: articleSummary.trustRank}),
    ...(publicationStatus.trustRank === undefined ? {} : {publicationStatus: publicationStatus.trustRank}),
    ...(url.trustRank === undefined ? {} : {url: url.trustRank}),
  } satisfies CanonicalArticleFieldTrustRanks
  const sourceMetadata = getSourceMetadataWithResolverState({...params, fieldTrustRanks, fullTextLinks, warnings})

  return {
    articleAuthors,
    articleSummary: articleSummary.value,
    articleTitle: articleTitle.value ?? 'Untitled',
    arxivId: getIdentifierValue({...params, field: 'arxivId'}),
    biorxivId: getIdentifierValue({...params, field: 'biorxivId'}),
    doi,
    fullTextLinks,
    medrxivId: getIdentifierValue({...params, field: 'medrxivId'}),
    publicationStatus: publicationStatus.value,
    pubmedId,
    sourceMetadata,
    url: url.value,
    warnings,
  }
}
