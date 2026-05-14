import type {PublicationStatus} from '../../db/schemaTypes.ts'
import type {
  ArticleIdentifierEvidence,
  ArticleStrongIdentifierKind,
} from '../../utils/articleIdentifierNormalization.ts'
import {getOrClause, getQuotedStringList, getSqlLiteral} from './appQueryHelpers.ts'
import {
  type CanonicalArticleFieldCandidate,
  getCanonicalArticleSourceTrustRank,
  resolveCanonicalArticleFields,
} from './articleCanonicalFieldResolver.ts'

export type CanonicalArticleMatcherTx = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

export type CanonicalArticleMatchIdentifier = {
  evidence?: ArticleIdentifierEvidence[]
  kind: ArticleStrongIdentifierKind
  normalizedValue: string
  source?: string | null
}

export type CanonicalArticleMatchCandidate = {
  allowUnidentifiedCreate?: boolean
  articleAuthors?: string[] | null
  articleCreatedAt?: Date | string | null
  articleSummary?: string | null
  articleTitle: string
  arxivId?: string | null
  biorxivId?: string | null
  candidateId: string
  doi?: string | null
  importRoute?: string | null
  importRunId?: string | null
  medrxivId?: string | null
  publicationStatus?: PublicationStatus | null
  pubmedId?: string | null
  sourceKind?: string | null
  sourceMetadata?: unknown
  sourceRecordHash?: string | null
  sourceRecordKey?: string | null
  strongIdentifiers: CanonicalArticleMatchIdentifier[]
  url?: string | null
}

export type CanonicalArticleMatchOutcome =
  | {articleId: string; candidateId: string; identifiers: CanonicalArticleMatchIdentifier[]; status: 'create' | 'reuse'}
  | {
      candidateId: string
      identifiers: CanonicalArticleMatchIdentifier[]
      metadata: unknown
      reason:
        | 'batch-too-large'
        | 'conflicting-existing-strong-identifiers'
        | 'identifier-insert-conflict'
        | 'identifier-insert-missing'
        | 'no-strong-identifiers'
      status: 'unresolved'
    }

export type CanonicalArticleMatcherInstrumentation = {
  identifierConflictRereadStatements: string[]
  strongIdentifierLookupStatements: string[]
}

export type CanonicalArticleMatchResult = {
  instrumentation: CanonicalArticleMatcherInstrumentation
  outcomes: CanonicalArticleMatchOutcome[]
}

type ExistingArticleIdentifierRow = {articleId: string; kind: ArticleStrongIdentifierKind; normalizedValue: string}

type CandidateMatchGroup = {
  candidateIds: string[]
  candidates: CanonicalArticleMatchCandidate[]
  groupId: string
  identifiers: CanonicalArticleMatchIdentifier[]
}

type AcceptedGroupPlan = {articleId: string; group: CandidateMatchGroup; status: 'create' | 'reuse'}

type UnresolvedGroupPlan = {
  group: CandidateMatchGroup
  metadata: unknown
  reason: Exclude<CanonicalArticleMatchOutcome, {status: 'create' | 'reuse'}>['reason']
  status: 'unresolved'
}

type GroupPlan = AcceptedGroupPlan | UnresolvedGroupPlan

type IdentifierInsertRecord = {
  articleId: string
  groupId: string
  identifier: CanonicalArticleMatchIdentifier
  isPrimary: boolean
  provenance: unknown
  source: string
}

type IdentifierConflictRecord = {
  groupId: string
  identifier: CanonicalArticleMatchIdentifier
  requestedArticleId: string | null
  winningArticleId: string | null
}

type QuarantineRecord = {
  candidate: CanonicalArticleMatchCandidate
  identifier: CanonicalArticleMatchIdentifier
  metadata: unknown
  reason: string
  requestedArticleId: string | null
  winningArticleId: string | null
}

const canonicalArticleMatchBatchSize = 500
const strongIdentifierKinds = ['doi', 'pmid', 'arxiv'] as const satisfies ArticleStrongIdentifierKind[]

