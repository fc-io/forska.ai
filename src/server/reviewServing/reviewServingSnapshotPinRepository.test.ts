import {expect, test} from 'bun:test'

import {getStableReviewServingJson, type ReviewServingIdentityValue} from './reviewProjectionIdentity.ts'
import {
  acquireReviewServingSnapshotPin,
  expireReviewServingSnapshotPins,
  getReviewServingSnapshotPinId,
  incrementReviewServingSnapshotPin,
  isReviewServingSnapshotStateCleanupEligible,
  listActiveReviewServingSnapshotPins,
  listProtectedReviewServingSnapshotStates,
  releaseReviewServingSnapshotPin,
  type ReviewServingSnapshotPinRepositoryDatabase,
} from './reviewServingSnapshotPinRepository.ts'

type FakePinRow = {
  composedIdentity: ReviewServingIdentityValue
  createdAt: string
  expiresAt: string
  ownerId: string
  ownerKind: string
  pinId: string
  projectId: string
  refCount: number
  releasedAt: string | null
  snapshotId: string
  updatedAt: string
}

type FakeManifestRow = {
  componentState: ReviewServingIdentityValue
  composedIdentity: ReviewServingIdentityValue
  lastKnownGoodSnapshotId: string | null
  projectId: string
  selectedImportSnapshotId: string | null
  snapshotId: string
  status: 'active' | 'retired'
}

const basePinInput = {
  composedIdentity: {route: 'review.llm.rows', version: 1},
  expiresAt: '2026-06-16T13:00:00.000Z',
  ownerId: 'job-1',
  ownerKind: 'bulkJob',
  projectId: 'project-1',
  snapshotId: 'snapshot-1',
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

const getTimestampLiteral = (statement: string) => {
  return statement.match(/TIMESTAMPTZ\s+'((?:''|[^'])*)'/u)?.[1]?.replaceAll("''", "'") ?? null
}

const getClock = (statements: string[]) => {
  return new Date(Date.UTC(2026, 5, 16, 12, statements.length)).toISOString()
}

const isActivePin = (pin: FakePinRow, now: string) => {
  return pin.releasedAt === null && pin.refCount > 0 && pin.expiresAt > now
}

const getPinQueryRow = (pin: FakePinRow) => {
  return {
    composedIdentityJson: getStableReviewServingJson(pin.composedIdentity),
    createdAt: pin.createdAt,
    expiresAt: pin.expiresAt,
    ownerId: pin.ownerId,
    ownerKind: pin.ownerKind,
    pinId: pin.pinId,
    projectId: pin.projectId,
    refCount: pin.refCount,
    releasedAt: pin.releasedAt,
    snapshotId: pin.snapshotId,
    updatedAt: pin.updatedAt,
  }
}

