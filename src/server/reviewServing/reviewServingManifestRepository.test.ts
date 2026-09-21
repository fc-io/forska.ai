import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

import {duckdbEngineCompatibilityOptions} from '../utils/duckdbEngineContract.ts'
import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import {
  cleanupStaleCandidateReviewServingSnapshotManifests,
  createCandidateReviewServingSnapshotManifest,
  failStaleCandidateReviewServingSnapshotManifests,
  failSupersededCandidateReviewServingSnapshotManifests,
  getActiveOrLastKnownGoodReviewServingSnapshotManifest,
  getActiveReviewServingSnapshotManifest,
  getCandidateReviewServingSnapshotSupersessionRows,
  getLastKnownGoodReviewServingSnapshotManifest,
  getReviewServingProjectionIdentityManifest,
  getReviewServingProjectsWithStaleCandidateSnapshots,
  getReviewServingSnapshotManifest,
  markCandidateReviewServingSnapshotManifestFailed,
  retireObsoleteReviewServingSnapshotManifests,
  type ReviewServingManifestRepositoryDatabase,
  type ReviewServingManifestRepositoryTransaction,
  type ReviewServingProjectionIdentityManifest,
  type ReviewServingSnapshotManifest,
  upsertReviewServingProjectionIdentityManifest,
} from './reviewServingManifestRepository.ts'
import {promoteReviewServingProjectorSnapshot} from './reviewServingProjectorWriter.ts'

type FakeProjectionRow = ReviewServingProjectionIdentityManifest
type FakeSnapshotRow = Omit<ReviewServingSnapshotManifest, 'status'> & {
  activatedAt: string | null
  createdAt?: string
  status: ReviewServingSnapshotManifest['status']
  updatedAt: string
}
type FakeChunkAvailabilityRow = {
  completedChunkCount: number
  component: string
  maxChunkUpdatedAt?: string | null
  outputBaseGeneration: number
  projectionIdentity: string
  requestCreatedAt?: string | null
  requestId?: string | null
  requestStatus?: string | null
  requestUpdatedAt?: string | null
  totalChunkCount: number
}

const componentState = {
  optional: [],
  required: [
    {
      baseGeneration: '1',
      component: 'display',
      patchWatermark: '3',
      projectionIdentity: 'display:identity-1',
      requirement: 'required',
    },
  ],
} as const

const baseSnapshotInput = {
  componentRequirements: {optionalComponents: [], requiredComponents: ['display']},
  componentState,
  composedIdentity: {route: 'review.llm.rows', version: 1},
  projectId: 'project-1',
  reviewConfigHash: 'review-config-1',
  selectedImportSnapshotId: 'selected-import-1',
  snapshotId: 'snapshot-1',
  sourceWatermarks: {reviewChange: 10},
} as const

const getSqlStrings = (statement: string) => {
  return [...statement.matchAll(/'((?:''|[^'])*)'/g)].map((match) => {
    return match[1]?.replaceAll("''", "'") ?? ''
  })
}

const getAssignmentValue = (statement: string, columnName: string) => {
  return (
    statement.match(
      new RegExp(`(?<![A-Za-z0-9_])${columnName}\\s*=\\s*(NULL|'(?:''|[^'])*'(?:\\s*::JSON)?|\\d+)`, 'u'),
    )?.[1] ?? null
  )
}