const getValueChunks = <TValue>(values: TValue[], chunkSize = canonicalArticleMatchBatchSize): TValue[][] => {
  return values.length === 0
    ? []
    : values.length <= chunkSize
      ? [values]
      : [values.slice(0, chunkSize), ...getValueChunks(values.slice(chunkSize), chunkSize)]
}

const getStringValue = (value: unknown) => {
  const trimmed = typeof value === 'number' ? String(value).trim() : typeof value === 'string' ? value.trim() : ''

  return trimmed === '' ? null : trimmed
}

const getUniqueValues = (values: string[]) => {
  return Array.from(new Set(values))
}

const getIdentifierKey = (identifier: Pick<CanonicalArticleMatchIdentifier, 'kind' | 'normalizedValue'>) => {
  return `${identifier.kind}\u0000${identifier.normalizedValue}`
}

const getCleanIdentifier = (identifier: CanonicalArticleMatchIdentifier) => {
  const normalizedValue = getStringValue(identifier.normalizedValue)
  const isStrongKind = strongIdentifierKinds.includes(identifier.kind)

  return normalizedValue && isStrongKind ? {...identifier, normalizedValue} : null
}

const getDeduplicatedIdentifiers = (identifiers: CanonicalArticleMatchIdentifier[]) => {
  return Array.from(
    identifiers
      .map(getCleanIdentifier)
      .filter((identifier): identifier is CanonicalArticleMatchIdentifier => {
        return identifier !== null
      })
      .reduce<Map<string, CanonicalArticleMatchIdentifier>>((acc, identifier) => {
        const key = getIdentifierKey(identifier)
        const existing = acc.get(key)
        const evidence = [...(existing?.evidence ?? []), ...(identifier.evidence ?? [])]
        const source = existing?.source ?? identifier.source ?? null

        acc.set(key, {...identifier, evidence, source})
        return acc
      }, new Map())
      .values(),
  )
}

const getCandidateIdentifiers = (candidate: CanonicalArticleMatchCandidate) => {
  return getDeduplicatedIdentifiers(candidate.strongIdentifiers)
}

const getIdentifierToCandidateIds = (candidates: CanonicalArticleMatchCandidate[]) => {
  return candidates.reduce<Map<string, string[]>>((acc, candidate) => {
    getCandidateIdentifiers(candidate).reduce((innerAcc, identifier) => {
      const key = getIdentifierKey(identifier)
      const existing = innerAcc.get(key) ?? []

      innerAcc.set(key, [...existing, candidate.candidateId])
      return innerAcc
    }, acc)

    return acc
  }, new Map())
}

const getCandidateIdsById = (candidates: CanonicalArticleMatchCandidate[]) => {
  return new Map(
    candidates.map((candidate) => {
      return [candidate.candidateId, candidate]
    }),
  )
}

const getConnectedCandidateIds = (params: {
  candidateById: Map<string, CanonicalArticleMatchCandidate>
  candidateIds: string[]
  identifierToCandidateIds: Map<string, string[]>
  visited: Set<string>
}): Set<string> => {
  const newCandidateIds = getUniqueValues(params.candidateIds).filter((candidateId) => {
    return !params.visited.has(candidateId)
  })

  if (newCandidateIds.length === 0) {
    return params.visited
  }

  const visited = newCandidateIds.reduce((acc, candidateId) => {
    acc.add(candidateId)
    return acc
  }, params.visited)
  const nextCandidateIds = newCandidateIds.flatMap((candidateId) => {
    const candidate = params.candidateById.get(candidateId)

    return candidate
      ? getCandidateIdentifiers(candidate).flatMap((identifier) => {
          return params.identifierToCandidateIds.get(getIdentifierKey(identifier)) ?? []
        })
      : []
  })

  return getConnectedCandidateIds({...params, candidateIds: nextCandidateIds, visited})
}

