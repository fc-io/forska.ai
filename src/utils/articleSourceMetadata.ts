import {getJournalTitleFromOriginalData} from './getJournalTitleFromOriginalData.ts'

export type ArticleSourceLink = {
  url: string
  site: string | null
  availability: string | null
  availabilityCode: string | null
  documentStyle: string | null
}

export type ArticleSourceMetadata = {
  journalTitle: string | null
  preprintSource: string | null
  preprintHostLabel: string | null
  isPreprint: boolean
  fullTextLinks: ArticleSourceLink[]
}

export const emptyArticleSourceMetadata: ArticleSourceMetadata = {
  journalTitle: null,
  preprintSource: null,
  preprintHostLabel: null,
  isPreprint: false,
  fullTextLinks: [],
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const asNonEmptyString = (value: unknown) => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed === '' ? null : trimmed
}

export const normalizeDoi = (value: unknown) => {
  const raw = asNonEmptyString(value)

  if (!raw) {
    return null
  }

  const lower = raw.toLowerCase()
  const prefixes = ['https://doi.org/', 'http://doi.org/', 'https://dx.doi.org/', 'http://dx.doi.org/', 'doi:']
  const prefix = prefixes.find((candidate) => {
    return lower.startsWith(candidate)
  })

  return prefix ? raw.slice(prefix.length).trim() : raw
}

const getValueAtPath = (value: unknown, path: string[]): unknown => {
  const [first, ...rest] = path
  return first === undefined ? value : getValueAtPath(isRecord(value) ? value[first] : null, rest)
}

const getStringAtPath = (value: unknown, path: string[]) => {
  return asNonEmptyString(getValueAtPath(value, path))
}

const getArrayAtPath = (value: unknown, path: string[]) => {
  const resolved = getValueAtPath(value, path)
  return Array.isArray(resolved)
    ? resolved.map((entry) => {
        return entry as unknown
      })
    : resolved
      ? [resolved]
      : []
}

const toStringArray = (values: unknown[]) => {
  return values.map(asNonEmptyString).filter((entry): entry is string => {
    return Boolean(entry)
  })
}

const getFirstStringFromArrayObjectField = (value: unknown, arrayPath: string[], field: string) => {
  const first = getArrayAtPath(value, arrayPath)
    .map((entry) => {
      return isRecord(entry) ? asNonEmptyString(entry[field]) : null
    })
    .find((entry): entry is string => {
      return Boolean(entry)
    })

  return first ?? null
}

const normalizeSourceLabel = (value: string) => {
  const compact = value.trim().toLowerCase().replaceAll('(', '').replaceAll(')', '').replace(/\s+/g, ' ').trim()
  const aliases: Record<string, string> = {'arxiv.org': 'arxiv', 'biorxiv.org': 'biorxiv', 'medrxiv.org': 'medrxiv'}

  return aliases[compact] ?? compact
}

const preprintSourceDisplayLabels: Record<string, string> = {arxiv: 'arXiv', biorxiv: 'bioRxiv', medrxiv: 'medRxiv'}
const genericPreprintHostLabels = ['ppr', 'doi', 'doi.org', 'europe pmc', 'europepmc']

const getCanonicalPreprintHostLabel = (value: unknown) => {
  const normalizedValue = asNonEmptyString(value)
  const normalizedLabel = normalizedValue ? normalizeSourceLabel(normalizedValue) : null

  return normalizedLabel ? (preprintSourceDisplayLabels[normalizedLabel] ?? null) : null
}

const getPreprintHostLabelCandidate = (value: unknown) => {
  const rawValue = asNonEmptyString(value)

  if (!rawValue) {
    return null
  }

  const normalizedLabel = normalizeSourceLabel(rawValue)

  return genericPreprintHostLabels.includes(normalizedLabel)
    ? null
    : (getCanonicalPreprintHostLabel(rawValue) ?? rawValue)
}

