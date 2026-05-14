export type ArticleStrongIdentifierKind = 'doi' | 'pmid' | 'arxiv'
export type ArticleMetadataIdentifierKind = 'pmcid'
export type ArticleIdentifierInputKind =
  | ArticleStrongIdentifierKind
  | ArticleMetadataIdentifierKind
  | 'biorxiv'
  | 'medrxiv'
  | 'url'
export type ArticleIdentifierRejectionReason = 'empty' | 'malformed' | 'unsupported-url'

type ArticlePreprintSourceKind = 'biorxiv' | 'medrxiv'

export type ArticleIdentifierEvidence = {
  inputKind: ArticleIdentifierInputKind
  normalizedValue: string
  rawValue: string
  source: string
  sourceKind?: ArticlePreprintSourceKind
  sourceVersion?: string
}

export type ArticleStrongIdentifier = {kind: ArticleStrongIdentifierKind; normalizedValue: string}

export type ArticleMetadataIdentifier = {kind: ArticleMetadataIdentifierKind; normalizedValue: string}

export type AcceptedArticleIdentifierNormalization = {
  evidence: ArticleIdentifierEvidence
  identifier: ArticleStrongIdentifier
  status: 'accepted'
}

export type MetadataArticleIdentifierNormalization = {
  evidence: ArticleIdentifierEvidence
  identifier: ArticleMetadataIdentifier
  status: 'metadata'
}

export type RejectedArticleIdentifierNormalization = {
  detail: string
  inputKind: ArticleIdentifierInputKind
  rawValue: string
  reason: ArticleIdentifierRejectionReason
  source: string
  status: 'rejected'
}

export type ArticleIdentifierNormalizationOutcome =
  | AcceptedArticleIdentifierNormalization
  | MetadataArticleIdentifierNormalization
  | RejectedArticleIdentifierNormalization

export type ArticleIdentifierInput = {inputKind: ArticleIdentifierInputKind; source: string; value: unknown}

export type ArticleIdentifierConflict = {
  candidates: ArticleIdentifierEvidence[]
  detail: string
  kind: ArticleStrongIdentifierKind
  normalizedValues: string[]
  reason: 'source-row-identifier-disagreement'
  status: 'conflicted'
}

export type NormalizedSourceRowIdentifiers = {
  accepted: AcceptedArticleIdentifierNormalization[]
  conflicts: ArticleIdentifierConflict[]
  metadataIdentifiers: Array<ArticleMetadataIdentifier & {evidence: ArticleIdentifierEvidence[]}>
  rejected: RejectedArticleIdentifierNormalization[]
  strongIdentifiers: Array<ArticleStrongIdentifier & {evidence: ArticleIdentifierEvidence[]}>
}

type NormalizationOptions = {inputKind?: ArticleIdentifierInputKind; source?: string}

type PreprintDoiCandidate = {sourceVersion?: string; value: string}