const getCandidateGroups = (
  remainingCandidates: CanonicalArticleMatchCandidate[],
  candidateById: Map<string, CanonicalArticleMatchCandidate>,
  identifierToCandidateIds: Map<string, string[]>,
  groups: CandidateMatchGroup[] = [],
): CandidateMatchGroup[] => {
  const first = remainingCandidates[0]

  if (!first) {
    return groups
  }

  const connectedCandidateIds = getConnectedCandidateIds({
    candidateById,
    candidateIds: [first.candidateId],
    identifierToCandidateIds,
    visited: new Set(),
  })
  const groupCandidates = remainingCandidates.filter((candidate) => {
    return connectedCandidateIds.has(candidate.candidateId)
  })
  const nextRemainingCandidates = remainingCandidates.filter((candidate) => {
    return !connectedCandidateIds.has(candidate.candidateId)
  })
  const candidateIds = groupCandidates.map((candidate) => {
    return candidate.candidateId
  })

  return getCandidateGroups(nextRemainingCandidates, candidateById, identifierToCandidateIds, [
    ...groups,
    {
      candidateIds,
      candidates: groupCandidates,
      groupId: candidateIds[0] ?? crypto.randomUUID(),
      identifiers: getDeduplicatedIdentifiers(groupCandidates.flatMap(getCandidateIdentifiers)),
    },
  ])
}

const getMatchGroups = (candidates: CanonicalArticleMatchCandidate[]) => {
  const candidateById = getCandidateIdsById(candidates)

  return getCandidateGroups(candidates, candidateById, getIdentifierToCandidateIds(candidates))
}

const getIdentifierLookupClause = (identifiers: CanonicalArticleMatchIdentifier[]) => {
  return getOrClause(
    strongIdentifierKinds.map((kind) => {
      const values = getUniqueValues(
        identifiers
          .filter((identifier) => {
            return identifier.kind === kind
          })
          .map((identifier) => {
            return identifier.normalizedValue
          }),
      )

      return values.length > 0
        ? `(kind = '${kind}' AND normalized_value IN (${getQuotedStringList(values).join(', ')}))`
        : null
    }),
  )
}

const getArticleIdentifierLookupStatement = (identifiers: CanonicalArticleMatchIdentifier[]) => {
  const clause = getIdentifierLookupClause(identifiers)

  return clause
    ? `
      SELECT
        kind,
        normalized_value AS normalizedValue,
        article_id AS articleId
      FROM app.article_identifier
      WHERE ${clause}
      ORDER BY kind ASC, normalized_value ASC, article_id ASC
    `
    : null
}

const getExistingArticleIdentifierRows = async (params: {
  identifiers: CanonicalArticleMatchIdentifier[]
  instrumentation: CanonicalArticleMatcherInstrumentation
  phase: 'initial' | 'post-insert'
  tx: CanonicalArticleMatcherTx
}) => {
  return await getValueChunks(getDeduplicatedIdentifiers(params.identifiers)).reduce<
    Promise<ExistingArticleIdentifierRow[]>
  >(async (rowsPromise, identifierChunk) => {
    const rows = await rowsPromise
    const statement = getArticleIdentifierLookupStatement(identifierChunk)

    if (!statement) {
      return rows
    }

    params.instrumentation.strongIdentifierLookupStatements.push(statement)

    if (params.phase === 'post-insert') {
      params.instrumentation.identifierConflictRereadStatements.push(statement)
    }

    const chunkRows = await params.tx.queryJson<ExistingArticleIdentifierRow>(statement)

    return [...rows, ...chunkRows]
  }, Promise.resolve([]))
}

const getIdentifierMatchMap = (rows: ExistingArticleIdentifierRow[]) => {
  return rows.reduce<Map<string, ExistingArticleIdentifierRow>>((acc, row) => {
    return acc.has(getIdentifierKey(row)) ? acc : acc.set(getIdentifierKey(row), row)
  }, new Map())
}

const getGroupMatchedArticleIds = (
  group: CandidateMatchGroup,
  identifierMatchMap: Map<string, ExistingArticleIdentifierRow>,
) => {
  return getUniqueValues(
    group.identifiers
      .map((identifier) => {
        return identifierMatchMap.get(getIdentifierKey(identifier))?.articleId ?? null
      })
      .filter((articleId): articleId is string => {
        return articleId !== null
      }),
  )
}