const getPreprintSourceFromArticleId = (articleId: unknown) => {
  const value = asNonEmptyString(articleId)?.toLowerCase() ?? ''
  const fromOai = value.startsWith('oai:arxiv.org:') ? 'arxiv' : null
  const prefix = value.includes(':') ? (value.split(':')[0] ?? '') : ''
  const normalizedPrefix = normalizeSourceLabel(prefix)
  const knownPrefixes = ['arxiv', 'medrxiv', 'biorxiv', 'ppr']
  const fromPrefix = knownPrefixes.includes(normalizedPrefix) ? normalizedPrefix : null
  return fromOai ?? fromPrefix
}

const getPreprintSourceFromImportRoute = (importRoute: unknown) => {
  const route = asNonEmptyString(importRoute)?.toLowerCase() ?? ''
  const candidates = [
    route.includes('/arxiv') ? 'arxiv' : null,
    route.includes('/medrxiv') ? 'medrxiv' : null,
    route.includes('/biorxiv') ? 'biorxiv' : null,
    route.includes('/europe-pmc-ppr') ? 'ppr' : null,
  ]

  const first = candidates.find((candidate): candidate is string => {
    return Boolean(candidate)
  })
  return first ?? null
}

const getPreprintSourceFromOriginalData = (originalData: unknown) => {
  const knownSources = ['arxiv', 'medrxiv', 'biorxiv', 'ppr']
  const candidates = [
    getStringAtPath(originalData, ['bookOrReportDetails', 'publisher']),
    getStringAtPath(originalData, ['server']),
    getStringAtPath(originalData, ['source']),
    getStringAtPath(originalData, ['src']),
    getFirstStringFromArrayObjectField(originalData, ['fullTextUrlList', 'fullTextUrl'], 'site'),
    getFirstStringFromArrayObjectField(originalData, ['fullTextUrlList', 'fullTextUrl'], 'documentStyle'),
  ]

  const first = candidates
    .map((candidate) => {
      return candidate ? normalizeSourceLabel(candidate) : null
    })
    .filter((candidate): candidate is string => {
      return candidate !== null && knownSources.includes(candidate)
    })
    .find((candidate): candidate is string => {
      return Boolean(candidate)
    })

  return first ?? null
}

const getPreprintHostLabelFromDoi = (value: unknown) => {
  const doi = normalizeDoi(value)?.toLowerCase() ?? ''
  const matches = [
    doi.startsWith('10.20944/preprints') ? 'Preprints.org' : null,
    doi.startsWith('10.21203/rs.') ? 'Research Square' : null,
    doi.startsWith('10.2139/ssrn.') ? 'SSRN' : null,
  ]

  const first = matches.find((match): match is string => {
    return Boolean(match)
  })

  return first ?? null
}

const getPreprintHostLabelFromOriginalData = (originalData: unknown) => {
  const candidates = [
    getStringAtPath(originalData, ['bookOrReportDetails', 'publisher']),
    getStringAtPath(originalData, ['server']),
    getFirstStringFromArrayObjectField(originalData, ['fullTextUrlList', 'fullTextUrl'], 'site'),
    getFirstStringFromArrayObjectField(originalData, ['fullTextUrlList', 'fullTextUrl'], 'documentStyle'),
    getStringAtPath(originalData, ['source']),
    getStringAtPath(originalData, ['src']),
    getPreprintHostLabelFromDoi(getStringAtPath(originalData, ['doi'])),
  ]

  const first = candidates
    .map((candidate) => {
      return getPreprintHostLabelCandidate(candidate)
    })
    .find((candidate): candidate is string => {
      return Boolean(candidate)
    })

  return first ?? null
}

const isPreprintInOriginalData = (originalData: unknown) => {
  const sourceCodes = [getStringAtPath(originalData, ['source']), getStringAtPath(originalData, ['src'])]
    .map((sourceCode) => {
      return sourceCode ? normalizeSourceLabel(sourceCode) : null
    })
    .filter((sourceCode): sourceCode is string => {
      return Boolean(sourceCode)
    })

  const topLevelPubTypes = toStringArray(getArrayAtPath(originalData, ['pubTypeList', 'pubType']))
  const versionLevelPubTypes = getArrayAtPath(originalData, ['versionList', 'version']).flatMap((version) => {
    return toStringArray(getArrayAtPath(version, ['pubTypeList', 'pubType']))
  })

  const hasPprSourceCode = sourceCodes.some((sourceCode) => {
    return sourceCode === 'ppr'
  })
  const hasPreprintPubType = [...topLevelPubTypes, ...versionLevelPubTypes].some((pubType) => {
    return pubType.toLowerCase().includes('preprint')
  })

  return hasPprSourceCode || hasPreprintPubType
}