const decodeSqlValue = (value: string | null) => {
  if (value === null || value === 'NULL') {
    return null
  }

  return value
    .replace(/^'/u, '')
    .replace(/'(?:\s*::JSON)?$/u, '')
    .replaceAll("''", "'")
}

const getSqlValueList = (statement: string) => {
  const valueList = statement.match(/VALUES\s*\(([\s\S]*?)\)\s*$/u)?.[1] ?? ''
  const values: string[] = []
  let current = ''
  let inString = false

  for (let index = 0; index < valueList.length; index += 1) {
    const char = valueList[index]

    if (char === "'") {
      const next = valueList[index + 1]

      if (inString && next === "'") {
        current += "''"
        index += 1
        continue
      }

      inString = !inString
      current += char
      continue
    }

    if (char === ',' && !inString) {
      values.push(current.trim())
      current = ''
      continue
    }

    current += char
  }

  if (current.trim() !== '') {
    values.push(current.trim())
  }

  return values
}

const getAssignmentLiteral = (statement: string, columnName: string) => {
  return decodeSqlValue(getAssignmentValue(statement, columnName))
}

const getAssignmentNumber = (statement: string, columnName: string) => {
  const value = getAssignmentValue(statement, columnName)

  return value === null || value === 'NULL' ? null : Number(value)
}

const getAssignmentJson = <T>(statement: string, columnName: string, fallback: T) => {
  const value = getAssignmentLiteral(statement, columnName)

  return value === null ? fallback : (JSON.parse(value) as T)
}

const getWhereLiteral = (statement: string, columnName: string) => {
  return (
    statement
      .match(new RegExp(`(?<![A-Za-z0-9_])${columnName}\\s*=\\s*'((?:''|[^'])*)'`, 'u'))?.[1]
      ?.replaceAll("''", "'") ?? null
  )
}

const getConcatWhereLiteral = (statement: string, columnName: string) => {
  return (
    statement
      .match(new RegExp(`\\(${columnName}\\s*\\|\\|\\s*''\\)\\s*=\\s*\\('((?:''|[^'])*)'\\s*\\|\\|\\s*''\\)`, 'u'))?.[1]
      ?.replaceAll("''", "'") ?? null
  )
}

const getNotEqualLiteral = (statement: string, columnName: string) => {
  return (
    statement
      .match(new RegExp(`(?<![A-Za-z0-9_])${columnName}\\s*<>\\s*'((?:''|[^'])*)'`, 'u'))?.[1]
      ?.replaceAll("''", "'") ?? null
  )
}

const createFakeManifestDatabase = (
  initialSnapshots: FakeSnapshotRow[] = [],
  options: {
    chunkAvailabilityRows?: FakeChunkAvailabilityRow[]
    inFlightSnapshotIds?: string[]
    selectedImportSnapshotStatus?: string
  } = {},
) => {
  const projections = new Map<string, FakeProjectionRow>()
  const projectionPhysicalRows = new Map<string, number>()
  const snapshots = new Map<string, FakeSnapshotRow>()
  const snapshotPhysicalRows = new Map<string, number>()
  const statements: string[] = []
  const getSnapshotKey = (projectId: string, snapshotId: string) => {
    return `${projectId}:${snapshotId}`
  }
  const getClock = () => {
    return new Date(2026, 5, 16, 12, statements.length).toISOString()
  }
  const upsertProjection = (statement: string) => {
    const values = getSqlValueList(statement)
    const manifestId = decodeSqlValue(values[0] ?? null) ?? ''
    const existing = projections.get(manifestId)
    const getNullableNumberValue = (value: string | undefined) => {
      return value === undefined || value === 'NULL' ? null : Number(value)
    }
    const row = {
      baseGeneration: Number(values[4] ?? 0),
      definitionVersion: decodeSqlValue(values[11] ?? null) ?? '',
      inputDigest: decodeSqlValue(values[10] ?? null),
      inputWatermark: Number(values[8] ?? 0),
      inputWatermarks: JSON.parse(decodeSqlValue(values[9] ?? null) ?? '{}') as FakeProjectionRow['inputWatermarks'],
      invalidationReason: decodeSqlValue(values[15] ?? null),
      manifestId,
      patchRangeEnd: getNullableNumberValue(values[7]),
      patchRangeStart: getNullableNumberValue(values[6]),
      patchWatermark: Number(values[5] ?? 0),
      projectId: decodeSqlValue(values[1] ?? null),
      projectionComponent: (decodeSqlValue(values[2] ?? null) ?? 'display') as FakeProjectionRow['projectionComponent'],
      projectionIdentity: decodeSqlValue(values[3] ?? null) ?? '',
      promptConfigHash: decodeSqlValue(values[13] ?? null),
      reviewConfigHash: decodeSqlValue(values[12] ?? null),
      status: (decodeSqlValue(values[14] ?? null) ?? 'candidate') as FakeProjectionRow['status'],
    }

    projections.set(manifestId, {...existing, ...row})
    projectionPhysicalRows.set(manifestId, (projectionPhysicalRows.get(manifestId) ?? 0) + 1)
  }
  const deleteProjection = (statement: string) => {
    const manifestId = getWhereLiteral(statement, 'manifest_id') ?? ''
    projections.delete(manifestId)
    projectionPhysicalRows.delete(manifestId)
  }
  const updateProjection = (statement: string) => {
    const manifestId = getWhereLiteral(statement, 'manifest_id') ?? ''
    const existing = projections.get(manifestId)

    if (existing === undefined) {
      return
    }

    projections.set(manifestId, {
      ...existing,
      baseGeneration: getAssignmentNumber(statement, 'base_generation') ?? existing.baseGeneration,
      definitionVersion: getAssignmentLiteral(statement, 'definition_version') ?? existing.definitionVersion,
      inputDigest: getAssignmentLiteral(statement, 'input_digest'),
      inputWatermark: getAssignmentNumber(statement, 'input_watermark') ?? existing.inputWatermark,
      inputWatermarks: getAssignmentJson(statement, 'input_watermarks_json', existing.inputWatermarks),
      invalidationReason: getAssignmentLiteral(statement, 'invalidation_reason'),
      patchRangeEnd: getAssignmentNumber(statement, 'patch_range_end'),
      patchRangeStart: getAssignmentNumber(statement, 'patch_range_start'),
      patchWatermark: getAssignmentNumber(statement, 'patch_watermark') ?? existing.patchWatermark,
      promptConfigHash: getAssignmentLiteral(statement, 'prompt_config_hash'),
      reviewConfigHash: getAssignmentLiteral(statement, 'review_config_hash'),
      status: (getAssignmentLiteral(statement, 'status') ?? existing.status) as FakeProjectionRow['status'],
    })
  }
  const upsertCandidate = (statement: string) => {
    const values = getSqlValueList(statement)
    const projectId = decodeSqlValue(values[0] ?? null) ?? ''
    const snapshotId = decodeSqlValue(values[1] ?? null) ?? ''
    const reviewConfigHash = decodeSqlValue(values[3] ?? null)
    const existing = snapshots.get(getSnapshotKey(projectId, snapshotId))

    snapshots.set(getSnapshotKey(projectId, snapshotId), {
      activatedAt: existing?.activatedAt ?? null,
      componentState: JSON.parse(
        decodeSqlValue(values[5] ?? null) ?? '{"optional":[],"required":[]}',
      ) as FakeSnapshotRow['componentState'],
      composedIdentity: JSON.parse(decodeSqlValue(values[4] ?? null) ?? '{}') as FakeSnapshotRow['composedIdentity'],
      createdAt: getClock(),
      lastError: null,
      lastKnownGoodSnapshotId: decodeSqlValue(values[11] ?? null),
      optionalComponents: JSON.parse(
        decodeSqlValue(values[7] ?? null) ?? '[]',
      ) as FakeSnapshotRow['optionalComponents'],
      projectId,
      requiredComponents: JSON.parse(
        decodeSqlValue(values[6] ?? null) ?? '[]',
      ) as FakeSnapshotRow['requiredComponents'],
      reviewConfigHash,
      selectedImportSnapshotId: decodeSqlValue(values[10] ?? null),
      snapshotId,
      sourceWatermarks: JSON.parse(decodeSqlValue(values[8] ?? null) ?? '{}') as FakeSnapshotRow['sourceWatermarks'],
      status: 'candidate',
      updatedAt: getClock(),
      validationResult: JSON.parse(decodeSqlValue(values[9] ?? null) ?? 'null') as FakeSnapshotRow['validationResult'],
    })
    const snapshotKey = getSnapshotKey(projectId, snapshotId)
    snapshotPhysicalRows.set(snapshotKey, (snapshotPhysicalRows.get(snapshotKey) ?? 0) + 1)
  }
  const deleteCandidate = (statement: string) => {
    const snapshotKey = getSnapshotKey(
      getConcatWhereLiteral(statement, 'project_id') ?? '',
      getConcatWhereLiteral(statement, 'snapshot_id') ?? '',
    )
    snapshots.delete(snapshotKey)
    snapshotPhysicalRows.delete(snapshotKey)
  }
  const markFailed = (statement: string) => {
    const projectId = getWhereLiteral(statement, 'project_id') ?? ''
    const snapshotId = getWhereLiteral(statement, 'snapshot_id') ?? ''
    const existing = snapshots.get(getSnapshotKey(projectId, snapshotId))

    if (existing?.status === 'candidate') {
      snapshots.set(getSnapshotKey(projectId, snapshotId), {
        ...existing,
        lastError: getSqlStrings(statement)[1] ?? null,
        status: 'failed',
        updatedAt: getClock(),
      })
    }
  }
  const retireActive = (statement: string) => {
    const projectId = getWhereLiteral(statement, 'project_id') ?? ''
    snapshots.forEach((snapshot, key) => {
      const sameProject = snapshot.projectId === projectId
      const sameConfig = statement.includes(`review_config_hash IS NOT DISTINCT FROM '${snapshot.reviewConfigHash}'`)
      const excludedSnapshotId = getNotEqualLiteral(statement, 'snapshot_id')

      if (sameProject && sameConfig && snapshot.status === 'active' && snapshot.snapshotId !== excludedSnapshotId) {
        snapshots.set(key, {...snapshot, status: 'retired', updatedAt: getClock()})
      }
    })
  }
  const activateCandidate = (statement: string) => {
    const projectId = getWhereLiteral(statement, 'project_id') ?? ''
    const snapshotId = getWhereLiteral(statement, 'snapshot_id') ?? ''
    const existing = snapshots.get(getSnapshotKey(projectId, snapshotId))

    if (existing?.status === 'candidate') {
      snapshots.set(getSnapshotKey(projectId, snapshotId), {
        ...existing,
        activatedAt: getClock(),
        lastError: null,
        lastKnownGoodSnapshotId: getSqlStrings(statement)[1] ?? null,
        status: 'active',
        updatedAt: getClock(),
      })
    }
  }
  const retireObsolete = (statement: string) => {
    const projectId = getWhereLiteral(statement, 'project_id') ?? ''
    const keepSnapshotIds = getSqlStrings(statement).slice(2)

    snapshots.forEach((snapshot, key) => {
      if (
        snapshot.projectId === projectId
        && snapshot.status !== 'active'
        && !keepSnapshotIds.includes(snapshot.snapshotId)
      ) {
        snapshots.set(key, {...snapshot, status: 'retired', updatedAt: getClock()})
      }
    })
  }
  const queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (statement.includes('AS hasInFlightRebuild')) {
      const projectId = getWhereLiteral(statement, 'project_id') ?? ''
      const referenceIsActive = statement.includes("snapshot_status = 'active'")
      const referenceSnapshotId = referenceIsActive ? null : getWhereLiteral(statement, 'snapshot_id')
      const candidateSnapshotId =
        statement.match(/candidate\.snapshot_id\s*=\s*'((?:''|[^'])*)'/u)?.[1]?.replaceAll("''", "'") ?? null
      const getCreatedAtMs = (snapshot: FakeSnapshotRow) => {
        return Date.parse(snapshot.createdAt ?? snapshot.updatedAt)
      }
      const references = [...snapshots.values()].filter((snapshot) => {
        return (
          snapshot.projectId === projectId
          && (referenceIsActive ? snapshot.status === 'active' : snapshot.snapshotId === referenceSnapshotId)
        )
      })

      return [...snapshots.values()]
        .filter((snapshot) => {
          return (
            snapshot.projectId === projectId
            && snapshot.status === 'candidate'
            && (candidateSnapshotId === null || snapshot.snapshotId === candidateSnapshotId)
          )
        })
        .sort((left, right) => {
          return getCreatedAtMs(left) - getCreatedAtMs(right) || left.snapshotId.localeCompare(right.snapshotId)
        })
        .flatMap((candidate) => {
          return references
            .filter((reference) => {
              return (
                reference.reviewConfigHash === candidate.reviewConfigHash
                && reference.snapshotId !== candidate.snapshotId
              )
            })
            .map((reference) => {
              const referenceAtMs = Date.parse(reference.activatedAt ?? reference.createdAt ?? reference.updatedAt)

              return {
                createdAt: candidate.createdAt ?? candidate.updatedAt,
                hasInFlightRebuild: (options.inFlightSnapshotIds ?? []).includes(candidate.snapshotId),
                isOlderThanReference: getCreatedAtMs(candidate) < referenceAtMs,
                lastError: candidate.lastError,
                referenceSnapshotId: reference.snapshotId,
                reviewConfigHash: candidate.reviewConfigHash,
                snapshotId: candidate.snapshotId,
              }
            })
        }) as T[]
    }

    if (statement.includes('FROM app.review_selected_import_snapshot')) {
      return [{status: options.selectedImportSnapshotStatus ?? 'completed'}] as T[]
    }

    if (statement.includes('app.review_rebuild_chunk_manifest')) {
      return (options.chunkAvailabilityRows ?? []) as T[]
    }

    if (statement.includes('app.review_projection_identity_manifest')) {
      if (statement.includes('status AS projectionStatus')) {
        return [...projections.values()].map((projection) => {
          return {
            baseGeneration: projection.baseGeneration,
            component: projection.projectionComponent,
            projectionIdentity: projection.projectionIdentity,
            projectionStatus: projection.status,
          }
        }) as T[]
      }

      const manifestId = getWhereLiteral(statement, 'manifest_id') ?? ''
      const projection = projections.get(manifestId)
      return (
        projection === undefined
          ? []
          : [
              {
                ...projection,
                inputDigest: projection.inputDigest,
                inputWatermark: projection.inputWatermark,
                inputWatermarksJson: JSON.stringify(projection.inputWatermarks),
                invalidationReason: projection.invalidationReason,
              },
            ]
      ) as T[]
    }

    if (statement.includes("snapshot_status IN ('active', 'retired')")) {
      return [...snapshots.values()]
        .filter((snapshot) => {
          return (
            snapshot.projectId === (getWhereLiteral(statement, 'project_id') ?? '')
            && (snapshot.status === 'active' || snapshot.status === 'retired')
          )
        })
        .sort((left, right) => {
          const statusOrder = Number(left.status !== 'active') - Number(right.status !== 'active')
          const leftActivatedAt = left.activatedAt ?? left.updatedAt
          const rightActivatedAt = right.activatedAt ?? right.updatedAt

          return statusOrder === 0 ? rightActivatedAt.localeCompare(leftActivatedAt) : statusOrder
        })
        .map(getSnapshotQueryRow) as T[]
    }

    if (statement.includes('snapshot_id =')) {
      const projectId = getWhereLiteral(statement, 'project_id') ?? 'project-1'
      const snapshotId = getWhereLiteral(statement, 'snapshot_id') ?? ''
      const snapshot = snapshots.get(getSnapshotKey(projectId, snapshotId))
      return (snapshot === undefined ? [] : [getSnapshotQueryRow(snapshot)]) as T[]
    }

    if (statement.includes("snapshot_status = 'active'")) {
      return [...snapshots.values()]
        .filter((snapshot) => {
          return snapshot.projectId === (getWhereLiteral(statement, 'project_id') ?? '') && snapshot.status === 'active'
        })
        .map(getSnapshotQueryRow) as T[]
    }

    if (statement.includes("snapshot_status = 'retired'")) {
      return [...snapshots.values()]
        .filter((snapshot) => {
          return (
            snapshot.projectId === (getWhereLiteral(statement, 'project_id') ?? '') && snapshot.status === 'retired'
          )
        })
        .sort((left, right) => {
          const leftActivatedAt = left.activatedAt ?? left.updatedAt
          const rightActivatedAt = right.activatedAt ?? right.updatedAt

          return rightActivatedAt.localeCompare(leftActivatedAt)
        })
        .map(getSnapshotQueryRow) as T[]
    }

    return []
  }
  const run = async (statement: string) => {
    statements.push(statement)

    if (statement.includes('INSERT INTO app.review_projection_identity_manifest')) {
      upsertProjection(statement)
    }

    if (statement.includes('DELETE FROM app.review_projection_identity_manifest')) {
      deleteProjection(statement)
    }

    if (statement.includes('UPDATE app.review_projection_identity_manifest')) {
      updateProjection(statement)
    }

    if (statement.includes('INSERT INTO app.review_serving_snapshot_manifest')) {
      upsertCandidate(statement)
    }

    if (statement.includes('DELETE FROM app.review_serving_snapshot_manifest')) {
      deleteCandidate(statement)
    }

    if (statement.includes("snapshot_status = 'failed'")) {
      markFailed(statement)
    }

    if (statement.includes("snapshot_status = 'retired'") && statement.includes("snapshot_status = 'active'")) {
      retireActive(statement)
    }

    if (statement.includes("snapshot_status = 'active'") && statement.includes("snapshot_status = 'candidate'")) {
      activateCandidate(statement)
    }

    if (statement.includes("snapshot_status <> 'active'")) {
      retireObsolete(statement)
    }
  }
  const database: ReviewServingManifestRepositoryDatabase = {
    queryJson,
    run,
    transaction: async (operation) => {
      return operation({queryJson, run})
    },
  }

  initialSnapshots.forEach((snapshot) => {
    const snapshotKey = getSnapshotKey(snapshot.projectId, snapshot.snapshotId)
    snapshots.set(snapshotKey, snapshot)
    snapshotPhysicalRows.set(snapshotKey, (snapshotPhysicalRows.get(snapshotKey) ?? 0) + 1)
  })

  return {database, projectionPhysicalRows, projections, snapshotPhysicalRows, snapshots, statements}
}

const getSnapshotQueryRow = (snapshot: FakeSnapshotRow) => {
  return {
    componentStateJson: JSON.stringify(snapshot.componentState),
    composedIdentityJson: JSON.stringify(snapshot.composedIdentity),
    lastError: snapshot.lastError,
    lastKnownGoodSnapshotId: snapshot.lastKnownGoodSnapshotId,
    optionalComponentsJson: JSON.stringify(snapshot.optionalComponents),
    projectId: snapshot.projectId,
    requiredComponentsJson: JSON.stringify(snapshot.requiredComponents),
    reviewConfigHash: snapshot.reviewConfigHash,
    selectedImportSnapshotId: snapshot.selectedImportSnapshotId,
    snapshotId: snapshot.snapshotId,
    snapshotStatus: snapshot.status,
    sourceWatermarksJson: JSON.stringify(snapshot.sourceWatermarks),
    validationResultJson: snapshot.validationResult === null ? null : JSON.stringify(snapshot.validationResult),
  }
}