const createFakeSnapshotPinDatabase = (initialManifests: FakeManifestRow[] = []) => {
  const pins = new Map<string, FakePinRow>()
  const manifests = [...initialManifests]
  const statements: string[] = []
  const upsertPin = (statement: string) => {
    const strings = getSqlStrings(statement)
    const pinId = strings[0] ?? ''
    const existing = pins.get(pinId)
    const expiresAt = getTimestampLiteral(statement) ?? strings[6] ?? ''

    pins.set(
      pinId,
      existing === undefined
        ? {
            composedIdentity: JSON.parse(strings[3] ?? '{}') as ReviewServingIdentityValue,
            createdAt: getClock(statements),
            expiresAt,
            ownerId: strings[5] ?? '',
            ownerKind: strings[4] ?? '',
            pinId,
            projectId: strings[1] ?? '',
            refCount: 1,
            releasedAt: null,
            snapshotId: strings[2] ?? '',
            updatedAt: getClock(statements),
          }
        : {
            ...existing,
            expiresAt: existing.expiresAt > expiresAt ? existing.expiresAt : expiresAt,
            refCount: existing.refCount + 1,
            releasedAt: null,
            updatedAt: getClock(statements),
          },
    )
  }
  const incrementPin = (statement: string) => {
    const pinId = getWhereLiteral(statement, 'pin_id') ?? ''
    const existing = pins.get(pinId)
    const expiresAt = getTimestampLiteral(statement)

    if (existing) {
      pins.set(pinId, {
        ...existing,
        expiresAt: expiresAt && expiresAt > existing.expiresAt ? expiresAt : existing.expiresAt,
        refCount: existing.refCount + 1,
        releasedAt: null,
        updatedAt: getClock(statements),
      })
    }
  }
  const releasePin = (statement: string) => {
    const pinId = getWhereLiteral(statement, 'pin_id') ?? ''
    const existing = pins.get(pinId)

    if (existing && existing.releasedAt === null && existing.refCount > 0) {
      const refCount = Math.max(existing.refCount - 1, 0)
      pins.set(pinId, {
        ...existing,
        refCount,
        releasedAt: refCount === 0 ? getClock(statements) : null,
        updatedAt: getClock(statements),
      })
    }
  }
  const expirePins = (statement: string) => {
    const now = getTimestampLiteral(statement) ?? ''
    const projectId = getWhereLiteral(statement, 'project_id')

    pins.forEach((pin, pinId) => {
      if (pin.expiresAt <= now && pin.releasedAt === null && (projectId === null || pin.projectId === projectId)) {
        pins.set(pinId, {...pin, refCount: 0, releasedAt: getClock(statements), updatedAt: getClock(statements)})
      }
    })
  }
  const run = async (statement: string) => {
    statements.push(statement)

    if (statement.includes('INSERT INTO app.review_serving_snapshot_pin')) {
      upsertPin(statement)
      return
    }

    if (statement.includes('ref_count = ref_count + 1')) {
      incrementPin(statement)
      return
    }

    if (statement.includes('ref_count = greatest(ref_count - 1, 0)')) {
      releasePin(statement)
      return
    }

    if (statement.includes('WHERE expires_at <=')) {
      expirePins(statement)
    }
  }
  const queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (statement.includes('UNION ALL')) {
      const now = getTimestampLiteral(statement) ?? ''
      const projectId = getWhereLiteral(statement, 'project_id') ?? ''
      const activeManifests = manifests.filter((manifest) => {
        return manifest.projectId === projectId && manifest.status === 'active'
      })
      const lastKnownGoodManifests = activeManifests.flatMap((active) => {
        return manifests.filter((manifest) => {
          return manifest.projectId === active.projectId && manifest.snapshotId === active.lastKnownGoodSnapshotId
        })
      })
      const pinRows = [...pins.values()].filter((pin) => {
        return pin.projectId === projectId && isActivePin(pin, now)
      })

      return [
        ...activeManifests.map((manifest) => {
          return {
            componentStateJson: getStableReviewServingJson(manifest.componentState),
            composedIdentityJson: getStableReviewServingJson(manifest.composedIdentity),
            projectId: manifest.projectId,
            protectedBy: 'activeManifest',
            selectedImportSnapshotId: manifest.selectedImportSnapshotId,
            snapshotId: manifest.snapshotId,
          }
        }),
        ...lastKnownGoodManifests.map((manifest) => {
          return {
            componentStateJson: getStableReviewServingJson(manifest.componentState),
            composedIdentityJson: getStableReviewServingJson(manifest.composedIdentity),
            projectId: manifest.projectId,
            protectedBy: 'lastKnownGoodManifest',
            selectedImportSnapshotId: manifest.selectedImportSnapshotId,
            snapshotId: manifest.snapshotId,
          }
        }),
        ...pinRows.map((pin) => {
          return {
            componentStateJson: null,
            composedIdentityJson: getStableReviewServingJson(pin.composedIdentity),
            projectId: pin.projectId,
            protectedBy: 'pin',
            selectedImportSnapshotId: null,
            snapshotId: pin.snapshotId,
          }
        }),
      ] as T[]
    }

    if (statement.includes('FROM app.review_serving_snapshot_pin')) {
      const now = getTimestampLiteral(statement)
      const pinId = getWhereLiteral(statement, 'pin_id')
      const projectId = getWhereLiteral(statement, 'project_id')
      const snapshotId = getWhereLiteral(statement, 'snapshot_id')
      const ownerKind = getWhereLiteral(statement, 'owner_kind')
      const ownerId = getWhereLiteral(statement, 'owner_id')
      const rows = [...pins.values()].filter((pin) => {
        return (
          (pinId === null || pin.pinId === pinId)
          && (projectId === null || pin.projectId === projectId)
          && (snapshotId === null || pin.snapshotId === snapshotId)
          && (ownerKind === null || pin.ownerKind === ownerKind)
          && (ownerId === null || pin.ownerId === ownerId)
          && (now === null || isActivePin(pin, now))
        )
      })

      return rows.map(getPinQueryRow) as T[]
    }

    return []
  }
  const database = {
    queryJson,
    run,
    transaction: async <T>(operation: (tx: {queryJson: typeof queryJson; run: typeof run}) => Promise<T>) => {
      return operation({queryJson, run})
    },
  } satisfies ReviewServingSnapshotPinRepositoryDatabase

  return {database, manifests, pins, statements}
}