const getGroupPlan = (
  group: CandidateMatchGroup,
  identifierMatchMap: Map<string, ExistingArticleIdentifierRow>,
): GroupPlan => {
  const matchedArticleIds = getGroupMatchedArticleIds(group, identifierMatchMap)
  const canCreateUnidentifiedArticle = group.candidates.every((candidate) => {
    return candidate.allowUnidentifiedCreate === true
  })

  return group.identifiers.length === 0
    ? canCreateUnidentifiedArticle
      ? {articleId: crypto.randomUUID(), group, status: 'create'}
      : {group, metadata: {candidateIds: group.candidateIds}, reason: 'no-strong-identifiers', status: 'unresolved'}
    : matchedArticleIds.length > 1
      ? {
          group,
          metadata: {candidateIds: group.candidateIds, matchedArticleIds},
          reason: 'conflicting-existing-strong-identifiers',
          status: 'unresolved',
        }
      : matchedArticleIds[0]
        ? {articleId: matchedArticleIds[0], group, status: 'reuse'}
        : {articleId: crypto.randomUUID(), group, status: 'create'}
}

const getCandidateIdentifierValue = (candidate: CanonicalArticleMatchCandidate, kind: ArticleStrongIdentifierKind) => {
  return (
    getStringValue(
      getCandidateIdentifiers(candidate).find((identifier) => {
        return identifier.kind === kind
      })?.normalizedValue,
    ) ?? null
  )
}

const getCanonicalArticleFieldCandidate = (
  candidate: CanonicalArticleMatchCandidate,
): CanonicalArticleFieldCandidate => {
  return {
    articleAuthors: candidate.articleAuthors,
    articleCreatedAt: candidate.articleCreatedAt,
    articleSummary: candidate.articleSummary,
    articleTitle: candidate.articleTitle,
    arxivId: candidate.arxivId ?? getCandidateIdentifierValue(candidate, 'arxiv'),
    biorxivId: candidate.biorxivId,
    doi: candidate.doi ?? getCandidateIdentifierValue(candidate, 'doi'),
    importRoute: candidate.importRoute,
    medrxivId: candidate.medrxivId,
    publicationStatus: candidate.publicationStatus,
    pubmedId: candidate.pubmedId ?? getCandidateIdentifierValue(candidate, 'pmid'),
    sourceKind: candidate.sourceKind,
    sourceMetadata: candidate.sourceMetadata,
    sourceRecordKey: candidate.sourceRecordKey ?? candidate.candidateId,
    url: candidate.url,
  }
}

const getCandidateTrustRank = (candidate: CanonicalArticleMatchCandidate) => {
  return getCanonicalArticleSourceTrustRank({
    importRoute: candidate.importRoute,
    sourceKind: candidate.sourceKind,
    sourceMetadata: candidate.sourceMetadata,
  })
}

const compareCandidates = (left: CanonicalArticleMatchCandidate, right: CanonicalArticleMatchCandidate) => {
  const trustDiff = getCandidateTrustRank(left) - getCandidateTrustRank(right)
  const sourceRecordDiff = (left.sourceRecordKey ?? left.candidateId).localeCompare(
    right.sourceRecordKey ?? right.candidateId,
  )

  return trustDiff || sourceRecordDiff || left.candidateId.localeCompare(right.candidateId)
}

const getResolvedCreateArticleValue = (plan: AcceptedGroupPlan) => {
  const sortedCandidates = [...plan.group.candidates].sort(compareCandidates)
  const baseCandidate = sortedCandidates[0]
  const resolved = resolveCanonicalArticleFields({
    candidates: sortedCandidates.map(getCanonicalArticleFieldCandidate),
    current: null,
  })

  return {
    articleAuthors: resolved.articleAuthors,
    articleCreatedAt: baseCandidate?.articleCreatedAt ?? null,
    articleId: null,
    articleSummary: resolved.articleSummary,
    articleTitle: resolved.articleTitle,
    arxivId: resolved.arxivId,
    biorxivId: resolved.biorxivId,
    doi: resolved.doi,
    id: plan.articleId,
    importRoute: baseCandidate?.importRoute ?? null,
    medrxivId: resolved.medrxivId,
    publicationStatus: resolved.publicationStatus,
    pubmedId: resolved.pubmedId,
    sourceMetadata: resolved.sourceMetadata,
    url: resolved.url,
  }
}