test('projection identity manifest upsert replaces one no-index logical row for project component identity', async () => {
  const {database, projections, statements} = createFakeManifestDatabase()
  const input = {
    baseGeneration: 2,
    definitionVersion: 'display-v1',
    inputDigest: 'input-digest-1',
    inputWatermark: 42,
    inputWatermarks: {reviewChange: 42},
    patchRangeEnd: 5,
    patchRangeStart: 3,
    patchWatermark: 7,
    projectId: 'project-1',
    projectionComponent: 'display',
    projectionIdentity: 'display:identity-1',
    promptConfigHash: null,
    reviewConfigHash: 'review-config-1',
    status: 'candidate',
  } as const
  const first = await upsertReviewServingProjectionIdentityManifest(input, database)
  const second = await upsertReviewServingProjectionIdentityManifest({...input, status: 'active'}, database)
  const manifest = await getReviewServingProjectionIdentityManifest(input, database)

  expect(first.manifestId).toBe(second.manifestId)
  expect(projections.size).toBe(1)
  expect(manifest?.manifestId).toBe(first.manifestId)
  expect(manifest?.status).toBe('active')

  const manifestWrites = statements.filter((statement) => {
    return (
      statement.includes('INSERT INTO app.review_projection_identity_manifest')
      || statement.includes('DELETE FROM app.review_projection_identity_manifest')
    )
  })
  expect(manifestWrites).toHaveLength(4)
  expect(manifestWrites[0]).toContain('DELETE FROM app.review_projection_identity_manifest')
  expect(manifestWrites[1]).toContain('INSERT INTO app.review_projection_identity_manifest')
  expect(manifestWrites[2]).toContain('DELETE FROM app.review_projection_identity_manifest')
  expect(manifestWrites[3]).toContain('INSERT INTO app.review_projection_identity_manifest')
  expect(manifestWrites.join('\n')).not.toContain('UPDATE app.review_projection_identity_manifest')
  expect(manifestWrites.join('\n')).not.toContain('ON CONFLICT(manifest_id)')
})

test('projection identity manifest preserves prior source watermark coverage on partial updates', async () => {
  const {database} = createFakeManifestDatabase()
  const baseInput = {
    baseGeneration: 0,
    definitionVersion: 'humanStatus:v1',
    inputDigest: 'freshReviewServingSnapshot',
    inputWatermark: 100,
    inputWatermarks: {projectScope: 100, reviewChange: 75},
    patchRangeEnd: 0,
    patchRangeStart: 0,
    patchWatermark: 0,
    projectId: 'project-1',
    projectionComponent: 'humanStatus',
    projectionIdentity: 'humanStatus:identity-1',
    promptConfigHash: null,
    reviewConfigHash: 'review-config-1',
    status: 'candidate',
  } as const

  await upsertReviewServingProjectionIdentityManifest(baseInput, database)
  await upsertReviewServingProjectionIdentityManifest(
    {
      ...baseInput,
      inputDigest: 'project.updated',
      inputWatermark: 25,
      inputWatermarks: {projectScope: 125},
      patchRangeEnd: 125,
      patchRangeStart: 125,
      patchWatermark: 125,
    },
    database,
  )

  const manifest = await getReviewServingProjectionIdentityManifest(baseInput, database)

  expect(manifest).toMatchObject({
    inputWatermark: 100,
    inputWatermarks: {projectScope: 125, reviewChange: 75},
    patchWatermark: 125,
  })
})

test('projection identity manifest rewrites unchanged input to collapse no-index duplicates', async () => {
  const {database, projectionPhysicalRows, statements} = createFakeManifestDatabase()
  const input = {
    baseGeneration: 2,
    definitionVersion: 'display-v1',
    inputDigest: 'input-digest-1',
    inputWatermark: 42,
    inputWatermarks: {reviewChange: 42},
    patchRangeEnd: 5,
    patchRangeStart: 3,
    patchWatermark: 7,
    projectId: 'project-1',
    projectionComponent: 'display',
    projectionIdentity: 'display:identity-1',
    promptConfigHash: null,
    reviewConfigHash: 'review-config-1',
    status: 'candidate',
  } as const

  const first = await upsertReviewServingProjectionIdentityManifest(input, database)
  projectionPhysicalRows.set(first.manifestId, 2)
  await upsertReviewServingProjectionIdentityManifest(input, database)

  const manifestWrites = statements.filter((statement) => {
    return (
      statement.includes('INSERT INTO app.review_projection_identity_manifest')
      || statement.includes('DELETE FROM app.review_projection_identity_manifest')
    )
  })

  expect(manifestWrites).toHaveLength(4)
  expect(manifestWrites[0]).toContain('DELETE FROM app.review_projection_identity_manifest')
  expect(manifestWrites[1]).toContain('INSERT INTO app.review_projection_identity_manifest')
  expect(manifestWrites[2]).toContain('DELETE FROM app.review_projection_identity_manifest')
  expect(manifestWrites[3]).toContain('INSERT INTO app.review_projection_identity_manifest')
  expect(projectionPhysicalRows.get(first.manifestId)).toBe(1)
  expect(manifestWrites.join('\n')).not.toContain('UPDATE app.review_projection_identity_manifest')
  expect(manifestWrites.join('\n')).not.toContain('WHERE NOT EXISTS')
})

test('candidate snapshot manifest replaces one no-index logical row without DuckDB ON CONFLICT writes', async () => {
  const {database, snapshotPhysicalRows, statements} = createFakeManifestDatabase()

  await createCandidateReviewServingSnapshotManifest(baseSnapshotInput, database)
  snapshotPhysicalRows.set('project-1:snapshot-1', 2)
  await createCandidateReviewServingSnapshotManifest(baseSnapshotInput, database)

  const manifestWrites = statements.filter((statement) => {
    return statement.includes('app.review_serving_snapshot_manifest')
  })
  const joined = manifestWrites.join('\n')

  expect(joined).toContain('DELETE FROM app.review_serving_snapshot_manifest')
  expect(joined).toContain('INSERT INTO app.review_serving_snapshot_manifest')
  expect(snapshotPhysicalRows.get('project-1:snapshot-1')).toBe(1)
  expect(joined).not.toContain('UPDATE app.review_serving_snapshot_manifest')
  expect(joined).not.toContain('WHERE NOT EXISTS')
  expect(joined).not.toContain('ON CONFLICT(project_id, snapshot_id)')
})

test('failed candidate snapshot preserves active and last-known-good manifests', async () => {
  const activeSnapshot: FakeSnapshotRow = {
    ...baseSnapshotInput,
    activatedAt: '2026-06-16T10:00:00.000Z',
    lastError: null,
    lastKnownGoodSnapshotId: 'snapshot-lkg',
    optionalComponents: [],
    requiredComponents: ['display'],
    snapshotId: 'snapshot-active',
    status: 'active',
    updatedAt: '2026-06-16T10:00:00.000Z',
    validationResult: null,
  }
  const lastKnownGoodSnapshot: FakeSnapshotRow = {
    ...activeSnapshot,
    activatedAt: '2026-06-16T09:00:00.000Z',
    lastKnownGoodSnapshotId: null,
    snapshotId: 'snapshot-lkg',
    status: 'retired',
    updatedAt: '2026-06-16T09:00:00.000Z',
  }
  const {database, snapshots} = createFakeManifestDatabase([activeSnapshot, lastKnownGoodSnapshot])

  await createCandidateReviewServingSnapshotManifest(
    {...baseSnapshotInput, lastKnownGoodSnapshotId: 'snapshot-active', snapshotId: 'snapshot-candidate'},
    database,
  )
  await markCandidateReviewServingSnapshotManifestFailed(
    {lastError: 'validation failed', projectId: 'project-1', snapshotId: 'snapshot-candidate'},
    database,
  )

  const active = await getActiveReviewServingSnapshotManifest(
    {projectId: 'project-1', reviewConfigHash: 'review-config-1'},
    database,
  )
  const lastKnownGood = await getLastKnownGoodReviewServingSnapshotManifest(
    {projectId: 'project-1', reviewConfigHash: 'review-config-1'},
    database,
  )
  const failedCandidate = snapshots.get('project-1:snapshot-candidate')

  expect(failedCandidate?.status).toBe('failed')
  expect(failedCandidate?.lastError).toBe('validation failed')
  expect(active?.snapshotId).toBe('snapshot-active')
  expect(active?.status).toBe('active')
  expect(lastKnownGood?.snapshotId).toBe('snapshot-lkg')
  expect(lastKnownGood?.status).toBe('retired')
})

test('active-or-last-known-good manifest selection uses one statement and prefers active', async () => {
  const retiredSnapshot: FakeSnapshotRow = {
    ...baseSnapshotInput,
    activatedAt: '2026-06-16T11:00:00.000Z',
    lastError: null,
    lastKnownGoodSnapshotId: null,
    optionalComponents: [],
    requiredComponents: ['display'],
    snapshotId: 'snapshot-retired',
    status: 'retired',
    updatedAt: '2026-06-16T11:00:00.000Z',
    validationResult: null,
  }
  const activeSnapshot: FakeSnapshotRow = {
    ...retiredSnapshot,
    activatedAt: '2026-06-16T10:00:00.000Z',
    snapshotId: 'snapshot-active',
    status: 'active',
    updatedAt: '2026-06-16T10:00:00.000Z',
  }
  const {database, statements} = createFakeManifestDatabase([retiredSnapshot, activeSnapshot])

  const manifest = await getActiveOrLastKnownGoodReviewServingSnapshotManifest(
    {projectId: 'project-1', reviewConfigHash: 'review-config-1'},
    database,
  )

  expect(manifest?.snapshotId).toBe('snapshot-active')
  expect(statements).toHaveLength(1)
  expect(statements[0]).toContain("snapshot_status = 'active'")
})

test('active-or-last-known-good manifest selection falls back to retired state for requested components', async () => {
  const retiredSnapshot: FakeSnapshotRow = {
    ...baseSnapshotInput,
    activatedAt: '2026-06-16T10:00:00.000Z',
    lastError: null,
    lastKnownGoodSnapshotId: null,
    optionalComponents: [],
    requiredComponents: ['display'],
    snapshotId: 'snapshot-retired-row-ready',
    status: 'retired',
    updatedAt: '2026-06-16T10:00:00.000Z',
    validationResult: null,
  }
  const activeSnapshot: FakeSnapshotRow = {
    ...retiredSnapshot,
    activatedAt: '2026-06-16T11:00:00.000Z',
    componentState: {optional: [], required: []},
    lastKnownGoodSnapshotId: 'snapshot-retired-row-ready',
    requiredComponents: [],
    snapshotId: 'snapshot-active-optional-only',
    status: 'active',
    updatedAt: '2026-06-16T11:00:00.000Z',
  }
  const newerOptionalOnlyRetiredSnapshot: FakeSnapshotRow = {
    ...activeSnapshot,
    activatedAt: '2026-06-16T10:30:00.000Z',
    lastKnownGoodSnapshotId: null,
    snapshotId: 'snapshot-retired-optional-only',
    status: 'retired',
    updatedAt: '2026-06-16T10:30:00.000Z',
  }
  const {database, statements} = createFakeManifestDatabase([
    activeSnapshot,
    newerOptionalOnlyRetiredSnapshot,
    retiredSnapshot,
  ])

  const manifest = await getActiveOrLastKnownGoodReviewServingSnapshotManifest(
    {
      componentStateMode: 'available',
      projectId: 'project-1',
      requiredComponents: ['display'],
      reviewConfigHash: 'review-config-1',
    },
    database,
  )

  expect(manifest?.snapshotId).toBe('snapshot-retired-row-ready')
  const snapshotStatements = statements.filter((statement) => {
    return statement.includes('FROM app.review_serving_snapshot_manifest')
  })

  expect(snapshotStatements).toHaveLength(2)
  expect(snapshotStatements[1]).toContain("snapshot_id = 'snapshot-retired-row-ready'")
  expect(
    manifest?.componentState.required.map((state) => {
      return state.component
    }),
  ).toEqual(['display'])
})

