import {
  type ArticleStrongIdentifierKind,
  normalizeSourceRowIdentifiers,
} from '../../../../utils/articleIdentifierNormalization.ts'
import {identifierKeySeparator} from './comparisonProjectConflictResolutionImportConstants.ts'
import type {
  NormalizedIdentifierKey,
  SourceIdentifierTier,
} from './comparisonProjectConflictResolutionImportMatchTypes.ts'
import type {ComparisonProjectConflictResolutionImportIdentifier} from './comparisonProjectConflictResolutionImportTypes.ts'
import {getTrimmedText} from './comparisonProjectConflictResolutionImportUtils.ts'

const strongIdentifierKinds = ['doi', 'pmid', 'arxiv'] as const satisfies ArticleStrongIdentifierKind[]

const getStrongIdentifierKind = (value: string | null | undefined) => {
  const normalizedValue = getTrimmedText(value)?.toLowerCase()

  return normalizedValue && strongIdentifierKinds.includes(normalizedValue as ArticleStrongIdentifierKind)
    ? (normalizedValue as ArticleStrongIdentifierKind)
    : null
}

const getIdentifierKeyValue = (identifier: ComparisonProjectConflictResolutionImportIdentifier) => {
  return `${identifier.kind}${identifierKeySeparator}${identifier.normalizedValue}`
}

const getIdentifierMatchKey = (identifier: ComparisonProjectConflictResolutionImportIdentifier) => {
  return identifier.kind === 'doi' ? identifier.normalizedValue : `${identifier.kind}:${identifier.normalizedValue}`
}

const getIdentifierKeyParts = (
  value: string | null | undefined,
): ComparisonProjectConflictResolutionImportIdentifier | null => {
  const trimmedValue = getTrimmedText(value)
  const [kindValue, normalizedValue, ...extraValues] = trimmedValue?.split(identifierKeySeparator) ?? []
  const kind = getStrongIdentifierKind(kindValue)
  const normalizedIdentifierValue = getTrimmedText(normalizedValue)

  return kind && normalizedIdentifierValue && extraValues.length === 0
    ? {kind, normalizedValue: normalizedIdentifierValue}
    : null
}

const getNormalizedIdentifierKey = (params: {
  kind: ArticleStrongIdentifierKind
  source: string
  tier?: SourceIdentifierTier
  value: string | null | undefined
}): NormalizedIdentifierKey | null => {
  const normalizedIdentifiers = normalizeSourceRowIdentifiers([
    {inputKind: params.kind, source: params.source, value: params.value},
  ]).strongIdentifiers
  const identifier = normalizedIdentifiers[0]

  return identifier
    ? {
        key: getIdentifierKeyValue(identifier),
        kind: identifier.kind,
        matchKey: getIdentifierMatchKey(identifier),
        normalizedValue: identifier.normalizedValue,
        ...(params.tier ? {tier: params.tier} : {}),
      }
    : null
}

const getNormalizedIdentifierKeyFromParts = (params: {
  identifier: ComparisonProjectConflictResolutionImportIdentifier
  source: string
  tier?: SourceIdentifierTier
}) => {
  return getNormalizedIdentifierKey({
    kind: params.identifier.kind,
    source: params.source,
    tier: params.tier,
    value: params.identifier.normalizedValue,
  })
}

const getUniqueNormalizedIdentifierKeys = (identifierKeys: readonly NormalizedIdentifierKey[]) => {
  return Array.from(
    identifierKeys
      .reduce<Map<string, NormalizedIdentifierKey>>((identifierMap, identifier) => {
        return identifierMap.has(identifier.key) ? identifierMap : identifierMap.set(identifier.key, identifier)
      }, new Map<string, NormalizedIdentifierKey>())
      .values(),
  )
}

const getCanonicalIdentifierTier = (kind: ArticleStrongIdentifierKind): SourceIdentifierTier => {
  return kind === 'doi' ? 'doi' : 'canonical'
}

const getIdentifierKeysFromCanonicalPairs = (
  identifiers: readonly ComparisonProjectConflictResolutionImportIdentifier[] | null | undefined,
) => {
  return (identifiers ?? []).flatMap((identifier) => {
    const tier = getCanonicalIdentifierTier(identifier.kind)
    const identifierKey = getNormalizedIdentifierKeyFromParts({identifier, source: 'article_identifier', tier})

    return identifierKey ? [identifierKey] : []
  })
}

const getIdentifierKeysFromCanonicalKeyValues = (
  identifierKeys: readonly (string | null | undefined)[] | null | undefined,
) => {
  return (identifierKeys ?? []).flatMap((value) => {
    const identifier = getIdentifierKeyParts(value)
    const tier = identifier ? getCanonicalIdentifierTier(identifier.kind) : null
    const identifierKey =
      identifier && tier ? getNormalizedIdentifierKeyFromParts({identifier, source: 'article_identifier', tier}) : null

    return identifierKey ? [identifierKey] : []
  })
}

const getIdentifierKeysFromDoiValues = (values: readonly (string | null | undefined)[]) => {
  return values.flatMap((value) => {
    const identifierKey = getNormalizedIdentifierKey({kind: 'doi', source: 'doi', tier: 'doi', value})

    return identifierKey ? [identifierKey] : []
  })
}

const getIdentifierKeysFromLegacyFields = (params: {
  arxivId?: string | null
  doi?: string | null
  legacyDoi?: string | null
  pubmedId?: string | null
}) => {
  return [
    ...getIdentifierKeysFromDoiValues([params.doi, params.legacyDoi]),
    getNormalizedIdentifierKey({kind: 'pmid', source: 'pubmed_id', tier: 'legacy', value: params.pubmedId}),
    getNormalizedIdentifierKey({kind: 'arxiv', source: 'arxiv_id', tier: 'legacy', value: params.arxivId}),
  ].filter((identifierKey): identifierKey is NormalizedIdentifierKey => {
    return identifierKey !== null
  })
}

export const getNormalizedIdentifierKeys = (row: {
  arxivId?: string | null
  doi?: string | null
  doiKeys?: readonly (string | null | undefined)[] | null
  identifierKeys?: readonly (string | null | undefined)[] | null
  identifiers?: readonly ComparisonProjectConflictResolutionImportIdentifier[] | null
  legacyDoi?: string | null
  pubmedId?: string | null
}) => {
  return getUniqueNormalizedIdentifierKeys([
    ...getIdentifierKeysFromDoiValues(row.doiKeys ?? []),
    ...getIdentifierKeysFromCanonicalPairs(row.identifiers),
    ...getIdentifierKeysFromCanonicalKeyValues(row.identifierKeys),
    ...getIdentifierKeysFromLegacyFields(row),
  ])
}
