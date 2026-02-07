import {getJournalTitleFromOriginalData} from './getJournalTitleFromOriginalData.ts'

type JournalDisplayArticle = {
  journalTitle?: unknown
  originalData?: unknown
  articleId?: unknown
  importRoute?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const asNonEmptyString = (value: unknown) => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed ? trimmed : null
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
      return Boolean(candidate) && candidate !== 'doi'
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

export const getJournalDisplayTitleForArticle = (article: JournalDisplayArticle) => {
  const fromField = asNonEmptyString(article.journalTitle)
  const fromOriginalData = getJournalTitleFromOriginalData(article.originalData)
  const journalTitle = fromField ?? fromOriginalData

  const sourceFromOriginalData = getPreprintSourceFromOriginalData(article.originalData)
  const sourceFromArticleId = getPreprintSourceFromArticleId(article.articleId)
  const sourceFromImportRoute = getPreprintSourceFromImportRoute(article.importRoute)
  const source = sourceFromOriginalData ?? sourceFromArticleId ?? sourceFromImportRoute

  const isPreprint = Boolean(
    sourceFromArticleId || sourceFromImportRoute || isPreprintInOriginalData(article.originalData),
  )

  return journalTitle ? journalTitle : isPreprint && source ? `(${source})` : null
}