test('active-or-last-known-good manifest selection returns the latest retired snapshot when no active exists', async () => {
  const olderSnapshot: FakeSnapshotRow = {
    ...baseSnapshotInput,
    activatedAt: '2026-06-16T09:00:00.000Z',
    lastError: null,
    lastKnownGoodSnapshotId: null,
    optionalComponents: [],
    requiredComponents: ['display'],
    snapshotId: 'snapshot-older',
    status: 'retired',
    updatedAt: '2026-06-16T09:00:00.000Z',
    validationResult: null,
  }
  const latestSnapshot: FakeSnapshotRow = {
    ...olderSnapshot,
    activatedAt: '2026-06-16T10:00:00.000Z',
    snapshotId: 'snapshot-latest',
    updatedAt: '2026-06-16T10:00:00.000Z',
  }
  const {database, statements} = createFakeManifestDatabase([olderSnapshot, latestSnapshot])

  const manifest = await getActiveOrLastKnownGoodReviewServingSnapshotManifest(
    {projectId: 'project-1', reviewConfigHash: 'review-config-1'},
    database,
  )

  expect(manifest?.snapshotId).toBe('snapshot-latest')
  expect(statements).toHaveLength(2)
  expect(statements[0]).toContain("snapshot_status = 'active'")
  expect(statements[1]).toContain("snapshot_status = 'retired'")
})

test.each([
  {expectedTimeoutMs: 5_000, timeoutMs: undefined, timeoutScope: undefined},
  {expectedTimeoutMs: 1_000, timeoutMs: 1_000, timeoutScope: undefined},
  {expectedTimeoutMs: 5_000, timeoutMs: 10_000, timeoutScope: undefined},
  {expectedTimeoutMs: 5_000, timeoutMs: 5_000, timeoutScope: 'workload' as const},
])('component availability keeps the $expectedTimeoutMs ms budget for a $timeoutMs ms caller', async (input) => {
  const snapshot: FakeSnapshotRow = {
    ...baseSnapshotInput,
    activatedAt: '2026-06-16T10:00:00.000Z',
    lastError: null,
    lastKnownGoodSnapshotId: null,
    optionalComponents: [],
    requiredComponents: ['display'],
    status: 'active',
    updatedAt: '2026-06-16T10:00:00.000Z',
    validationResult: null,
  }
  const {database} = createFakeManifestDatabase([snapshot])
  const availabilityContexts: DuckdbWorkloadContext[] = []
  const measuredDatabase = {
    queryJson: <T>(statement: string, workloadContext?: DuckdbWorkloadContext) => {
      if (workloadContext?.routeOrJobKey.endsWith('.componentAvailability')) {
        availabilityContexts.push(workloadContext)
      }

      return database.queryJson<T>(statement, workloadContext)
    },
  }

  const available = await getReviewServingSnapshotManifest(
    {
      componentStateMode: 'available',
      projectId: snapshot.projectId,
      snapshotId: snapshot.snapshotId,
      workloadContext: {
        routeOrJobKey: 'review.warnings.servingDiagnostics',
        timeoutMs: input.timeoutMs,
        timeoutScope: input.timeoutScope,
        workloadClass: 'foreground-diagnostic',
      },
    },
    measuredDatabase,
  )

  expect(available?.componentState).toEqual(componentState)
  expect(availabilityContexts).toHaveLength(2)
  expect(availabilityContexts).toEqual(
    Array.from({length: 2}, () => {
      return {
        allowsTempSpill: false,
        fallbackIntent: 'serveStale',
        maxResultRows: 64,
        projectId: snapshot.projectId,
        routeOrJobKey: 'review.warnings.servingDiagnostics.componentAvailability',
        searchMode: undefined,
        timeoutMs: input.expectedTimeoutMs,
        timeoutScope: input.timeoutScope ?? 'execution',
        workloadClass: 'foreground-diagnostic',
      }
    }),
  )
})

test('available manifest state hides incomplete chunk-backed components without mutating raw builder state', async () => {
  const snapshot: FakeSnapshotRow = {
    ...baseSnapshotInput,
    activatedAt: '2026-06-16T10:00:00.000Z',
    componentState: {
      optional: [
        {
          baseGeneration: '1',
          component: 'search',
          patchWatermark: '3',
          projectionIdentity: 'search:identity-1',
          requirement: 'optional',
        },
      ],
      required: componentState.required,
    },
    lastError: null,
    lastKnownGoodSnapshotId: null,
    optionalComponents: ['search'],
    requiredComponents: ['display'],
    snapshotId: 'snapshot-active',
    status: 'active',
    updatedAt: '2026-06-16T10:00:00.000Z',
    validationResult: null,
  }
  const {database} = createFakeManifestDatabase([snapshot], {
    chunkAvailabilityRows: [
      {
        completedChunkCount: 2,
        component: 'display',
        outputBaseGeneration: 1,
        projectionIdentity: 'display:identity-1',
        totalChunkCount: 2,
      },
      {
        completedChunkCount: 1,
        component: 'search',
        outputBaseGeneration: 1,
        projectionIdentity: 'search:identity-1',
        totalChunkCount: 2,
      },
    ],
  })

  const raw = await getReviewServingSnapshotManifest(
    {componentStateMode: 'raw', projectId: 'project-1', snapshotId: 'snapshot-active'},
    database,
  )
  const available = await getReviewServingSnapshotManifest(
    {componentStateMode: 'available', projectId: 'project-1', snapshotId: 'snapshot-active'},
    database,
  )

  expect(
    raw?.componentState.optional.map((state) => {
      return state.component
    }),
  ).toEqual(['search'])
  expect(
    available?.componentState.required.map((state) => {
      return state.component
    }),
  ).toEqual(['display'])
  expect(available?.componentState.optional).toEqual([])
})

test('available manifest state follows the newest effective chunk request for duplicate chunk rows', async () => {
  const snapshot: FakeSnapshotRow = {
    ...baseSnapshotInput,
    activatedAt: '2026-06-16T10:00:00.000Z',
    lastError: null,
    lastKnownGoodSnapshotId: null,
    optionalComponents: [],
    requiredComponents: ['display'],
    snapshotId: 'snapshot-active',
    status: 'active',
    updatedAt: '2026-06-16T10:00:00.000Z',
    validationResult: null,
  }
  const {database} = createFakeManifestDatabase([snapshot], {
    chunkAvailabilityRows: [
      {
        completedChunkCount: 1,
        component: 'display',
        maxChunkUpdatedAt: '2026-06-16T10:01:00.000Z',
        outputBaseGeneration: 1,
        projectionIdentity: 'display:identity-1',
        requestCreatedAt: '2026-06-16T10:01:00.000Z',
        requestId: 'request-stale-running',
        requestStatus: 'running',
        requestUpdatedAt: '2026-06-16T10:01:00.000Z',
        totalChunkCount: 2,
      },
      {
        completedChunkCount: 2,
        component: 'display',
        maxChunkUpdatedAt: '2026-06-16T10:05:00.000Z',
        outputBaseGeneration: 1,
        projectionIdentity: 'display:identity-1',
        requestCreatedAt: '2026-06-16T10:05:00.000Z',
        requestId: 'request-current-completed',
        requestStatus: 'completed',
        requestUpdatedAt: '2026-06-16T10:05:00.000Z',
        totalChunkCount: 2,
      },
    ],
  })

  const available = await getReviewServingSnapshotManifest(
    {componentStateMode: 'available', projectId: 'project-1', snapshotId: 'snapshot-active'},
    database,
  )

  expect(
    available?.componentState.required.map((state) => {
      return state.component
    }),
  ).toEqual(['display'])
})

test('available manifest state hides candidate rebuilt components without completed chunks', async () => {
  const candidateSnapshot: FakeSnapshotRow = {
    ...baseSnapshotInput,
    activatedAt: null,
    lastError: null,
    lastKnownGoodSnapshotId: null,
    optionalComponents: [],
    requiredComponents: ['display'],
    snapshotId: 'snapshot-candidate',
    status: 'candidate',
    updatedAt: '2026-06-16T10:00:00.000Z',
    validationResult: null,
  }
  const {database} = createFakeManifestDatabase([candidateSnapshot])
  const projection = {
    baseGeneration: 1,
    definitionVersion: 'display-v1',
    inputDigest: 'display-digest-1',
    inputWatermark: 10,
    inputWatermarks: {reviewChange: 10},
    patchWatermark: 3,
    projectId: 'project-1',
    projectionComponent: 'display',
    projectionIdentity: 'display:identity-1',
    reviewConfigHash: 'review-config-1',
    status: 'candidate',
  } as const

  await upsertReviewServingProjectionIdentityManifest(projection, database)

  const rebuiltWithoutChunks = await getReviewServingSnapshotManifest(
    {componentStateMode: 'available', projectId: 'project-1', snapshotId: 'snapshot-candidate'},
    database,
  )

  await upsertReviewServingProjectionIdentityManifest({...projection, status: 'active'}, database)

  const reusedActiveProjection = await getReviewServingSnapshotManifest(
    {componentStateMode: 'available', projectId: 'project-1', snapshotId: 'snapshot-candidate'},
    database,
  )

  expect(rebuiltWithoutChunks?.componentState.required).toEqual([])
  expect(
    reusedActiveProjection?.componentState.required.map((state) => {
      return state.component
    }),
  ).toEqual(['display'])
})

test('promotion reports invalid candidates without mutating snapshot manifests', async () => {
  const activeSnapshot: FakeSnapshotRow = {
    ...baseSnapshotInput,
    activatedAt: '2026-06-16T10:00:00.000Z',
    lastError: null,
    lastKnownGoodSnapshotId: null,
    optionalComponents: [],
    requiredComponents: ['display'],
    snapshotId: 'snapshot-active',
    status: 'active',
    updatedAt: '2026-06-16T10:00:00.000Z',
    validationResult: null,
  }
  const {database, snapshots, statements} = createFakeManifestDatabase([activeSnapshot], {
    selectedImportSnapshotStatus: 'candidate',
  })

  await createCandidateReviewServingSnapshotManifest(
    {...baseSnapshotInput, lastKnownGoodSnapshotId: 'snapshot-active', snapshotId: 'snapshot-invalid'},
    database,
  )

  const statementCountBeforePromotion = statements.length
  const promotionResult = await promoteReviewServingProjectorSnapshot(
    {projectId: 'project-1', reviewConfigHash: 'review-config-1', snapshotId: 'snapshot-invalid'},
    database,
  )
  const promotionStatements = statements.slice(statementCountBeforePromotion)
  const invalidCandidate = snapshots.get('project-1:snapshot-invalid')

  expect(promotionResult).toEqual({
    error: 'selected import snapshot is not completed',
    promoted: false,
    snapshotId: 'snapshot-invalid',
  })
  expect(invalidCandidate?.status).toBe('candidate')
  expect(invalidCandidate?.lastError).toBe(null)
  expect(promotionStatements.join('\n')).not.toContain('UPDATE app.review_serving_snapshot_manifest')
})