const getCreateArticleInsertValue = (plan: AcceptedGroupPlan) => {
  const value = getResolvedCreateArticleValue(plan)

  return `(${[
    value.id,
    value.articleId,
    value.articleTitle,
    value.articleSummary,
    value.articleAuthors,
    value.articleCreatedAt,
    value.arxivId,
    value.biorxivId,
    value.medrxivId,
    value.doi,
    value.pubmedId,
    value.url,
    value.importRoute,
    value.publicationStatus,
    value.sourceMetadata,
  ]
    .map((entry) => {
      return getSqlLiteral(entry)
    })
    .join(', ')})`
}

const insertCreatedArticles = async (tx: CanonicalArticleMatcherTx, plans: AcceptedGroupPlan[]) => {
  const createPlans = plans.filter((plan) => {
    return plan.status === 'create'
  })

  await getValueChunks(createPlans).reduce<Promise<void>>((previousRun, planChunk) => {
    return previousRun.then(() => {
      return planChunk.length === 0
        ? Promise.resolve()
        : tx.run(`
          INSERT INTO app.article (
            id,
            article_id,
            article_title,
            article_summary,
            article_authors,
            article_created_at,
            arxiv_id,
            biorxiv_id,
            medrxiv_id,
            doi,
            pubmed_id,
            url,
            import_route,
            publication_status,
            source_metadata
          )
          VALUES ${planChunk.map(getCreateArticleInsertValue).join(', ')}
        `)
    })
  }, Promise.resolve())
}

const getIdentifierSource = (identifier: CanonicalArticleMatchIdentifier, group: CandidateMatchGroup) => {
  const evidenceSource = identifier.evidence
    ?.map((entry) => {
      return getStringValue(entry.source)
    })
    .find((value): value is string => {
      return value !== null
    })
  const candidateSource = group.candidates
    .flatMap((candidate) => {
      return [candidate.sourceKind, candidate.importRoute]
    })
    .map(getStringValue)
    .find((value): value is string => {
      return value !== null
    })

  return getStringValue(identifier.source) ?? evidenceSource ?? candidateSource ?? 'canonical_matcher'
}

const getIdentifierInsertRecords = (plans: AcceptedGroupPlan[]) => {
  return plans.flatMap((plan) => {
    return plan.group.identifiers.map((identifier, index): IdentifierInsertRecord => {
      return {
        articleId: plan.articleId,
        groupId: plan.group.groupId,
        identifier,
        isPrimary: index === 0,
        provenance: {
          candidateIds: plan.group.candidateIds,
          evidence: identifier.evidence ?? [],
          sourceRecordKeys: plan.group.candidates.map((candidate) => {
            return candidate.sourceRecordKey ?? candidate.candidateId
          }),
        },
        source: getIdentifierSource(identifier, plan.group),
      }
    })
  })
}

const getIdentifierInsertValue = (record: IdentifierInsertRecord) => {
  return `(${[
    crypto.randomUUID(),
    record.articleId,
    record.identifier.kind,
    record.identifier.normalizedValue,
    record.source,
    record.provenance,
    record.isPrimary,
  ]
    .map((entry) => {
      return getSqlLiteral(entry)
    })
    .join(', ')})`
}

const insertArticleIdentifiers = async (tx: CanonicalArticleMatcherTx, records: IdentifierInsertRecord[]) => {
  await getValueChunks(records).reduce<Promise<void>>((previousRun, recordChunk) => {
    return previousRun.then(() => {
      return recordChunk.length === 0
        ? Promise.resolve()
        : tx.run(`
          INSERT INTO app.article_identifier (
            id,
            article_id,
            kind,
            normalized_value,
            source,
            provenance,
            is_primary
          )
          VALUES ${recordChunk.map(getIdentifierInsertValue).join(', ')}
          ON CONFLICT(kind, normalized_value) DO NOTHING
        `)
    })
  }, Promise.resolve())
}