test('snapshot pin acquisition is idempotent by project snapshot identity and owner', async () => {
  const {database} = createFakeSnapshotPinDatabase()
  const first = await acquireReviewServingSnapshotPin(basePinInput, database)
  const second = await acquireReviewServingSnapshotPin(
    {...basePinInput, expiresAt: '2026-06-16T14:00:00.000Z'},
    database,
  )

  expect(first?.pinId).toBe(getReviewServingSnapshotPinId(basePinInput))
  expect(second?.pinId).toBe(first?.pinId)
  expect(second?.refCount).toBe(2)
  expect(second?.expiresAt).toBe('2026-06-16T14:00:00.000Z')
  expect(second?.releasedAt).toBeNull()
})

test('snapshot pin increment and release update ref counts before releasing', async () => {
  const {database} = createFakeSnapshotPinDatabase()
  const acquired = await acquireReviewServingSnapshotPin(basePinInput, database)
  const incremented = await incrementReviewServingSnapshotPin({pinId: acquired?.pinId ?? ''}, database)
  const firstRelease = await releaseReviewServingSnapshotPin({pinId: acquired?.pinId ?? ''}, database)
  const secondRelease = await releaseReviewServingSnapshotPin({pinId: acquired?.pinId ?? ''}, database)

  expect(incremented?.refCount).toBe(2)
  expect(firstRelease?.refCount).toBe(1)
  expect(firstRelease?.releasedAt).toBeNull()
  expect(secondRelease?.refCount).toBe(0)
  expect(secondRelease?.releasedAt).not.toBeNull()
})

test('expired and released pins no longer appear as active pins', async () => {
  const {database} = createFakeSnapshotPinDatabase()
  const expired = await acquireReviewServingSnapshotPin(
    {...basePinInput, expiresAt: '2026-06-16T11:00:00.000Z'},
    database,
  )

  await expireReviewServingSnapshotPins({now: '2026-06-16T12:00:00.000Z', projectId: basePinInput.projectId}, database)

  const activeAfterExpiry = await listActiveReviewServingSnapshotPins(
    {now: '2026-06-16T12:00:00.000Z', projectId: basePinInput.projectId},
    database,
  )
  const released = await releaseReviewServingSnapshotPin({pinId: expired?.pinId ?? ''}, database)

  expect(activeAfterExpiry).toEqual([])
  expect(released?.refCount).toBe(0)
})

test('cleanup eligibility is blocked by active pins and active or last-known-good manifests only', async () => {
  const composedIdentity = {route: 'review.llm.rows', version: 1}
  const {database} = createFakeSnapshotPinDatabase([
    {
      componentState: {required: [{baseGeneration: '1', component: 'display', patchWatermark: '4'}]},
      composedIdentity,
      lastKnownGoodSnapshotId: 'snapshot-lkg',
      projectId: 'project-1',
      selectedImportSnapshotId: 'selected-import-active',
      snapshotId: 'snapshot-active',
      status: 'active',
    },
    {
      componentState: {required: [{baseGeneration: '1', component: 'display', patchWatermark: '3'}]},
      composedIdentity,
      lastKnownGoodSnapshotId: null,
      projectId: 'project-1',
      selectedImportSnapshotId: 'selected-import-lkg',
      snapshotId: 'snapshot-lkg',
      status: 'retired',
    },
  ])

  await acquireReviewServingSnapshotPin({...basePinInput, composedIdentity, snapshotId: 'snapshot-pinned'}, database)

  const protectedStates = await listProtectedReviewServingSnapshotStates(
    {now: '2026-06-16T12:00:00.000Z', projectId: 'project-1'},
    database,
  )
  const activeEligible = await isReviewServingSnapshotStateCleanupEligible(
    {composedIdentity, now: '2026-06-16T12:00:00.000Z', projectId: 'project-1', snapshotId: 'snapshot-active'},
    database,
  )
  const lastKnownGoodEligible = await isReviewServingSnapshotStateCleanupEligible(
    {composedIdentity, now: '2026-06-16T12:00:00.000Z', projectId: 'project-1', snapshotId: 'snapshot-lkg'},
    database,
  )
  const pinnedEligible = await isReviewServingSnapshotStateCleanupEligible(
    {composedIdentity, now: '2026-06-16T12:00:00.000Z', projectId: 'project-1', snapshotId: 'snapshot-pinned'},
    database,
  )
  const obsoleteEligible = await isReviewServingSnapshotStateCleanupEligible(
    {composedIdentity, now: '2026-06-16T12:00:00.000Z', projectId: 'project-1', snapshotId: 'snapshot-obsolete'},
    database,
  )

  expect(
    protectedStates
      .map((state) => {
        return `${state.protectedBy}:${state.snapshotId}`
      })
      .sort(),
  ).toEqual(['activeManifest:snapshot-active', 'lastKnownGoodManifest:snapshot-lkg', 'pin:snapshot-pinned'])
  expect(activeEligible).toBe(false)
  expect(lastKnownGoodEligible).toBe(false)
  expect(pinnedEligible).toBe(false)
  expect(obsoleteEligible).toBe(true)
})