test('promotion retires previous active and preserves it as last-known-good', async () => {
  const activeSnapshot: FakeSnapshotRow = {
    ...baseSnapshotInput,
    activatedAt: '2026-06-16T10:00:00.000Z',
    lastError: null,
    lastKnownGoodSnapshotId: null,
    optionalComponents: [],
    requiredComponents: ['display'],
    snapshotId: 'snapshot-active',
    status: 'active',
    updatedAt: '2026-06-16T10:00:00.000Z',
    validationResult: null,
  }
  const {database, statements} = createFakeManifestDatabase([activeSnapshot], {
    chunkAvailabilityRows: [
      {
        completedChunkCount: 2,
        component: 'display',
        maxChunkUpdatedAt: '2026-06-16T10:05:00.000Z',
        outputBaseGeneration: 1,
        projectionIdentity: 'display:identity-1',
        requestCreatedAt: '2026-06-16T10:05:00.000Z',
        requestId: 'request-current-completed',
        requestStatus: 'completed',
        requestUpdatedAt: '2026-06-16T10:05:00.000Z',
        totalChunkCount: 2,
      },
    ],
  })

  await createCandidateReviewServingSnapshotManifest(
    {...baseSnapshotInput, lastKnownGoodSnapshotId: 'snapshot-active', snapshotId: 'snapshot-next'},
    database,
  )
  await upsertReviewServingProjectionIdentityManifest(
    {
      baseGeneration: 1,
      definitionVersion: 'display-v1',
      inputDigest: 'display-digest-1',
      inputWatermark: 10,
      inputWatermarks: {reviewChange: 10},
      patchWatermark: 3,
      projectId: 'project-1',
      projectionComponent: 'display',
      projectionIdentity: 'display:identity-1',
      reviewConfigHash: 'review-config-1',
      status: 'candidate',
    },
    database,
  )
  const promotionResult = await promoteReviewServingProjectorSnapshot(
    {projectId: 'project-1', reviewConfigHash: 'review-config-1', snapshotId: 'snapshot-next'},
    database,
  )

  const active = await getActiveReviewServingSnapshotManifest(
    {projectId: 'project-1', reviewConfigHash: 'review-config-1'},
    database,
  )
  const lastKnownGood = await getLastKnownGoodReviewServingSnapshotManifest(
    {projectId: 'project-1', reviewConfigHash: 'review-config-1'},
    database,
  )

  expect(promotionResult).toEqual({promoted: true, snapshotId: 'snapshot-next'})
  expect(active?.snapshotId).toBe('snapshot-next')
  expect(active?.lastKnownGoodSnapshotId).toBe('snapshot-active')
  expect(lastKnownGood?.snapshotId).toBe('snapshot-active')
  expect(lastKnownGood?.status).toBe('retired')
  expect(statements.join('\n')).toContain('WITH rebuild_dirty_work_coverage AS')
  expect(statements.join('\n')).toContain("'display'")
  expect(statements.join('\n')).toContain("'display:identity-1'")
  expect(statements.join('\n')).toContain("'reviewChange'")
  expect(statements.join('\n')).toContain('latest_source_high_water_mark <= coverage.completed_source_high_water_mark')
})

test('promotion refuses optional-only candidates that would replace a row-ready active snapshot', async () => {
  const activeSnapshot: FakeSnapshotRow = {
    ...baseSnapshotInput,
    activatedAt: '2026-06-16T10:00:00.000Z',
    lastError: null,
    lastKnownGoodSnapshotId: null,
    optionalComponents: [],
    requiredComponents: ['display'],
    snapshotId: 'snapshot-active',
    status: 'active',
    updatedAt: '2026-06-16T10:00:00.000Z',
    validationResult: null,
  }
  const {database, snapshots, statements} = createFakeManifestDatabase([activeSnapshot])

  await createCandidateReviewServingSnapshotManifest(
    {
      ...baseSnapshotInput,
      componentRequirements: {optionalComponents: ['payload'], requiredComponents: []},
      componentState: {
        optional: [
          {
            baseGeneration: '1',
            component: 'payload',
            patchWatermark: '3',
            projectionIdentity: 'payload:identity-1',
            requirement: 'optional',
          },
        ],
        required: [],
      },
      lastKnownGoodSnapshotId: 'snapshot-active',
      snapshotId: 'snapshot-optional-only',
    },
    database,
  )
  await upsertReviewServingProjectionIdentityManifest(
    {
      baseGeneration: 1,
      definitionVersion: 'payload-v1',
      inputDigest: 'payload-digest-1',
      inputWatermark: 10,
      inputWatermarks: {reviewChange: 10},
      patchWatermark: 3,
      projectId: 'project-1',
      projectionComponent: 'payload',
      projectionIdentity: 'payload:identity-1',
      reviewConfigHash: 'review-config-1',
      status: 'candidate',
    },
    database,
  )

  const statementCountBeforePromotion = statements.length
  const promotionResult = await promoteReviewServingProjectorSnapshot(
    {projectId: 'project-1', reviewConfigHash: 'review-config-1', snapshotId: 'snapshot-optional-only'},
    database,
  )
  const promotionStatements = statements.slice(statementCountBeforePromotion)

  expect(promotionResult).toEqual({
    error:
      'candidate snapshot snapshot-optional-only has no required components and cannot replace active snapshot snapshot-active',
    promoted: false,
    snapshotId: 'snapshot-optional-only',
  })
  expect(snapshots.get('project-1:snapshot-active')?.status).toBe('active')
  expect(snapshots.get('project-1:snapshot-optional-only')?.status).toBe('candidate')
  expect(promotionStatements.join('\n')).not.toContain("snapshot_status = 'retired'")
})

test('promotion refreshes stale candidate component state before activation', async () => {
  const staleCandidate: FakeSnapshotRow = {
    ...baseSnapshotInput,
    activatedAt: null,
    componentState: {optional: [], required: [{...componentState.required[0], patchWatermark: '0'}]},
    lastError: null,
    lastKnownGoodSnapshotId: null,
    optionalComponents: ['posting'],
    requiredComponents: ['display'],
    snapshotId: 'snapshot-stale-candidate',
    status: 'candidate',
    updatedAt: '2026-06-16T10:00:00.000Z',
    validationResult: null,
  }
  const {database, snapshots, statements} = createFakeManifestDatabase([staleCandidate], {
    chunkAvailabilityRows: [
      {
        completedChunkCount: 1,
        component: 'display',
        outputBaseGeneration: 1,
        projectionIdentity: 'display:identity-1',
        requestStatus: 'admitted',
        totalChunkCount: 1,
      },
    ],
  })

  await upsertReviewServingProjectionIdentityManifest(
    {
      baseGeneration: 1,
      definitionVersion: 'display-v1',
      inputDigest: 'display-digest-1',
      inputWatermark: 10,
      inputWatermarks: {reviewChange: 10},
      patchWatermark: 3,
      projectId: 'project-1',
      projectionComponent: 'display',
      projectionIdentity: 'display:identity-1',
      reviewConfigHash: 'review-config-1',
      status: 'candidate',
    },
    database,
  )

  const promotionResult = await promoteReviewServingProjectorSnapshot(
    {projectId: 'project-1', reviewConfigHash: 'review-config-1', snapshotId: 'snapshot-stale-candidate'},
    database,
  )
  const active = snapshots.get('project-1:snapshot-stale-candidate')

  expect(promotionResult).toEqual({promoted: true, snapshotId: 'snapshot-stale-candidate'})
  expect(active?.status).toBe('active')
  expect(active?.componentState.required).toEqual([{...componentState.required[0], patchWatermark: '3'}])
  expect(active?.optionalComponents).toEqual(['posting'])
  expect(active?.componentState.optional).toEqual([])
  expect(statements.join('\n')).toContain('UPDATE app.review_projection_identity_manifest AS manifest')
  expect(statements.join('\n')).toContain("status = 'active'")
})

test('retire obsolete manifests updates status without deleting snapshot rows', async () => {
  const obsoleteSnapshot: FakeSnapshotRow = {
    ...baseSnapshotInput,
    activatedAt: null,
    lastError: 'validation failed',
    lastKnownGoodSnapshotId: 'snapshot-active',
    optionalComponents: [],
    requiredComponents: ['display'],
    snapshotId: 'snapshot-failed',
    status: 'failed',
    updatedAt: '2026-06-16T10:00:00.000Z',
    validationResult: null,
  }
  const keptSnapshot: FakeSnapshotRow = {...obsoleteSnapshot, snapshotId: 'snapshot-kept'}
  const {database, snapshots} = createFakeManifestDatabase([obsoleteSnapshot, keptSnapshot])

  await retireObsoleteReviewServingSnapshotManifests(
    {keepSnapshotIds: ['snapshot-kept'], projectId: 'project-1', reviewConfigHash: 'review-config-1'},
    database as ReviewServingManifestRepositoryTransaction,
  )

  expect(snapshots.size).toBe(2)
  expect(snapshots.get('project-1:snapshot-failed')?.status).toBe('retired')
  expect(snapshots.get('project-1:snapshot-kept')?.status).toBe('failed')
})

test('promotion fails older candidate snapshots superseded by the promoted snapshot', async () => {
  const activeSnapshot: FakeSnapshotRow = {
    ...baseSnapshotInput,
    activatedAt: '2026-06-16T10:00:00.000Z',
    createdAt: '2026-06-16T10:00:00.000Z',
    lastError: null,
    lastKnownGoodSnapshotId: null,
    optionalComponents: [],
    requiredComponents: ['display'],
    snapshotId: 'snapshot-active',
    status: 'active',
    updatedAt: '2026-06-16T10:00:00.000Z',
    validationResult: null,
  }
  const staleCandidate: FakeSnapshotRow = {
    ...activeSnapshot,
    activatedAt: null,
    createdAt: '2026-06-16T09:30:00.000Z',
    snapshotId: 'snapshot-stale-validation-failed',
    status: 'candidate',
    updatedAt: '2026-06-16T09:30:00.000Z',
  }
  const inFlightCandidate: FakeSnapshotRow = {
    ...staleCandidate,
    createdAt: '2026-06-16T09:45:00.000Z',
    snapshotId: 'snapshot-in-flight',
    updatedAt: '2026-06-16T09:45:00.000Z',
  }
  const otherConfigCandidate: FakeSnapshotRow = {
    ...staleCandidate,
    reviewConfigHash: 'review-config-other',
    snapshotId: 'snapshot-other-config',
  }
  const {database, snapshots, statements} = createFakeManifestDatabase(
    [activeSnapshot, staleCandidate, inFlightCandidate, otherConfigCandidate],
    {
      chunkAvailabilityRows: [
        {
          completedChunkCount: 2,
          component: 'display',
          maxChunkUpdatedAt: '2026-06-16T10:05:00.000Z',
          outputBaseGeneration: 1,
          projectionIdentity: 'display:identity-1',
          requestCreatedAt: '2026-06-16T10:05:00.000Z',
          requestId: 'request-current-completed',
          requestStatus: 'completed',
          requestUpdatedAt: '2026-06-16T10:05:00.000Z',
          totalChunkCount: 2,
        },
      ],
      inFlightSnapshotIds: ['snapshot-in-flight'],
    },
  )

  await createCandidateReviewServingSnapshotManifest(
    {...baseSnapshotInput, lastKnownGoodSnapshotId: 'snapshot-active', snapshotId: 'snapshot-next'},
    database,
  )
  await upsertReviewServingProjectionIdentityManifest(
    {
      baseGeneration: 1,
      definitionVersion: 'display-v1',
      inputDigest: 'display-digest-1',
      inputWatermark: 10,
      inputWatermarks: {reviewChange: 10},
      patchWatermark: 3,
      projectId: 'project-1',
      projectionComponent: 'display',
      projectionIdentity: 'display:identity-1',
      reviewConfigHash: 'review-config-1',
      status: 'candidate',
    },
    database,
  )

  const statementCountBeforePromotion = statements.length
  const promotionResult = await promoteReviewServingProjectorSnapshot(
    {projectId: 'project-1', reviewConfigHash: 'review-config-1', snapshotId: 'snapshot-next'},
    database,
  )
  const promotionStatements = statements.slice(statementCountBeforePromotion)
  const supersedeQuery = promotionStatements.find((statement) => {
    return statement.includes('AS hasInFlightRebuild')
  })

  expect(promotionResult).toEqual({promoted: true, snapshotId: 'snapshot-next'})
  expect(snapshots.get('project-1:snapshot-next')?.status).toBe('active')
  expect(snapshots.get('project-1:snapshot-active')?.status).toBe('retired')
  expect(snapshots.get('project-1:snapshot-stale-validation-failed')).toMatchObject({
    lastError: 'superseded by snapshot snapshot-next',
    status: 'failed',
  })
  expect(snapshots.get('project-1:snapshot-in-flight')).toMatchObject({lastError: null, status: 'candidate'})
  expect(snapshots.get('project-1:snapshot-other-config')).toMatchObject({lastError: null, status: 'candidate'})
  expect(supersedeQuery).toContain("snapshot_id = 'snapshot-next'")
  expect(supersedeQuery).toContain('COALESCE(activated_at, created_at) AS reference_at')
  expect(supersedeQuery).toContain('FROM app.review_rebuild_chunk_manifest chunk')
  expect(supersedeQuery).toContain("chunk.status IN ('pending', 'running')")
  expect(supersedeQuery).toContain(
    "request.status IN ('pending_admission', 'admitted', 'running', 'blocked_over_budget', 'quarantined')",
  )

  const failedStatements = promotionStatements.filter((statement) => {
    return statement.includes("snapshot_status = 'failed'")
  })
  expect(failedStatements).toHaveLength(1)
  expect(failedStatements[0]).toContain("snapshot_id = 'snapshot-stale-validation-failed'")
  expect(failedStatements[0]).toContain("AND snapshot_status = 'candidate'")
})