const doiPrefixes = ['https://doi.org/', 'http://doi.org/', 'https://dx.doi.org/', 'http://dx.doi.org/', 'doi:']
const pmidPrefixes = ['pmid:', 'pubmed:']
const pmcidPrefixes = ['pmcid:', 'pmc:']
const arxivTextPrefixes = ['oai:arxiv.org:', 'arxiv:']
const safeLeadingPunctuationPattern = /^[\s"'(<[{]+/
const safeTrailingPunctuationPattern = /[\s"')>\]},.;]+$/
const doiPattern = /^10\.[^\s/]+\/[^\s]+$/
const modernArxivPattern = /^\d{4}\.\d{4,5}$/
const legacyArxivPattern = /^[a-z][a-z-]+(?:\.[a-z-]+)?\/\d{7}$/

const getRawString = (value: unknown) => {
  return typeof value === 'number' ? String(value) : typeof value === 'string' ? value : ''
}

const stripSafeSurroundingPunctuation = (value: string) => {
  return value.trim().replace(safeLeadingPunctuationPattern, '').replace(safeTrailingPunctuationPattern, '').trim()
}

const stripQueryAndFragment = (value: string) => {
  return value.split(/[?#]/, 1)[0] ?? value
}

const getParsedUrl = (value: string) => {
  return URL.canParse(value) ? new URL(value) : null
}

const getNormalizedHost = (url: URL) => {
  return url.hostname.toLowerCase().replace(/^www\./, '')
}

const getUrlPathSegments = (url: URL) => {
  return url.pathname
    .split('/')
    .map((segment) => {
      return decodeURIComponent(segment)
    })
    .filter((segment) => {
      return segment !== ''
    })
}

const stripKnownPrefix = (value: string, prefixes: string[]) => {
  const lowerValue = value.toLowerCase()
  const prefix = prefixes.find((candidate) => {
    return lowerValue.startsWith(candidate)
  })

  return prefix ? value.slice(prefix.length).trim() : value
}

const getOptionsInputKind = (options: NormalizationOptions, fallback: ArticleIdentifierInputKind) => {
  return options.inputKind ?? fallback
}

const getOptionsSource = (options: NormalizationOptions, fallback: string) => {
  return options.source ?? fallback
}

const getRejectedIdentifier = (
  params: NormalizationOptions & {
    detail: string
    fallbackInputKind: ArticleIdentifierInputKind
    fallbackSource: string
    rawValue: string
    reason: ArticleIdentifierRejectionReason
  },
): RejectedArticleIdentifierNormalization => {
  return {
    detail: params.detail,
    inputKind: getOptionsInputKind(params, params.fallbackInputKind),
    rawValue: params.rawValue,
    reason: params.reason,
    source: getOptionsSource(params, params.fallbackSource),
    status: 'rejected',
  }
}

const getIdentifierEvidence = (
  params: NormalizationOptions & {
    fallbackInputKind: ArticleIdentifierInputKind
    fallbackSource: string
    normalizedValue: string
    rawValue: string
    sourceKind?: ArticlePreprintSourceKind
    sourceVersion?: string
  },
): ArticleIdentifierEvidence => {
  return {
    inputKind: getOptionsInputKind(params, params.fallbackInputKind),
    normalizedValue: params.normalizedValue,
    rawValue: params.rawValue,
    source: getOptionsSource(params, params.fallbackSource),
    ...(params.sourceKind ? {sourceKind: params.sourceKind} : {}),
    ...(params.sourceVersion ? {sourceVersion: params.sourceVersion} : {}),
  }
}

const getAcceptedIdentifier = (
  params: NormalizationOptions & {
    fallbackInputKind: ArticleIdentifierInputKind
    fallbackSource: string
    kind: ArticleStrongIdentifierKind
    normalizedValue: string
    rawValue: string
    sourceKind?: ArticlePreprintSourceKind
    sourceVersion?: string
  },
): AcceptedArticleIdentifierNormalization => {
  return {
    evidence: getIdentifierEvidence(params),
    identifier: {kind: params.kind, normalizedValue: params.normalizedValue},
    status: 'accepted',
  }
}

const getMetadataIdentifier = (
  params: NormalizationOptions & {
    fallbackInputKind: ArticleIdentifierInputKind
    fallbackSource: string
    kind: ArticleMetadataIdentifierKind
    normalizedValue: string
    rawValue: string
  },
): MetadataArticleIdentifierNormalization => {
  return {
    evidence: getIdentifierEvidence(params),
    identifier: {kind: params.kind, normalizedValue: params.normalizedValue},
    status: 'metadata',
  }
}

const getTrustedDoiUrlCandidate = (value: string) => {
  const url = getParsedUrl(value)
  const host = url ? getNormalizedHost(url) : null
  const isDoiHost = host === 'doi.org' || host === 'dx.doi.org'

  return url && isDoiHost ? decodeURIComponent(url.pathname.replace(/^\/+/, '')) : null
}

const getDoiCandidate = (rawValue: string) => {
  const cleanedValue = stripSafeSurroundingPunctuation(rawValue)
  const urlCandidate = getTrustedDoiUrlCandidate(cleanedValue)
  const prefixedCandidate = stripKnownPrefix(cleanedValue, doiPrefixes)

  return stripSafeSurroundingPunctuation(urlCandidate ?? prefixedCandidate).toLowerCase()
}

export const normalizeDoiIdentifier = (
  value: unknown,
  options: NormalizationOptions = {},
): AcceptedArticleIdentifierNormalization | RejectedArticleIdentifierNormalization => {
  const rawValue = getRawString(value)
  const normalizedValue = getDoiCandidate(rawValue)
  const isEmpty = stripSafeSurroundingPunctuation(rawValue) === ''
  const isMalformed = !doiPattern.test(normalizedValue)

  return isEmpty
    ? getRejectedIdentifier({
        ...options,
        detail: 'DOI is empty after trimming whitespace and surrounding punctuation.',
        fallbackInputKind: 'doi',
        fallbackSource: 'doi',
        rawValue,
        reason: 'empty',
      })
    : isMalformed
      ? getRejectedIdentifier({
          ...options,
          detail: 'DOI must start with 10. and contain a slash after trusted prefix stripping.',
          fallbackInputKind: 'doi',
          fallbackSource: 'doi',
          rawValue,
          reason: 'malformed',
        })
      : getAcceptedIdentifier({
          ...options,
          fallbackInputKind: 'doi',
          fallbackSource: 'doi',
          kind: 'doi',
          normalizedValue,
          rawValue,
        })
}

const getTrustedPubmedUrlCandidate = (value: string) => {
  const url = getParsedUrl(value)
  const host = url ? getNormalizedHost(url) : null
  const segments = url ? getUrlPathSegments(url) : []
  const pubmedHostValue = host === 'pubmed.ncbi.nlm.nih.gov' ? segments[0] : null
  const ncbiPubmedValue = host === 'ncbi.nlm.nih.gov' && segments[0] === 'pubmed' ? segments[1] : null

  return pubmedHostValue ?? ncbiPubmedValue ?? null
}

const getPmidCandidate = (rawValue: string) => {
  const cleanedValue = stripSafeSurroundingPunctuation(rawValue)
  const urlCandidate = getTrustedPubmedUrlCandidate(cleanedValue)
  const prefixedCandidate = stripKnownPrefix(cleanedValue, pmidPrefixes)

  return stripSafeSurroundingPunctuation(urlCandidate ?? prefixedCandidate)
}

export const normalizePmidIdentifier = (
  value: unknown,
  options: NormalizationOptions = {},
): AcceptedArticleIdentifierNormalization | RejectedArticleIdentifierNormalization => {
  const rawValue = getRawString(value)
  const candidate = getPmidCandidate(rawValue)
  const normalizedValue = candidate.replace(/^0+/, '')
  const isEmpty = stripSafeSurroundingPunctuation(rawValue) === ''
  const isZeroOnly = /^[0]+$/.test(candidate)
  const isMalformed = !/^[0-9]+$/.test(candidate) || normalizedValue === ''

  return isEmpty
    ? getRejectedIdentifier({
        ...options,
        detail: 'PMID is empty after trimming whitespace and surrounding punctuation.',
        fallbackInputKind: 'pmid',
        fallbackSource: 'pmid',
        rawValue,
        reason: 'empty',
      })
    : isZeroOnly
      ? getRejectedIdentifier({
          ...options,
          detail: 'PMID must not be zero-only after removing leading zero padding.',
          fallbackInputKind: 'pmid',
          fallbackSource: 'pmid',
          rawValue,
          reason: 'malformed',
        })
      : isMalformed
        ? getRejectedIdentifier({
            ...options,
            detail: 'PMID must contain ASCII digits only after trusted prefix stripping.',
            fallbackInputKind: 'pmid',
            fallbackSource: 'pmid',
            rawValue,
            reason: 'malformed',
          })
        : getAcceptedIdentifier({
            ...options,
            fallbackInputKind: 'pmid',
            fallbackSource: 'pmid',
            kind: 'pmid',
            normalizedValue,
            rawValue,
          })
}

const getTrustedPmcidUrlCandidate = (value: string) => {
  const url = getParsedUrl(value)
  const host = url ? getNormalizedHost(url) : null
  const segments = url ? getUrlPathSegments(url) : []
  const pmcidSegment = segments.find((segment) => {
    return /^pmc\d+$/i.test(segment)
  })
  const isPmcHost = host === 'pmc.ncbi.nlm.nih.gov'
  const isNcbiPmcPath = host === 'ncbi.nlm.nih.gov' && segments.includes('pmc')

  return isPmcHost || isNcbiPmcPath ? (pmcidSegment ?? null) : null
}

const getPmcidCandidate = (rawValue: string) => {
  const cleanedValue = stripSafeSurroundingPunctuation(rawValue)
  const urlCandidate = getTrustedPmcidUrlCandidate(cleanedValue)
  const prefixedCandidate = stripKnownPrefix(cleanedValue, pmcidPrefixes).replace(/\s+/g, '')
  const candidate = urlCandidate ?? prefixedCandidate

  return candidate.toUpperCase().startsWith('PMC') ? candidate.toUpperCase() : `PMC${candidate}`
}

export const normalizePmcidIdentifier = (
  value: unknown,
  options: NormalizationOptions = {},
): MetadataArticleIdentifierNormalization | RejectedArticleIdentifierNormalization => {
  const rawValue = getRawString(value)
  const normalizedValue = getPmcidCandidate(rawValue)
  const isEmpty = stripSafeSurroundingPunctuation(rawValue) === ''
  const isMalformed = !/^PMC[0-9]+$/.test(normalizedValue)

  return isEmpty
    ? getRejectedIdentifier({
        ...options,
        detail: 'PMCID is empty after trimming whitespace and surrounding punctuation.',
        fallbackInputKind: 'pmcid',
        fallbackSource: 'pmcid',
        rawValue,
        reason: 'empty',
      })
    : isMalformed
      ? getRejectedIdentifier({
          ...options,
          detail: 'PMCID must normalize to uppercase PMC followed by ASCII digits.',
          fallbackInputKind: 'pmcid',
          fallbackSource: 'pmcid',
          rawValue,
          reason: 'malformed',
        })
      : getMetadataIdentifier({
          ...options,
          fallbackInputKind: 'pmcid',
          fallbackSource: 'pmcid',
          kind: 'pmcid',
          normalizedValue,
          rawValue,
        })
}

const getTrustedArxivUrlCandidate = (value: string) => {
  const url = getParsedUrl(value)
  const host = url ? getNormalizedHost(url) : null
  const segments = url ? getUrlPathSegments(url) : []
  const isArxivHost = host === 'arxiv.org'
  const leadingSegment = segments[0]
  const candidateSegments = leadingSegment === 'abs' || leadingSegment === 'pdf' ? segments.slice(1) : segments

  return isArxivHost ? candidateSegments.join('/') : null
}

const getArxivCandidate = (rawValue: string) => {
  const cleanedValue = stripSafeSurroundingPunctuation(rawValue)
  const urlCandidate = getTrustedArxivUrlCandidate(cleanedValue)
  const prefixedCandidate = stripKnownPrefix(cleanedValue, arxivTextPrefixes)
  const withoutQuery = stripQueryAndFragment(urlCandidate ?? prefixedCandidate)
  const withoutPdf = withoutQuery.replace(/\.pdf$/i, '')
  const sourceVersion = withoutPdf.match(/v\d+$/i)?.[0]?.toLowerCase()
  const normalizedValue = (sourceVersion ? withoutPdf.slice(0, -sourceVersion.length) : withoutPdf).toLowerCase()

  return {normalizedValue, sourceVersion}
}

export const normalizeArxivIdentifier = (
  value: unknown,
  options: NormalizationOptions = {},
): AcceptedArticleIdentifierNormalization | RejectedArticleIdentifierNormalization => {
  const rawValue = getRawString(value)
  const {normalizedValue, sourceVersion} = getArxivCandidate(rawValue)
  const isEmpty = stripSafeSurroundingPunctuation(rawValue) === ''
  const isMalformed = !modernArxivPattern.test(normalizedValue) && !legacyArxivPattern.test(normalizedValue)

  return isEmpty
    ? getRejectedIdentifier({
        ...options,
        detail: 'arXiv id is empty after trimming whitespace and surrounding punctuation.',
        fallbackInputKind: 'arxiv',
        fallbackSource: 'arxiv',
        rawValue,
        reason: 'empty',
      })
    : isMalformed
      ? getRejectedIdentifier({
          ...options,
          detail: 'arXiv id must be a modern numeric id or legacy category id after trusted prefix stripping.',
          fallbackInputKind: 'arxiv',
          fallbackSource: 'arxiv',
          rawValue,
          reason: 'malformed',
        })
      : getAcceptedIdentifier({
          ...options,
          fallbackInputKind: 'arxiv',
          fallbackSource: 'arxiv',
          kind: 'arxiv',
          normalizedValue,
          rawValue,
          ...(sourceVersion ? {sourceVersion} : {}),
        })
}

const getPreprintDoiUrlCandidate = (
  value: string,
  sourceKind: ArticlePreprintSourceKind,
): PreprintDoiCandidate | null => {
  const url = getParsedUrl(value)
  const host = url ? getNormalizedHost(url) : null
  const segments = url ? getUrlPathSegments(url) : []
  const doiStartIndex = segments.findIndex((segment) => {
    return /^10\./i.test(segment)
  })
  const isTrustedHost = host === `${sourceKind}.org`
  const valueCandidate = isTrustedHost && doiStartIndex >= 0 ? segments.slice(doiStartIndex).join('/') : null

  return valueCandidate ? getPreprintDoiCandidate(valueCandidate) : null
}

const getPreprintDoiCandidate = (value: string): PreprintDoiCandidate => {
  const withoutQuery = stripQueryAndFragment(stripSafeSurroundingPunctuation(value))
  const withoutDocumentSuffix = withoutQuery.replace(/\.full\.pdf$/i, '').replace(/\.full$/i, '')
  const withoutPdfSuffix = withoutDocumentSuffix.replace(/\.pdf$/i, '')
  const versionMatch = withoutPdfSuffix.match(/(?:\/)?v\d+$/i)?.[0]
  const sourceVersion = versionMatch?.replace(/^\//, '').toLowerCase()
  const normalizedValue = versionMatch ? withoutPdfSuffix.slice(0, -versionMatch.length) : withoutPdfSuffix

  return {normalizedValue, ...(sourceVersion ? {sourceVersion} : {})}
}

const normalizePreprintDoiIdentifier = (
  value: unknown,
  sourceKind: ArticlePreprintSourceKind,
  options: NormalizationOptions,
): AcceptedArticleIdentifierNormalization | RejectedArticleIdentifierNormalization => {
  const rawValue = getRawString(value)
  const urlCandidate = getPreprintDoiUrlCandidate(stripSafeSurroundingPunctuation(rawValue), sourceKind)
  const directCandidate = getPreprintDoiCandidate(rawValue)
  const candidate = urlCandidate ?? directCandidate
  const doiOutcome = normalizeDoiIdentifier(candidate.normalizedValue, {
    ...options,
    inputKind: sourceKind,
    source: sourceKind,
  })

  return doiOutcome.status === 'accepted'
    ? getAcceptedIdentifier({
        ...options,
        fallbackInputKind: sourceKind,
        fallbackSource: sourceKind,
        kind: 'doi',
        normalizedValue: doiOutcome.identifier.normalizedValue,
        rawValue,
        sourceKind,
        ...(candidate.sourceVersion ? {sourceVersion: candidate.sourceVersion} : {}),
      })
    : getRejectedIdentifier({
        ...options,
        detail: `${sourceKind} identifier must contain a DOI-shaped value from a trusted DOI or ${sourceKind}.org URL.`,
        fallbackInputKind: sourceKind,
        fallbackSource: sourceKind,
        rawValue,
        reason: doiOutcome.reason,
      })
}

export const normalizeBiorxivIdentifier = (
  value: unknown,
  options: NormalizationOptions = {},
): AcceptedArticleIdentifierNormalization | RejectedArticleIdentifierNormalization => {
  return normalizePreprintDoiIdentifier(value, 'biorxiv', options)
}

export const normalizeMedrxivIdentifier = (
  value: unknown,
  options: NormalizationOptions = {},
): AcceptedArticleIdentifierNormalization | RejectedArticleIdentifierNormalization => {
  return normalizePreprintDoiIdentifier(value, 'medrxiv', options)
}

export const normalizeTrustedUrlIdentifier = (
  value: unknown,
  options: NormalizationOptions = {},
): ArticleIdentifierNormalizationOutcome => {
  const rawValue = getRawString(value)
  const cleanedValue = stripSafeSurroundingPunctuation(rawValue)
  const url = getParsedUrl(cleanedValue)
  const host = url ? getNormalizedHost(url) : null
  const segments = url ? getUrlPathSegments(url) : []
  const isNcbiPmcPath = host === 'ncbi.nlm.nih.gov' && segments.includes('pmc')
  const normalizedOptions = {...options, inputKind: 'url' as const, source: options.source ?? 'url'}
  const outcome =
    host === 'doi.org' || host === 'dx.doi.org'
      ? normalizeDoiIdentifier(rawValue, normalizedOptions)
      : host === 'pmc.ncbi.nlm.nih.gov' || isNcbiPmcPath
        ? normalizePmcidIdentifier(rawValue, normalizedOptions)
        : host === 'pubmed.ncbi.nlm.nih.gov' || host === 'ncbi.nlm.nih.gov'
          ? normalizePmidIdentifier(rawValue, normalizedOptions)
          : host === 'arxiv.org'
            ? normalizeArxivIdentifier(rawValue, normalizedOptions)
            : host === 'biorxiv.org'
              ? normalizeBiorxivIdentifier(rawValue, normalizedOptions)
              : host === 'medrxiv.org'
                ? normalizeMedrxivIdentifier(rawValue, normalizedOptions)
                : null

  return (
    outcome
    ?? getRejectedIdentifier({
      ...normalizedOptions,
      detail: 'URL identifier must use a trusted DOI, PubMed, PubMed Central, arXiv, bioRxiv, or medRxiv host.',
      fallbackInputKind: 'url',
      fallbackSource: 'url',
      rawValue,
      reason: cleanedValue === '' ? 'empty' : 'unsupported-url',
    })
  )
}

const articleIdentifierNormalizers = {
  arxiv: normalizeArxivIdentifier,
  biorxiv: normalizeBiorxivIdentifier,
  doi: normalizeDoiIdentifier,
  medrxiv: normalizeMedrxivIdentifier,
  pmcid: normalizePmcidIdentifier,
  pmid: normalizePmidIdentifier,
  url: normalizeTrustedUrlIdentifier,
} satisfies Record<
  ArticleIdentifierInputKind,
  (value: unknown, options?: NormalizationOptions) => ArticleIdentifierNormalizationOutcome
>

export const normalizeArticleIdentifierInput = (
  input: ArticleIdentifierInput,
): ArticleIdentifierNormalizationOutcome => {
  return articleIdentifierNormalizers[input.inputKind](input.value, {inputKind: input.inputKind, source: input.source})
}

const isAcceptedIdentifier = (
  outcome: ArticleIdentifierNormalizationOutcome,
): outcome is AcceptedArticleIdentifierNormalization => {
  return outcome.status === 'accepted'
}

const isMetadataIdentifier = (
  outcome: ArticleIdentifierNormalizationOutcome,
): outcome is MetadataArticleIdentifierNormalization => {
  return outcome.status === 'metadata'
}

const isRejectedIdentifier = (
  outcome: ArticleIdentifierNormalizationOutcome,
): outcome is RejectedArticleIdentifierNormalization => {
  return outcome.status === 'rejected'
}

const getGroupedAcceptedIdentifiers = (accepted: AcceptedArticleIdentifierNormalization[]) => {
  return accepted.reduce<Map<ArticleStrongIdentifierKind, Map<string, ArticleIdentifierEvidence[]>>>(
    (kindMap, outcome) => {
      const valueMap = kindMap.get(outcome.identifier.kind) ?? new Map<string, ArticleIdentifierEvidence[]>()
      const evidence = valueMap.get(outcome.identifier.normalizedValue) ?? []
      valueMap.set(outcome.identifier.normalizedValue, [...evidence, outcome.evidence])
      kindMap.set(outcome.identifier.kind, valueMap)

      return kindMap
    },
    new Map(),
  )
}

const getGroupedMetadataIdentifiers = (metadata: MetadataArticleIdentifierNormalization[]) => {
  return metadata.reduce<Map<ArticleMetadataIdentifierKind, Map<string, ArticleIdentifierEvidence[]>>>(
    (kindMap, outcome) => {
      const valueMap = kindMap.get(outcome.identifier.kind) ?? new Map<string, ArticleIdentifierEvidence[]>()
      const evidence = valueMap.get(outcome.identifier.normalizedValue) ?? []
      valueMap.set(outcome.identifier.normalizedValue, [...evidence, outcome.evidence])
      kindMap.set(outcome.identifier.kind, valueMap)

      return kindMap
    },
    new Map(),
  )
}

const getIdentifierConflicts = (
  groupedIdentifiers: Map<ArticleStrongIdentifierKind, Map<string, ArticleIdentifierEvidence[]>>,
) => {
  return Array.from(groupedIdentifiers.entries())
    .filter(([_kind, valueMap]) => {
      return valueMap.size > 1
    })
    .map(([kind, valueMap]): ArticleIdentifierConflict => {
      const candidates = Array.from(valueMap.values()).flat()
      const normalizedValues = Array.from(valueMap.keys())

      return {
        candidates,
        detail: `${kind} identifiers disagree within one source row: ${normalizedValues.join(', ')}`,
        kind,
        normalizedValues,
        reason: 'source-row-identifier-disagreement',
        status: 'conflicted',
      }
    })
}

const getStrongIdentifiers = (
  groupedIdentifiers: Map<ArticleStrongIdentifierKind, Map<string, ArticleIdentifierEvidence[]>>,
  conflictKinds: Set<ArticleStrongIdentifierKind>,
) => {
  return Array.from(groupedIdentifiers.entries())
    .filter(([kind]) => {
      return !conflictKinds.has(kind)
    })
    .flatMap(([kind, valueMap]) => {
      return Array.from(valueMap.entries()).map(([normalizedValue, evidence]) => {
        return {evidence, kind, normalizedValue}
      })
    })
}

const getMetadataIdentifiers = (
  groupedIdentifiers: Map<ArticleMetadataIdentifierKind, Map<string, ArticleIdentifierEvidence[]>>,
) => {
  return Array.from(groupedIdentifiers.entries()).flatMap(([kind, valueMap]) => {
    return Array.from(valueMap.entries()).map(([normalizedValue, evidence]) => {
      return {evidence, kind, normalizedValue}
    })
  })
}

export const normalizeSourceRowIdentifiers = (inputs: ArticleIdentifierInput[]): NormalizedSourceRowIdentifiers => {
  const outcomes = inputs.map(normalizeArticleIdentifierInput)
  const accepted = outcomes.filter(isAcceptedIdentifier)
  const metadata = outcomes.filter(isMetadataIdentifier)
  const rejected = outcomes.filter(isRejectedIdentifier)
  const groupedAccepted = getGroupedAcceptedIdentifiers(accepted)
  const groupedMetadata = getGroupedMetadataIdentifiers(metadata)
  const conflicts = getIdentifierConflicts(groupedAccepted)
  const conflictKinds = new Set(
    conflicts.map((conflict) => {
      return conflict.kind
    }),
  )

  return {
    accepted,
    conflicts,
    metadataIdentifiers: getMetadataIdentifiers(groupedMetadata),
    rejected,
    strongIdentifiers: getStrongIdentifiers(groupedAccepted, conflictKinds),
  }
}