const getNormalizedLinkValue = (value: unknown) => {
  const record = isRecord(value) ? value : null
  const url = record ? asNonEmptyString(record.url) : null

  return url
    ? {
        url,
        site: record ? asNonEmptyString(record.site) : null,
        availability: record ? asNonEmptyString(record.availability) : null,
        availabilityCode: record ? asNonEmptyString(record.availabilityCode) : null,
        documentStyle: record ? asNonEmptyString(record.documentStyle) : null,
      }
    : null
}

const getSourceMetadataLinks = (value: unknown) => {
  const links = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : []

  return links
    .map((entry) => {
      return getNormalizedLinkValue(entry)
    })
    .filter((entry): entry is ArticleSourceLink => {
      return entry !== null
    })
}

export const getOriginalDoi = (originalData: unknown) => {
  return normalizeDoi(getStringAtPath(originalData, ['doi']))
}

export const getOriginalFullTextLinks = (originalData: unknown) => {
  const fullTextUrl = getValueAtPath(originalData, ['fullTextUrlList', 'fullTextUrl'])
  const entries = Array.isArray(fullTextUrl) ? fullTextUrl : fullTextUrl ? [fullTextUrl] : []

  return entries
    .map((entry) => {
      return getNormalizedLinkValue(entry)
    })
    .filter((entry): entry is ArticleSourceLink => {
      return entry !== null
    })
    .slice(0, 25)
}

export const getPreprintDisplayLabel = (params: {preprintHostLabel?: unknown; preprintSource?: unknown}) => {
  const preprintHostLabel = getPreprintHostLabelCandidate(params.preprintHostLabel)
  const canonicalSourceLabel = getCanonicalPreprintHostLabel(params.preprintSource)
  const rawPreprintSource = asNonEmptyString(params.preprintSource)

  return preprintHostLabel ?? canonicalSourceLabel ?? rawPreprintSource
}

export const getArticleSourceMetadata = (params: {
  articleId?: unknown
  doi?: unknown
  importRoute?: unknown
  journalTitle?: unknown
  originalData?: unknown
}): ArticleSourceMetadata => {
  const journalTitle = asNonEmptyString(params.journalTitle) ?? getJournalTitleFromOriginalData(params.originalData)
  const preprintSource =
    getPreprintSourceFromOriginalData(params.originalData)
    ?? getPreprintSourceFromArticleId(params.articleId)
    ?? getPreprintSourceFromImportRoute(params.importRoute)
  const preprintHostLabel =
    getPreprintHostLabelFromOriginalData(params.originalData)
    ?? getPreprintHostLabelFromDoi(params.doi)
    ?? getCanonicalPreprintHostLabel(preprintSource)
  const isPreprint = Boolean(preprintSource || isPreprintInOriginalData(params.originalData))
  const fullTextLinks = getOriginalFullTextLinks(params.originalData)

  return {journalTitle, preprintSource, preprintHostLabel, isPreprint, fullTextLinks}
}

export const getArticleSourceMetadataValue = (value: unknown) => {
  const record = isRecord(value) ? value : null

  if (!record) {
    return null
  }

  const metadata = {
    journalTitle: asNonEmptyString(record.journalTitle),
    preprintSource: asNonEmptyString(record.preprintSource),
    preprintHostLabel: getPreprintHostLabelCandidate(record.preprintHostLabel),
    isPreprint: Boolean(record.isPreprint),
    fullTextLinks: getSourceMetadataLinks(record.fullTextLinks),
  } satisfies ArticleSourceMetadata

  return metadata.journalTitle
    || metadata.preprintSource
    || metadata.preprintHostLabel
    || metadata.isPreprint
    || metadata.fullTextLinks.length > 0
    ? metadata
    : null
}