test('superseded candidate failure reports skipped in-flight candidates without touching them', async () => {
  const promotedSnapshot: FakeSnapshotRow = {
    ...baseSnapshotInput,
    activatedAt: '2026-06-16T10:00:00.000Z',
    createdAt: '2026-06-16T10:00:00.000Z',
    lastError: null,
    lastKnownGoodSnapshotId: null,
    optionalComponents: [],
    requiredComponents: ['display'],
    snapshotId: 'snapshot-promoted',
    status: 'active',
    updatedAt: '2026-06-16T10:00:00.000Z',
    validationResult: null,
  }
  const staleCandidate: FakeSnapshotRow = {
    ...promotedSnapshot,
    activatedAt: null,
    createdAt: '2026-06-16T09:00:00.000Z',
    snapshotId: 'snapshot-stale',
    status: 'candidate',
  }
  const inFlightCandidate: FakeSnapshotRow = {...staleCandidate, snapshotId: 'snapshot-in-flight'}
  const newerCandidate: FakeSnapshotRow = {
    ...staleCandidate,
    createdAt: '2026-06-16T11:00:00.000Z',
    snapshotId: 'snapshot-newer',
  }
  const {database, snapshots} = createFakeManifestDatabase(
    [promotedSnapshot, staleCandidate, inFlightCandidate, newerCandidate],
    {inFlightSnapshotIds: ['snapshot-in-flight']},
  )

  const result = await failSupersededCandidateReviewServingSnapshotManifests(
    {projectId: 'project-1', promotedSnapshotId: 'snapshot-promoted'},
    database,
  )

  expect(result).toEqual({
    skippedInFlightSnapshotIds: ['snapshot-in-flight'],
    supersededSnapshotIds: ['snapshot-stale'],
  })
  expect(snapshots.get('project-1:snapshot-stale')).toMatchObject({
    lastError: 'superseded by snapshot snapshot-promoted',
    status: 'failed',
  })
  expect(snapshots.get('project-1:snapshot-in-flight')?.status).toBe('candidate')
  expect(snapshots.get('project-1:snapshot-newer')?.status).toBe('candidate')
  expect(snapshots.get('project-1:snapshot-promoted')?.status).toBe('active')
})

test('stale candidate recovery is dry-run by default and only fails stale non-in-flight candidates on apply', async () => {
  const activeSnapshot: FakeSnapshotRow = {
    ...baseSnapshotInput,
    activatedAt: '2026-08-25T10:00:00.000Z',
    createdAt: '2026-08-25T10:00:00.000Z',
    lastError: null,
    lastKnownGoodSnapshotId: null,
    optionalComponents: [],
    requiredComponents: ['display'],
    snapshotId: 'snapshot-active',
    status: 'active',
    updatedAt: '2026-08-25T10:00:00.000Z',
    validationResult: null,
  }
  const staleCandidate: FakeSnapshotRow = {
    ...activeSnapshot,
    activatedAt: null,
    createdAt: '2026-08-20T10:00:00.000Z',
    snapshotId: 'snapshot-stale',
    status: 'candidate',
    updatedAt: '2026-08-20T10:00:00.000Z',
  }
  const secondStaleCandidate: FakeSnapshotRow = {...staleCandidate, snapshotId: 'snapshot-stale-2'}
  const inFlightCandidate: FakeSnapshotRow = {...staleCandidate, snapshotId: 'snapshot-in-flight'}
  const newerCandidate: FakeSnapshotRow = {
    ...staleCandidate,
    createdAt: '2026-08-30T10:00:00.000Z',
    snapshotId: 'snapshot-newer',
  }
  const {database, snapshots, statements} = createFakeManifestDatabase(
    [activeSnapshot, staleCandidate, secondStaleCandidate, inFlightCandidate, newerCandidate],
    {inFlightSnapshotIds: ['snapshot-in-flight']},
  )

  const dryRun = await failStaleCandidateReviewServingSnapshotManifests({projectId: 'project-1'}, database)

  expect(dryRun.status).toBe('dry_run')
  expect(dryRun.applied).toBe(false)
  expect(dryRun.failedSnapshotIds).toEqual([])
  expect(
    dryRun.staleCandidates.map((row) => {
      return row.snapshotId
    }),
  ).toEqual(['snapshot-stale', 'snapshot-stale-2'])
  expect(dryRun.skipped).toEqual([
    {
      reasons: ['referenced_by_in_flight_rebuild'],
      referenceSnapshotId: 'snapshot-active',
      snapshotId: 'snapshot-in-flight',
    },
    {reasons: ['not_older_than_active_snapshot'], referenceSnapshotId: 'snapshot-active', snapshotId: 'snapshot-newer'},
  ])
  expect(statements.join('\n')).not.toContain('UPDATE app.review_serving_snapshot_manifest')
  expect(snapshots.get('project-1:snapshot-stale')?.status).toBe('candidate')

  const scopedApply = await failStaleCandidateReviewServingSnapshotManifests(
    {apply: true, projectId: 'project-1', snapshotId: 'snapshot-stale'},
    database,
  )

  expect(scopedApply.status).toBe('applied')
  expect(scopedApply.failedSnapshotIds).toEqual(['snapshot-stale'])
  expect(scopedApply.skipped).toEqual([])
  expect(snapshots.get('project-1:snapshot-stale')).toMatchObject({
    lastError: 'superseded by snapshot snapshot-active (operator failStaleReviewServingCandidateSnapshots)',
    status: 'failed',
  })
  expect(snapshots.get('project-1:snapshot-stale-2')?.status).toBe('candidate')

  const apply = await failStaleCandidateReviewServingSnapshotManifests({apply: true, projectId: 'project-1'}, database)

  expect(apply.failedSnapshotIds).toEqual(['snapshot-stale-2'])
  expect(snapshots.get('project-1:snapshot-stale-2')?.status).toBe('failed')
  expect(snapshots.get('project-1:snapshot-in-flight')?.status).toBe('candidate')
  expect(snapshots.get('project-1:snapshot-newer')?.status).toBe('candidate')
  expect(snapshots.get('project-1:snapshot-active')?.status).toBe('active')
})