const getIdentifierInsertConflicts = (
  records: IdentifierInsertRecord[],
  rereadRows: ExistingArticleIdentifierRow[],
) => {
  const rereadMatchMap = getIdentifierMatchMap(rereadRows)

  return records
    .map((record) => {
      const winningRow = rereadMatchMap.get(getIdentifierKey(record.identifier))

      return winningRow && winningRow.articleId !== record.articleId
        ? {
            groupId: record.groupId,
            identifier: record.identifier,
            requestedArticleId: record.articleId,
            winningArticleId: winningRow.articleId,
          }
        : !winningRow
          ? {
              groupId: record.groupId,
              identifier: record.identifier,
              requestedArticleId: record.articleId,
              winningArticleId: null,
            }
          : null
    })
    .filter((conflict): conflict is IdentifierConflictRecord => {
      return conflict !== null
    })
}

const getQuarantineInsertValue = (record: QuarantineRecord) => {
  return `(${[
    crypto.randomUUID(),
    record.candidate.sourceKind ?? null,
    record.candidate.importRunId ?? null,
    record.candidate.sourceRecordKey ?? record.candidate.candidateId,
    record.candidate.sourceRecordHash ?? null,
    record.requestedArticleId,
    record.winningArticleId,
    record.identifier.kind,
    record.identifier.normalizedValue,
    record.reason,
    record.metadata,
  ]
    .map((entry) => {
      return getSqlLiteral(entry)
    })
    .join(', ')})`
}

const insertQuarantineRecords = async (tx: CanonicalArticleMatcherTx, records: QuarantineRecord[]) => {
  await getValueChunks(records).reduce<Promise<void>>((previousRun, recordChunk) => {
    return previousRun.then(() => {
      return recordChunk.length === 0
        ? Promise.resolve()
        : tx.run(`
          INSERT INTO app.article_canonical_match_quarantine (
            id,
            source_kind,
            import_run_id,
            source_record_key,
            source_record_hash,
            requested_article_id,
            winning_article_id,
            kind,
            normalized_value,
            reason,
            metadata
          )
          VALUES ${recordChunk.map(getQuarantineInsertValue).join(', ')}
        `)
    })
  }, Promise.resolve())
}

const getExistingConflictQuarantineRecords = (
  plan: UnresolvedGroupPlan,
  identifierMatchMap: Map<string, ExistingArticleIdentifierRow>,
) => {
  const matchedArticleIds = getGroupMatchedArticleIds(plan.group, identifierMatchMap)

  return plan.reason === 'conflicting-existing-strong-identifiers'
    ? plan.group.candidates.flatMap((candidate) => {
        return plan.group.identifiers
          .map((identifier) => {
            const match = identifierMatchMap.get(getIdentifierKey(identifier))

            return match
              ? {
                  candidate,
                  identifier,
                  metadata: {candidateIds: plan.group.candidateIds, matchedArticleIds},
                  reason: plan.reason,
                  requestedArticleId: null,
                  winningArticleId: match.articleId,
                }
              : null
          })
          .filter((record): record is QuarantineRecord => {
            return record !== null
          })
      })
    : []
}

const getInsertConflictQuarantineRecords = (
  conflicts: IdentifierConflictRecord[],
  acceptedPlanByGroupId: Map<string, AcceptedGroupPlan>,
) => {
  return conflicts.flatMap((conflict) => {
    const plan = acceptedPlanByGroupId.get(conflict.groupId)

    return plan
      ? plan.group.candidates.map((candidate) => {
          return {
            candidate,
            identifier: conflict.identifier,
            metadata: {candidateIds: plan.group.candidateIds, phase: 'identifier-insert-reread'},
            reason: conflict.winningArticleId ? 'identifier-insert-conflict' : 'identifier-insert-missing',
            requestedArticleId: conflict.requestedArticleId,
            winningArticleId: conflict.winningArticleId,
          }
        })
      : []
  })
}

