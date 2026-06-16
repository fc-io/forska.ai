import {expect, test} from 'bun:test'

import {
  createCandidateReviewServingSnapshotManifest,
  getActiveReviewServingSnapshotManifest,
  getLastKnownGoodReviewServingSnapshotManifest,
  getReviewServingProjectionIdentityManifest,
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
  status: ReviewServingSnapshotManifest['status']
  updatedAt: string
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
  sourceWatermarks: {reviewChange: 10},
} as const

const getSqlStrings = (statement: string) => {
  return [...statement.matchAll(/'((?:''|[^'])*)'/g)].map((match) => {
    return match[1]?.replaceAll("''", "'") ?? ''
  })
}

const getWhereLiteral = (statement: string, columnName: string) => {
  return (
    statement
      .match(new RegExp(`(?<![A-Za-z0-9_])${columnName}\\s*=\\s*'((?:''|[^'])*)'`, 'u'))?.[1]
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

const createFakeManifestDatabase = (initialSnapshots: FakeSnapshotRow[] = []) => {
  const projections = new Map<string, FakeProjectionRow>()
  const snapshots = new Map<string, FakeSnapshotRow>()
  const statements: string[] = []
  const getSnapshotKey = (projectId: string, snapshotId: string) => {
    return `${projectId}:${snapshotId}`
  }
  const getClock = () => {
    return new Date(2026, 5, 16, 12, statements.length).toISOString()
  }
  const getProjectionStatus = (strings: string[]) => {
    return (
      strings.find((value) => {
        return value === 'candidate' || value === 'active' || value === 'failed' || value === 'retired'
      }) ?? 'candidate'
    )
  }
  const upsertProjection = (statement: string) => {
    const strings = getSqlStrings(statement)
    const manifestId = strings[0] ?? ''
    const existing = projections.get(manifestId)
    const row = {
      baseGeneration: Number(statement.match(/'[^']*',\s*'[^']*',\s*'[^']*',\s*'[^']*',\s*(\d+)/u)?.[1] ?? 0),
      definitionVersion: strings[5] ?? '',
      inputDigest: strings[4] ?? null,
      inputWatermark: Number(statement.match(/,\s*(\d+),\s*(?:NULL|'(?:''|[^']*)'),\s*'[^']*',\s*'[^']*',/u)?.[1] ?? 0),
      invalidationReason: strings[9] ?? null,
      manifestId,
      patchRangeEnd: null,
      patchRangeStart: null,
      patchWatermark: Number(statement.match(/'[^']*',\s*'[^']*',\s*'[^']*',\s*'[^']*',\s*\d+,\s*(\d+)/u)?.[1] ?? 0),
      projectId: strings[1] ?? null,
      projectionComponent: (strings[2] ?? 'display') as FakeProjectionRow['projectionComponent'],
      projectionIdentity: strings[3] ?? '',
      promptConfigHash: strings[7] ?? null,
      reviewConfigHash: strings[6] ?? null,
      status: getProjectionStatus(strings),
    }

    projections.set(manifestId, {...existing, ...row})
  }
  const upsertCandidate = (statement: string) => {
    const strings = getSqlStrings(statement)
    const projectId = strings[0] ?? ''
    const snapshotId = strings[1] ?? ''
    const reviewConfigHash = strings[3] ?? null
    const existing = snapshots.get(getSnapshotKey(projectId, snapshotId))

    snapshots.set(getSnapshotKey(projectId, snapshotId), {
      activatedAt: existing?.activatedAt ?? null,
      componentState: componentState as FakeSnapshotRow['componentState'],
      composedIdentity: {route: 'review.llm.rows', version: 1},
      lastError: null,
      lastKnownGoodSnapshotId: strings[10] ?? null,
      optionalComponents: [],
      projectId,
      requiredComponents: ['display'],
      reviewConfigHash,
      selectedImportSnapshotId: strings[9] ?? null,
      snapshotId,
      sourceWatermarks: {reviewChange: 10},
      status: 'candidate',
      updatedAt: getClock(),
      validationResult: null,
    })
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

    if (statement.includes('FROM app.review_selected_import_snapshot')) {
      return [{status: 'completed'}] as T[]
    }

    if (statement.includes('FROM app.review_projection_identity_manifest')) {
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
                invalidationReason: projection.invalidationReason,
              },
            ]
      ) as T[]
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
        .map(getSnapshotQueryRow) as T[]
    }

    return []
  }
  const run = async (statement: string) => {
    statements.push(statement)

    if (statement.includes('INSERT INTO app.review_projection_identity_manifest')) {
      upsertProjection(statement)
    }

    if (statement.includes('INSERT INTO app.review_serving_snapshot_manifest')) {
      upsertCandidate(statement)
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
    snapshots.set(getSnapshotKey(snapshot.projectId, snapshot.snapshotId), snapshot)
  })

  return {database, projections, snapshots, statements}
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

test('projection identity manifest upsert is idempotent for project component identity', async () => {
  const {database, projections} = createFakeManifestDatabase()
  const input = {
    baseGeneration: 2,
    definitionVersion: 'display-v1',
    inputDigest: 'input-digest-1',
    inputWatermark: 42,
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
  const {database} = createFakeManifestDatabase([activeSnapshot])

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
      patchWatermark: 3,
      projectId: 'project-1',
      projectionComponent: 'display',
      projectionIdentity: 'display:identity-1',
      reviewConfigHash: 'review-config-1',
      status: 'candidate',
    },
    database,
  )
  await promoteReviewServingProjectorSnapshot(
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

  expect(active?.snapshotId).toBe('snapshot-next')
  expect(active?.lastKnownGoodSnapshotId).toBe('snapshot-active')
  expect(lastKnownGood?.snapshotId).toBe('snapshot-active')
  expect(lastKnownGood?.status).toBe('retired')
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