test('candidate supersession rows resolve in-flight and age predicates against DuckDB', async () => {
  const duckdbInstance = await DuckDBInstance.create(':memory:', duckdbEngineCompatibilityOptions)
  const connection = await duckdbInstance.connect()
  const database: ReviewServingManifestRepositoryDatabase = {
    queryJson: async <T>(statement: string) => {
      const reader = await connection.runAndReadAll(statement)

      return reader.getRowObjectsJson() as T[]
    },
    run: async (statement: string) => {
      await connection.run(statement)
    },
    transaction: async (operation) => {
      return operation(database)
    },
  }

  try {
    await connection.run(`
      CREATE SCHEMA app;
      CREATE TABLE app.review_serving_snapshot_manifest (
        project_id VARCHAR NOT NULL,
        snapshot_id VARCHAR NOT NULL,
        snapshot_status VARCHAR NOT NULL DEFAULT 'candidate',
        review_config_hash VARCHAR,
        created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        activated_at TIMESTAMPTZ,
        failed_at TIMESTAMPTZ,
        last_error VARCHAR
      );
      CREATE TABLE app.review_rebuild_chunk_manifest (
        chunk_id VARCHAR PRIMARY KEY,
        project_id VARCHAR,
        snapshot_id VARCHAR,
        request_id VARCHAR,
        status VARCHAR NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE app.review_rebuild_request (
        request_id VARCHAR PRIMARY KEY,
        project_id VARCHAR NOT NULL,
        status VARCHAR NOT NULL
      );
      INSERT INTO app.review_serving_snapshot_manifest (
        project_id, snapshot_id, snapshot_status, review_config_hash, created_at, updated_at, activated_at
      )
      VALUES
        ('project-1', 'snapshot-active', 'active', 'config-1', TIMESTAMPTZ '2026-08-25T10:00:00Z', TIMESTAMPTZ '2026-08-25T10:00:00Z', TIMESTAMPTZ '2026-08-25T10:00:00Z'),
        ('project-1', 'snapshot-stale-failed-request', 'candidate', 'config-1', TIMESTAMPTZ '2026-08-20T10:00:00Z', TIMESTAMPTZ '2026-08-20T10:00:00Z', NULL),
        ('project-1', 'snapshot-stale-no-request', 'candidate', 'config-1', TIMESTAMPTZ '2026-08-21T10:00:00Z', TIMESTAMPTZ '2026-08-21T10:00:00Z', NULL),
        ('project-1', 'snapshot-in-flight-request', 'candidate', 'config-1', TIMESTAMPTZ '2026-08-22T10:00:00Z', TIMESTAMPTZ '2026-08-22T10:00:00Z', NULL),
        ('project-1', 'snapshot-in-flight-requestless-chunk', 'candidate', 'config-1', TIMESTAMPTZ '2026-08-23T10:00:00Z', TIMESTAMPTZ '2026-08-23T10:00:00Z', NULL),
        ('project-1', 'snapshot-newer', 'candidate', 'config-1', TIMESTAMPTZ '2026-08-30T10:00:00Z', TIMESTAMPTZ '2026-08-30T10:00:00Z', NULL),
        ('project-1', 'snapshot-other-config', 'candidate', 'config-2', TIMESTAMPTZ '2026-08-20T10:00:00Z', TIMESTAMPTZ '2026-08-20T10:00:00Z', NULL),
        ('project-1', 'snapshot-retired', 'retired', 'config-1', TIMESTAMPTZ '2026-08-10T10:00:00Z', TIMESTAMPTZ '2026-08-10T10:00:00Z', TIMESTAMPTZ '2026-08-10T10:00:00Z'),
        ('project-2', 'snapshot-other-project', 'candidate', 'config-1', TIMESTAMPTZ '2026-08-20T10:00:00Z', TIMESTAMPTZ '2026-08-20T10:00:00Z', NULL);
      INSERT INTO app.review_rebuild_request (request_id, project_id, status)
      VALUES
        ('request-failed', 'project-1', 'failed'),
        ('request-running', 'project-1', 'running');
      INSERT INTO app.review_rebuild_chunk_manifest (chunk_id, project_id, snapshot_id, request_id, status)
      VALUES
        ('chunk-failed-1', 'project-1', 'snapshot-stale-failed-request', 'request-failed', 'completed'),
        ('chunk-failed-2', 'project-1', 'snapshot-stale-failed-request', 'request-failed', 'completed'),
        ('chunk-running-1', 'project-1', 'snapshot-in-flight-request', 'request-running', 'completed'),
        ('chunk-running-2', 'project-1', 'snapshot-in-flight-request', 'request-running', 'pending'),
        ('chunk-requestless', 'project-1', 'snapshot-in-flight-requestless-chunk', NULL, 'running');
    `)

    const rows = await getCandidateReviewServingSnapshotSupersessionRows({projectId: 'project-1'}, database)

    expect(
      rows.map((row) => {
        return [row.snapshotId, row.referenceSnapshotId, row.isOlderThanReference, row.hasInFlightRebuild]
      }),
    ).toEqual([
      ['snapshot-stale-failed-request', 'snapshot-active', true, false],
      ['snapshot-stale-no-request', 'snapshot-active', true, false],
      ['snapshot-in-flight-request', 'snapshot-active', true, true],
      ['snapshot-in-flight-requestless-chunk', 'snapshot-active', true, true],
      ['snapshot-newer', 'snapshot-active', false, false],
    ])
    expect(rows[0]?.createdAt).toContain('2026-08-20')

    const scopedRows = await getCandidateReviewServingSnapshotSupersessionRows(
      {projectId: 'project-1', referenceSnapshotId: 'snapshot-active', snapshotId: 'snapshot-stale-no-request'},
      database,
    )

    expect(
      scopedRows.map((row) => {
        return row.snapshotId
      }),
    ).toEqual(['snapshot-stale-no-request'])

    const result = await failStaleCandidateReviewServingSnapshotManifests(
      {apply: true, projectId: 'project-1'},
      database,
    )
    const statuses = await database.queryJson<{lastError: string | null; snapshotId: string; status: string}>(`
      SELECT snapshot_id AS snapshotId, snapshot_status AS status, last_error AS lastError
      FROM app.review_serving_snapshot_manifest
      WHERE project_id = 'project-1'
      ORDER BY snapshot_id
    `)

    expect(result.failedSnapshotIds).toEqual(['snapshot-stale-failed-request', 'snapshot-stale-no-request'])
    expect(statuses).toEqual([
      {lastError: null, snapshotId: 'snapshot-active', status: 'active'},
      {lastError: null, snapshotId: 'snapshot-in-flight-request', status: 'candidate'},
      {lastError: null, snapshotId: 'snapshot-in-flight-requestless-chunk', status: 'candidate'},
      {lastError: null, snapshotId: 'snapshot-newer', status: 'candidate'},
      {lastError: null, snapshotId: 'snapshot-other-config', status: 'candidate'},
      {lastError: null, snapshotId: 'snapshot-retired', status: 'retired'},
      {
        lastError: 'superseded by snapshot snapshot-active (operator failStaleReviewServingCandidateSnapshots)',
        snapshotId: 'snapshot-stale-failed-request',
        status: 'failed',
      },
      {
        lastError: 'superseded by snapshot snapshot-active (operator failStaleReviewServingCandidateSnapshots)',
        snapshotId: 'snapshot-stale-no-request',
        status: 'failed',
      },
    ])

    const failedAtRows = await database.queryJson<{failedAtCount: number | string}>(`
      SELECT CAST(COUNT(*) FILTER (WHERE failed_at IS NOT NULL) AS INTEGER) AS failedAtCount
      FROM app.review_serving_snapshot_manifest
      WHERE snapshot_status = 'failed'
    `)

    expect(Number(failedAtRows[0]?.failedAtCount)).toBe(2)
  } finally {
    connection.closeSync()
    duckdbInstance.closeSync()
  }
})

test('stale candidate recovery honours the apply limit and a caller-provided source', async () => {
  const activeSnapshot: FakeSnapshotRow = {
    ...baseSnapshotInput,
    activatedAt: '2026-08-25T10:00:00.000Z',
    createdAt: '2026-08-25T10:00:00.000Z',
    lastError: null,
    lastKnownGoodSnapshotId: null,
    optionalComponents: [],
    requiredComponents: ['display'],
    snapshotId: 'snapshot-active',
    status: 'active',
    updatedAt: '2026-08-25T10:00:00.000Z',
    validationResult: null,
  }
  const staleCandidate: FakeSnapshotRow = {
    ...activeSnapshot,
    activatedAt: null,
    createdAt: '2026-08-20T10:00:00.000Z',
    snapshotId: 'snapshot-stale',
    status: 'candidate',
    updatedAt: '2026-08-20T10:00:00.000Z',
  }
  const secondStaleCandidate: FakeSnapshotRow = {
    ...staleCandidate,
    createdAt: '2026-08-21T10:00:00.000Z',
    snapshotId: 'snapshot-stale-2',
  }
  const {database, snapshots} = createFakeManifestDatabase([activeSnapshot, staleCandidate, secondStaleCandidate])

  const zeroLimit = await failStaleCandidateReviewServingSnapshotManifests(
    {apply: true, limit: 0, projectId: 'project-1', source: 'worker staleCandidateCleanup'},
    database,
  )

  expect(zeroLimit.failedSnapshotIds).toEqual([])
  expect(
    zeroLimit.staleCandidates.map((row) => {
      return row.snapshotId
    }),
  ).toEqual(['snapshot-stale', 'snapshot-stale-2'])
  expect(snapshots.get('project-1:snapshot-stale')?.status).toBe('candidate')

  const oneLimit = await failStaleCandidateReviewServingSnapshotManifests(
    {apply: true, limit: 1, projectId: 'project-1', source: 'worker staleCandidateCleanup'},
    database,
  )

  expect(oneLimit.failedSnapshotIds).toEqual(['snapshot-stale'])
  expect(oneLimit.staleCandidates).toHaveLength(2)
  expect(snapshots.get('project-1:snapshot-stale')).toMatchObject({
    lastError: 'superseded by snapshot snapshot-active (worker staleCandidateCleanup)',
    status: 'failed',
  })
  expect(snapshots.get('project-1:snapshot-stale-2')?.status).toBe('candidate')

  const defaultSource = await failStaleCandidateReviewServingSnapshotManifests(
    {apply: true, projectId: 'project-1'},
    database,
  )

  expect(defaultSource.failedSnapshotIds).toEqual(['snapshot-stale-2'])
  expect(snapshots.get('project-1:snapshot-stale-2')).toMatchObject({
    lastError: 'superseded by snapshot snapshot-active (operator failStaleReviewServingCandidateSnapshots)',
    status: 'failed',
  })
})