const deleteCreatedArticles = async (tx: CanonicalArticleMatcherTx, articleIds: string[]) => {
  const uniqueArticleIds = getUniqueValues(articleIds)

  await getValueChunks(uniqueArticleIds).reduce<Promise<void>>((previousRun, articleIdChunk) => {
    return previousRun.then(() => {
      return articleIdChunk.length === 0
        ? Promise.resolve()
        : tx
            .run(
              `DELETE FROM app.article_identifier WHERE article_id IN (${getQuotedStringList(articleIdChunk).join(', ')})`,
            )
            .then(() => {
              return tx.run(`DELETE FROM app.article WHERE id IN (${getQuotedStringList(articleIdChunk).join(', ')})`)
            })
    })
  }, Promise.resolve())
}

const getFreshConflictedIdentifierRecords = (
  records: IdentifierInsertRecord[],
  initialMatchMap: Map<string, ExistingArticleIdentifierRow>,
  conflicts: IdentifierConflictRecord[],
) => {
  const conflictedGroupIds = new Set(
    conflicts.map((conflict) => {
      return conflict.groupId
    }),
  )
  const conflictKeys = new Set(
    conflicts.map((conflict) => {
      return getIdentifierKey(conflict.identifier)
    }),
  )

  return records.filter((record) => {
    const key = getIdentifierKey(record.identifier)

    return conflictedGroupIds.has(record.groupId) && !conflictKeys.has(key) && !initialMatchMap.has(key)
  })
}

const deleteFreshConflictedIdentifiers = async (tx: CanonicalArticleMatcherTx, records: IdentifierInsertRecord[]) => {
  await records.reduce<Promise<void>>((previousRun, record) => {
    return previousRun.then(() => {
      return tx.run(`
        DELETE FROM app.article_identifier
        WHERE article_id = ${getSqlLiteral(record.articleId)}
          AND kind = ${getSqlLiteral(record.identifier.kind)}
          AND normalized_value = ${getSqlLiteral(record.identifier.normalizedValue)}
      `)
    })
  }, Promise.resolve())
}

const getAcceptedPlanByGroupId = (plans: GroupPlan[]) => {
  return new Map(
    plans
      .filter((plan): plan is AcceptedGroupPlan => {
        return plan.status === 'create' || plan.status === 'reuse'
      })
      .map((plan) => {
        return [plan.group.groupId, plan]
      }),
  )
}

const getFinalPlans = (plans: GroupPlan[], conflicts: IdentifierConflictRecord[]): GroupPlan[] => {
  const conflictByGroupId = conflicts.reduce<Map<string, IdentifierConflictRecord[]>>((acc, conflict) => {
    const existing = acc.get(conflict.groupId) ?? []

    acc.set(conflict.groupId, [...existing, conflict])
    return acc
  }, new Map())

  return plans.map((plan) => {
    const groupConflicts = conflictByGroupId.get(plan.group.groupId) ?? []
    const missingConflict = groupConflicts.find((conflict) => {
      return conflict.winningArticleId === null
    })

    return plan.status === 'unresolved' || groupConflicts.length === 0
      ? plan
      : {
          group: plan.group,
          metadata: {conflicts: groupConflicts, requestedArticleId: plan.articleId},
          reason: missingConflict ? 'identifier-insert-missing' : 'identifier-insert-conflict',
          status: 'unresolved',
        }
  })
}

const getOutcomeFromPlan = (
  plan: GroupPlan,
  candidate: CanonicalArticleMatchCandidate,
): CanonicalArticleMatchOutcome => {
  return plan.status === 'unresolved'
    ? {
        candidateId: candidate.candidateId,
        identifiers: getCandidateIdentifiers(candidate),
        metadata: plan.metadata,
        reason: plan.reason,
        status: 'unresolved',
      }
    : {
        articleId: plan.articleId,
        candidateId: candidate.candidateId,
        identifiers: getCandidateIdentifiers(candidate),
        status: plan.status,
      }
}

const getOutcomes = (candidates: CanonicalArticleMatchCandidate[], plans: GroupPlan[]) => {
  const planByCandidateId = new Map(
    plans.flatMap((plan) => {
      return plan.group.candidateIds.map((candidateId) => {
        return [candidateId, plan] as const
      })
    }),
  )

  return candidates.map((candidate) => {
    const plan = planByCandidateId.get(candidate.candidateId)

    return plan
      ? getOutcomeFromPlan(plan, candidate)
      : {
          candidateId: candidate.candidateId,
          identifiers: getCandidateIdentifiers(candidate),
          metadata: {candidateId: candidate.candidateId},
          reason: 'no-strong-identifiers',
          status: 'unresolved',
        }
  })
}