test('worker stale candidate cleanup scopes to projects with multiple queued snapshots and honours its bounds', async () => {
  const duckdbInstance = await DuckDBInstance.create(':memory:', duckdbEngineCompatibilityOptions)
  const connection = await duckdbInstance.connect()
  const database: ReviewServingManifestRepositoryDatabase = {
    queryJson: async <T>(statement: string) => {
      const reader = await connection.runAndReadAll(statement)

      return reader.getRowObjectsJson() as T[]
    },
    run: async (statement: string) => {
      await connection.run(statement)
    },
    transaction: async (operation) => {
      return operation(database)
    },
  }
  const getStatuses = () => {
    return database.queryJson<{lastError: string | null; snapshotId: string; status: string}>(`
      SELECT snapshot_id AS snapshotId, snapshot_status AS status, last_error AS lastError
      FROM app.review_serving_snapshot_manifest
      ORDER BY project_id, snapshot_id
    `)
  }

  try {
    await connection.run(`
      CREATE SCHEMA app;
      CREATE TABLE app.review_serving_snapshot_manifest (
        project_id VARCHAR NOT NULL,
        snapshot_id VARCHAR NOT NULL,
        snapshot_status VARCHAR NOT NULL DEFAULT 'candidate',
        review_config_hash VARCHAR,
        created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        activated_at TIMESTAMPTZ,
        failed_at TIMESTAMPTZ,
        last_error VARCHAR
      );
      CREATE TABLE app.review_rebuild_chunk_manifest (
        chunk_id VARCHAR PRIMARY KEY,
        project_id VARCHAR,
        snapshot_id VARCHAR,
        request_id VARCHAR,
        status VARCHAR NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE app.review_rebuild_request (
        request_id VARCHAR PRIMARY KEY,
        project_id VARCHAR NOT NULL,
        status VARCHAR NOT NULL
      );
      INSERT INTO app.review_serving_snapshot_manifest (
        project_id, snapshot_id, snapshot_status, review_config_hash, created_at, updated_at, activated_at
      )
      VALUES
        ('project-1', 'p1-active', 'active', 'config-1', TIMESTAMPTZ '2026-08-25T10:00:00Z', TIMESTAMPTZ '2026-08-25T10:00:00Z', TIMESTAMPTZ '2026-08-25T10:00:00Z'),
        ('project-1', 'p1-stale-old', 'candidate', 'config-1', TIMESTAMPTZ '2026-08-20T10:00:00Z', TIMESTAMPTZ '2026-08-20T10:00:00Z', NULL),
        ('project-1', 'p1-in-flight', 'candidate', 'config-1', TIMESTAMPTZ '2026-08-21T10:00:00Z', TIMESTAMPTZ '2026-08-21T10:00:00Z', NULL),
        ('project-1', 'p1-stale-mid', 'candidate', 'config-1', TIMESTAMPTZ '2026-08-22T10:00:00Z', TIMESTAMPTZ '2026-08-22T10:00:00Z', NULL),
        ('project-1', 'p1-equal', 'candidate', 'config-1', TIMESTAMPTZ '2026-08-25T10:00:00Z', TIMESTAMPTZ '2026-08-25T10:00:00Z', NULL),
        ('project-1', 'p1-newer', 'candidate', 'config-1', TIMESTAMPTZ '2026-08-30T10:00:00Z', TIMESTAMPTZ '2026-08-30T10:00:00Z', NULL),
        ('project-1', 'p1-other-config', 'candidate', 'config-2', TIMESTAMPTZ '2026-08-01T10:00:00Z', TIMESTAMPTZ '2026-08-01T10:00:00Z', NULL),
        ('project-2', 'p2-candidate-only', 'candidate', 'config-1', TIMESTAMPTZ '2026-08-01T10:00:00Z', TIMESTAMPTZ '2026-08-01T10:00:00Z', NULL),
        ('project-3', 'p3-active-only', 'active', 'config-1', TIMESTAMPTZ '2026-08-01T10:00:00Z', TIMESTAMPTZ '2026-08-01T10:00:00Z', TIMESTAMPTZ '2026-08-01T10:00:00Z'),
        ('project-4', 'p4-active', 'active', 'config-1', TIMESTAMPTZ '2026-09-01T10:00:00Z', TIMESTAMPTZ '2026-09-01T10:00:00Z', TIMESTAMPTZ '2026-09-01T10:00:00Z'),
        ('project-4', 'p4-stale', 'candidate', 'config-1', TIMESTAMPTZ '2026-08-28T10:00:00Z', TIMESTAMPTZ '2026-08-28T10:00:00Z', NULL);
      INSERT INTO app.review_rebuild_request (request_id, project_id, status)
      VALUES ('request-blocked', 'project-1', 'blocked_over_budget');
      INSERT INTO app.review_rebuild_chunk_manifest (chunk_id, project_id, snapshot_id, request_id, status)
      VALUES ('chunk-pending', 'project-1', 'p1-in-flight', 'request-blocked', 'pending');
    `)

    expect(await getReviewServingProjectsWithStaleCandidateSnapshots({limit: 10}, database)).toEqual([
      {projectId: 'project-1', reviewConfigHash: 'config-1', staleCandidateCount: 2},
      {projectId: 'project-4', reviewConfigHash: 'config-1', staleCandidateCount: 1},
    ])
    expect(await getReviewServingProjectsWithStaleCandidateSnapshots({limit: 1}, database)).toEqual([
      {projectId: 'project-1', reviewConfigHash: 'config-1', staleCandidateCount: 2},
    ])

    const boundedBySnapshots = await cleanupStaleCandidateReviewServingSnapshotManifests(
      {maxSnapshots: 1, source: 'worker staleCandidateCleanup'},
      database,
    )

    expect(boundedBySnapshots).toEqual({
      failedSnapshots: [{projectId: 'project-1', referenceSnapshotId: 'p1-active', snapshotId: 'p1-stale-old'}],
      projectIds: ['project-1', 'project-4'],
      remainingStaleCandidateCount: 1,
      skippedSnapshotCount: 3,
    })
    expect(await getStatuses()).toEqual([
      {lastError: null, snapshotId: 'p1-active', status: 'active'},
      {lastError: null, snapshotId: 'p1-equal', status: 'candidate'},
      {lastError: null, snapshotId: 'p1-in-flight', status: 'candidate'},
      {lastError: null, snapshotId: 'p1-newer', status: 'candidate'},
      {lastError: null, snapshotId: 'p1-other-config', status: 'candidate'},
      {lastError: null, snapshotId: 'p1-stale-mid', status: 'candidate'},
      {
        lastError: 'superseded by snapshot p1-active (worker staleCandidateCleanup)',
        snapshotId: 'p1-stale-old',
        status: 'failed',
      },
      {lastError: null, snapshotId: 'p2-candidate-only', status: 'candidate'},
      {lastError: null, snapshotId: 'p3-active-only', status: 'active'},
      {lastError: null, snapshotId: 'p4-active', status: 'active'},
      {lastError: null, snapshotId: 'p4-stale', status: 'candidate'},
    ])

    const boundedByProjects = await cleanupStaleCandidateReviewServingSnapshotManifests(
      {maxProjects: 1, source: 'worker staleCandidateCleanup'},
      database,
    )

    expect(boundedByProjects).toEqual({
      failedSnapshots: [{projectId: 'project-1', referenceSnapshotId: 'p1-active', snapshotId: 'p1-stale-mid'}],
      projectIds: ['project-1'],
      remainingStaleCandidateCount: 0,
      skippedSnapshotCount: 3,
    })
    expect(
      (await getStatuses()).find((row) => {
        return row.snapshotId === 'p4-stale'
      })?.status,
    ).toBe('candidate')

    const unbounded = await cleanupStaleCandidateReviewServingSnapshotManifests(
      {source: 'worker staleCandidateCleanup'},
      database,
    )

    expect(unbounded).toEqual({
      failedSnapshots: [{projectId: 'project-4', referenceSnapshotId: 'p4-active', snapshotId: 'p4-stale'}],
      projectIds: ['project-4'],
      remainingStaleCandidateCount: 0,
      skippedSnapshotCount: 0,
    })
    expect(
      (await getStatuses()).filter((row) => {
        return row.status === 'failed'
      }),
    ).toEqual([
      {
        lastError: 'superseded by snapshot p1-active (worker staleCandidateCleanup)',
        snapshotId: 'p1-stale-mid',
        status: 'failed',
      },
      {
        lastError: 'superseded by snapshot p1-active (worker staleCandidateCleanup)',
        snapshotId: 'p1-stale-old',
        status: 'failed',
      },
      {
        lastError: 'superseded by snapshot p4-active (worker staleCandidateCleanup)',
        snapshotId: 'p4-stale',
        status: 'failed',
      },
    ])
    expect(await getReviewServingProjectsWithStaleCandidateSnapshots({limit: 10}, database)).toEqual([])
  } finally {
    connection.closeSync()
    duckdbInstance.closeSync()
  }
})

test('worker stale candidate cleanup skips groups with nothing to fail and reaches stale groups beyond the project bound', async () => {
  const duckdbInstance = await DuckDBInstance.create(':memory:', duckdbEngineCompatibilityOptions)
  const connection = await duckdbInstance.connect()
  const database: ReviewServingManifestRepositoryDatabase = {
    queryJson: async <T>(statement: string) => {
      const reader = await connection.runAndReadAll(statement)

      return reader.getRowObjectsJson() as T[]
    },
    run: async (statement: string) => {
      await connection.run(statement)
    },
    transaction: async (operation) => {
      return operation(database)
    },
  }
  const getSnapshotRowSql = (input: {
    activatedAt: string | null
    createdAt: string
    projectId: string
    snapshotId: string
    status: 'active' | 'candidate'
  }) => {
    const activatedAtSql = input.activatedAt === null ? 'NULL' : `TIMESTAMPTZ '${input.activatedAt}'`

    return `('${input.projectId}', '${input.snapshotId}', '${input.status}', 'config-1', TIMESTAMPTZ '${input.createdAt}', TIMESTAMPTZ '${input.createdAt}', ${activatedAtSql})`
  }
  const getPinnedProjectRowsSql = (index: number) => {
    const projectId = `pinned-${String(index).padStart(2, '0')}`
    const isInFlight = index % 2 === 0

    return [
      getSnapshotRowSql({
        activatedAt: '2026-01-10T10:00:00Z',
        createdAt: '2026-01-10T10:00:00Z',
        projectId,
        snapshotId: `${projectId}-active`,
        status: 'active',
      }),
      getSnapshotRowSql({
        activatedAt: null,
        createdAt: isInFlight ? '2026-01-01T10:00:00Z' : '2026-01-20T10:00:00Z',
        projectId,
        snapshotId: `${projectId}-candidate`,
        status: 'candidate',
      }),
    ]
  }
  const getStaleProjectRowsSql = (index: number) => {
    const projectId = `stale-${String(index).padStart(2, '0')}`

    return [
      getSnapshotRowSql({
        activatedAt: '2026-03-10T10:00:00Z',
        createdAt: '2026-03-10T10:00:00Z',
        projectId,
        snapshotId: `${projectId}-active`,
        status: 'active',
      }),
      getSnapshotRowSql({
        activatedAt: null,
        createdAt: `2026-03-01T10:${String(index).padStart(2, '0')}:00Z`,
        projectId,
        snapshotId: `${projectId}-candidate`,
        status: 'candidate',
      }),
    ]
  }
  const pinnedIndexes = Array.from({length: 10}, (_, index) => {
    return index
  })
  const staleIndexes = Array.from({length: 12}, (_, index) => {
    return index
  })
  const getFailedProjectIds = async () => {
    const rows = await database.queryJson<{projectId: string}>(`
      SELECT project_id AS projectId
      FROM app.review_serving_snapshot_manifest
      WHERE snapshot_status = 'failed'
      ORDER BY project_id
    `)

    return rows.map((row) => {
      return row.projectId
    })
  }

  try {
    await connection.run(`
      CREATE SCHEMA app;
      CREATE TABLE app.review_serving_snapshot_manifest (
        project_id VARCHAR NOT NULL,
        snapshot_id VARCHAR NOT NULL,
        snapshot_status VARCHAR NOT NULL DEFAULT 'candidate',
        review_config_hash VARCHAR,
        created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        activated_at TIMESTAMPTZ,
        failed_at TIMESTAMPTZ,
        last_error VARCHAR
      );
      CREATE TABLE app.review_rebuild_chunk_manifest (
        chunk_id VARCHAR PRIMARY KEY,
        project_id VARCHAR,
        snapshot_id VARCHAR,
        request_id VARCHAR,
        status VARCHAR NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE app.review_rebuild_request (
        request_id VARCHAR PRIMARY KEY,
        project_id VARCHAR NOT NULL,
        status VARCHAR NOT NULL
      );
      INSERT INTO app.review_serving_snapshot_manifest (
        project_id, snapshot_id, snapshot_status, review_config_hash, created_at, updated_at, activated_at
      )
      VALUES
        ${[...pinnedIndexes.flatMap(getPinnedProjectRowsSql), ...staleIndexes.flatMap(getStaleProjectRowsSql)].join(',\n        ')};
      INSERT INTO app.review_rebuild_chunk_manifest (chunk_id, project_id, snapshot_id, request_id, status)
      VALUES
        ${pinnedIndexes
          .filter((index) => {
            return index % 2 === 0
          })
          .map((index) => {
            const projectId = `pinned-${String(index).padStart(2, '0')}`

            return `('${projectId}-chunk', '${projectId}', '${projectId}-candidate', NULL, 'pending')`
          })
          .join(',\n        ')};
    `)

    const selected = await getReviewServingProjectsWithStaleCandidateSnapshots({limit: 10}, database)

    expect(
      selected.map((row) => {
        return row.projectId
      }),
    ).toEqual(
      staleIndexes.slice(0, 10).map((index) => {
        return `stale-${String(index).padStart(2, '0')}`
      }),
    )

    const firstCleanup = await cleanupStaleCandidateReviewServingSnapshotManifests(
      {source: 'worker staleCandidateCleanup'},
      database,
    )

    expect(firstCleanup.projectIds).toHaveLength(10)
    expect(firstCleanup.failedSnapshots).toHaveLength(10)
    expect(firstCleanup.skippedSnapshotCount).toBe(0)

    const secondCleanup = await cleanupStaleCandidateReviewServingSnapshotManifests(
      {source: 'worker staleCandidateCleanup'},
      database,
    )

    expect(secondCleanup).toEqual({
      failedSnapshots: [
        {projectId: 'stale-10', referenceSnapshotId: 'stale-10-active', snapshotId: 'stale-10-candidate'},
        {projectId: 'stale-11', referenceSnapshotId: 'stale-11-active', snapshotId: 'stale-11-candidate'},
      ],
      projectIds: ['stale-10', 'stale-11'],
      remainingStaleCandidateCount: 0,
      skippedSnapshotCount: 0,
    })
    expect(await getFailedProjectIds()).toEqual(
      staleIndexes.map((index) => {
        return `stale-${String(index).padStart(2, '0')}`
      }),
    )

    const thirdCleanup = await cleanupStaleCandidateReviewServingSnapshotManifests(
      {source: 'worker staleCandidateCleanup'},
      database,
    )

    expect(thirdCleanup).toEqual({
      failedSnapshots: [],
      projectIds: [],
      remainingStaleCandidateCount: 0,
      skippedSnapshotCount: 0,
    })
    expect(await getReviewServingProjectsWithStaleCandidateSnapshots({limit: 10}, database)).toEqual([])
  } finally {
    connection.closeSync()
    duckdbInstance.closeSync()
  }
})