const getBatchTooLargeResult = (
  candidates: CanonicalArticleMatchCandidate[],
  maxBatchSize: number,
): CanonicalArticleMatchResult => {
  return {
    instrumentation: {identifierConflictRereadStatements: [], strongIdentifierLookupStatements: []},
    outcomes: candidates.map((candidate) => {
      return {
        candidateId: candidate.candidateId,
        identifiers: getCandidateIdentifiers(candidate),
        metadata: {batchSize: candidates.length, maxBatchSize},
        reason: 'batch-too-large',
        status: 'unresolved',
      }
    }),
  }
}

export const matchCanonicalArticlesWithTx = async (
  tx: CanonicalArticleMatcherTx,
  candidates: CanonicalArticleMatchCandidate[],
  options: {maxBatchSize?: number} = {},
): Promise<CanonicalArticleMatchResult> => {
  const maxBatchSize = options.maxBatchSize ?? canonicalArticleMatchBatchSize
  const instrumentation: CanonicalArticleMatcherInstrumentation = {
    identifierConflictRereadStatements: [],
    strongIdentifierLookupStatements: [],
  }

  if (candidates.length > maxBatchSize) {
    return getBatchTooLargeResult(candidates, maxBatchSize)
  }

  const groups = getMatchGroups(candidates)
  const batchIdentifiers = groups.flatMap((group) => {
    return group.identifiers
  })
  const existingIdentifierRows = await getExistingArticleIdentifierRows({
    identifiers: batchIdentifiers,
    instrumentation,
    phase: 'initial',
    tx,
  })
  const initialMatchMap = getIdentifierMatchMap(existingIdentifierRows)
  const plans = groups.map((group) => {
    return getGroupPlan(group, initialMatchMap)
  })
  const acceptedPlans = plans.filter((plan): plan is AcceptedGroupPlan => {
    return plan.status === 'create' || plan.status === 'reuse'
  })
  const existingConflictQuarantineRecords = plans.flatMap((plan) => {
    return plan.status === 'unresolved' ? getExistingConflictQuarantineRecords(plan, initialMatchMap) : []
  })

  await insertQuarantineRecords(tx, existingConflictQuarantineRecords)
  await insertCreatedArticles(tx, acceptedPlans)

  const identifierInsertRecords = getIdentifierInsertRecords(acceptedPlans)

  await insertArticleIdentifiers(tx, identifierInsertRecords)

  const rereadIdentifierRows = await getExistingArticleIdentifierRows({
    identifiers: identifierInsertRecords.map((record) => {
      return record.identifier
    }),
    instrumentation,
    phase: 'post-insert',
    tx,
  })
  const insertConflicts = getIdentifierInsertConflicts(identifierInsertRecords, rereadIdentifierRows)
  const acceptedPlanByGroupId = getAcceptedPlanByGroupId(plans)
  const insertedConflictQuarantineRecords = getInsertConflictQuarantineRecords(insertConflicts, acceptedPlanByGroupId)
  const conflictedCreateArticleIds = getUniqueValues(
    insertConflicts
      .map((conflict) => {
        const plan = acceptedPlanByGroupId.get(conflict.groupId)

        return plan?.status === 'create' ? plan.articleId : null
      })
      .filter((articleId): articleId is string => {
        return articleId !== null
      }),
  )
  const freshConflictedIdentifierRecords = getFreshConflictedIdentifierRecords(
    identifierInsertRecords,
    initialMatchMap,
    insertConflicts,
  )

  await insertQuarantineRecords(tx, insertedConflictQuarantineRecords)
  await deleteFreshConflictedIdentifiers(tx, freshConflictedIdentifierRecords)
  await deleteCreatedArticles(tx, conflictedCreateArticleIds)

  return {instrumentation, outcomes: getOutcomes(candidates, getFinalPlans(plans, insertConflicts))}
}
