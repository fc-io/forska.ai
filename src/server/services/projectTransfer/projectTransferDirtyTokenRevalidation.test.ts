import {rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

import {
  getProjectTransferDirtyTokenRevalidationDecision,
  getProjectTransferDirtyTokenStalePlanReasons,
} from './projectTransferDirtyTokenRevalidation.ts'
import {
  projectTransferDependencyFingerprintAlgorithm,
  projectTransferDependencyFingerprintCodeVersion,
  projectTransferTargetStateCoverageCodeVersion,
  type ProjectTransferTargetStateDirtyTokenSnapshot,
  type ProjectTransferTargetStateSafetySurface,
  projectTransferTargetStateSafetySurfaces,
} from './projectTransferTargetStateDirtyTokenService.ts'

const removeFileIfExists = (filePath: string) => {
  rmSync(filePath, {force: true, recursive: true})
}

const getLastJsonLine = (stdout: string) => {
  return (
    stdout
      .split('\n')
      .map((line) => {
        return line.trim()
      })
      .filter((line) => {
        return line !== ''
      })
      .at(-1) ?? ''
  )
}

const getCompleteTokens = (overrides?: Partial<Record<ProjectTransferTargetStateSafetySurface, number>>) => {
  return projectTransferTargetStateSafetySurfaces.reduce<
    Partial<Record<ProjectTransferTargetStateSafetySurface, number>>
  >((tokens, surface) => {
    return {...tokens, [surface]: overrides?.[surface] ?? 0}
  }, {})
}

const getSnapshot = (
  overrides?: Partial<ProjectTransferTargetStateDirtyTokenSnapshot>,
): ProjectTransferTargetStateDirtyTokenSnapshot => {
  return {
    capturedAt: '2026-06-12T10:00:00.000Z',
    coverage: {
      coverageCodeVersion: projectTransferTargetStateCoverageCodeVersion,
      coveredSurfaces: [...projectTransferTargetStateSafetySurfaces],
      dependencyFingerprintAlgorithm: projectTransferDependencyFingerprintAlgorithm,
      dependencyFingerprintCodeVersion: projectTransferDependencyFingerprintCodeVersion,
      initializedAt: '2026-06-12T09:00:00.000Z',
      updatedAt: '2026-06-12T09:00:00.000Z',
    },
    globalUnknownToken: 0,
    tokens: getCompleteTokens(),
    ...overrides,
  }
}

const runDirtyTokenServiceScript = <TResult>(body: string) => {
  const duckdbPath = `/tmp/f2-project-transfer-dirty-token-${Date.now()}-${Math.random().toString(16).slice(2)}.duckdb`
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}, dirtyTokens] = await Promise.all([
          import('./src/db/migrateDuckdb.ts'),
          import('./src/server/services/appDatabaseService.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
          import('./src/server/services/projectTransfer/projectTransferTargetStateDirtyTokenService.ts'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()
        await migrateDuckdb()

        const database = getAppDatabaseService()
        const service = dirtyTokens.getProjectTransferTargetStateDirtyTokenService()

        ${body}

        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39991',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39992',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Dirty token service script failed')
    }

    return JSON.parse(getLastJsonLine(result.stdout.toString())) as TResult
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
    removeFileIfExists(`${duckdbPath}.tmp`)
    removeFileIfExists('/tmp/duckdb-temp')
  }
}

test('project transfer dirty-token revalidation falls back when coverage or tokens are missing', () => {
  const completeSnapshot = getSnapshot()
  const missingArticleTokens = getCompleteTokens()
  delete missingArticleTokens.article
  const missingAnalyzed = getProjectTransferDirtyTokenRevalidationDecision({
    analyzedTargetState: null,
    currentTargetState: completeSnapshot,
  })
  const missingCurrent = getProjectTransferDirtyTokenRevalidationDecision({
    analyzedTargetState: completeSnapshot,
    currentTargetState: null,
  })
  const missingToken = getProjectTransferDirtyTokenRevalidationDecision({
    analyzedTargetState: getSnapshot({tokens: missingArticleTokens}),
    currentTargetState: completeSnapshot,
  })
  const incompleteCoverage = getProjectTransferDirtyTokenRevalidationDecision({
    analyzedTargetState: getSnapshot({
      coverage: {...(completeSnapshot.coverage as NonNullable<typeof completeSnapshot.coverage>), coveredSurfaces: []},
    }),
    currentTargetState: completeSnapshot,
  })

  expect(missingAnalyzed).toMatchObject({reason: 'analyzed_target_state_missing', status: 'full_revalidation_required'})
  expect(missingCurrent).toMatchObject({reason: 'current_target_state_missing', status: 'full_revalidation_required'})
  expect(missingToken).toMatchObject({
    changedSurfaces: ['article'],
    reason: 'target_state_dirty_token_missing',
    status: 'full_revalidation_required',
  })
  expect(incompleteCoverage).toMatchObject({
    reason: 'analyzed_target_state_coverage_incomplete',
    status: 'full_revalidation_required',
  })
})

test('project transfer dirty-token revalidation requires matching coverage versions before incremental eligibility', () => {
  const completeSnapshot = getSnapshot()
  const staleCoverage = getProjectTransferDirtyTokenRevalidationDecision({
    analyzedTargetState: getSnapshot({
      coverage: {
        ...(completeSnapshot.coverage as NonNullable<typeof completeSnapshot.coverage>),
        coverageCodeVersion: 'older-coverage-version',
      },
    }),
    currentTargetState: completeSnapshot,
    enableIncrementalRevalidation: true,
  })
  const staleFingerprint = getProjectTransferDirtyTokenRevalidationDecision({
    analyzedTargetState: getSnapshot({
      coverage: {
        ...(completeSnapshot.coverage as NonNullable<typeof completeSnapshot.coverage>),
        dependencyFingerprintCodeVersion: 'older-fingerprint-version',
      },
    }),
    currentTargetState: completeSnapshot,
    enableIncrementalRevalidation: true,
  })
  const enabledByDefault = getProjectTransferDirtyTokenRevalidationDecision({
    analyzedTargetState: completeSnapshot,
    currentTargetState: completeSnapshot,
  })
  const disabled = getProjectTransferDirtyTokenRevalidationDecision({
    analyzedTargetState: completeSnapshot,
    currentTargetState: completeSnapshot,
    enableIncrementalRevalidation: false,
  })

  expect(staleCoverage).toMatchObject({
    reason: 'target_state_coverage_version_changed',
    status: 'full_revalidation_required',
  })
  expect(staleFingerprint).toMatchObject({
    reason: 'target_state_dependency_fingerprint_version_changed',
    status: 'full_revalidation_required',
  })
  expect(enabledByDefault).toMatchObject({eligible: true, reason: 'target_state_unchanged'})
  expect(disabled).toMatchObject({reason: 'incremental_revalidation_disabled', status: 'full_revalidation_required'})
})

test('project transfer dirty-token revalidation reports changed surfaces as stale-plan reasons', () => {
  const completeSnapshot = getSnapshot()
  const changed = getProjectTransferDirtyTokenRevalidationDecision({
    analyzedTargetState: completeSnapshot,
    currentTargetState: getSnapshot({tokens: getCompleteTokens({article: 2, prompt: 3, projectTransferHistory: 4})}),
  })
  const reasons = getProjectTransferDirtyTokenStalePlanReasons(changed)

  expect(changed).toMatchObject({
    changedSurfaces: ['article', 'prompt', 'projectTransferHistory'],
    reason: 'target_state_dirty_token_changed',
    status: 'full_revalidation_required',
  })
  expect(reasons).toMatchObject({
    duplicatePackageHistory: [{reason: 'target_state_dirty_token_changed'}],
    targetArticle: [{reason: 'target_state_dirty_token_changed'}],
    targetPrompt: [{reason: 'target_state_dirty_token_changed'}],
  })
})

test('project transfer dirty-token revalidation maps full fallback reasons to conservative stale surfaces', () => {
  const completeSnapshot = getSnapshot()
  const unknownChanged = getProjectTransferDirtyTokenRevalidationDecision({
    analyzedTargetState: completeSnapshot,
    currentTargetState: getSnapshot({globalUnknownToken: 1}),
  })
  const dependencyFingerprintChanged = getProjectTransferDirtyTokenRevalidationDecision({
    analyzedTargetState: getSnapshot({
      coverage: {
        ...(completeSnapshot.coverage as NonNullable<typeof completeSnapshot.coverage>),
        dependencyFingerprintCodeVersion: 'older-fingerprint-version',
      },
    }),
    currentTargetState: completeSnapshot,
  })

  expect(Object.keys(getProjectTransferDirtyTokenStalePlanReasons(unknownChanged)).sort()).toEqual([
    'assessment',
    'dependency',
    'duplicatePackageHistory',
    'humanReview',
    'judgment',
    'targetArticle',
    'targetProject',
    'targetPrompt',
    'targetRoute',
  ])
  expect(Object.keys(getProjectTransferDirtyTokenStalePlanReasons(dependencyFingerprintChanged)).sort()).toEqual([
    'assessment',
    'dependency',
    'humanReview',
    'judgment',
  ])
})

test('project transfer target-state service stores coverage and advances known and unknown tokens', () => {
  const result = runDirtyTokenServiceScript<{
    articleToken: number | null
    coverageComplete: boolean
    coverageSurfaces: string[]
    globalUnknownToken: number
    promptToken: number | null
  }>(`
    const before = await service.getTargetStateDirtyTokenSnapshot()
    const coverage = await service.initializeTargetStateCoverage({
      now: new Date('2026-06-12T09:00:00.000Z'),
    })
    await service.advanceTargetStateDirtyTokensAtomically({
      now: new Date('2026-06-12T09:01:00.000Z'),
      reason: 'test.known',
      surfaces: ['article', 'prompt'],
    })
    await service.advanceGlobalUnknownTargetStateDirtyTokenAtomically({
      now: new Date('2026-06-12T09:02:00.000Z'),
      reason: 'test.unknown',
    })
    const after = await service.getTargetStateDirtyTokenSnapshot()

    console.log(JSON.stringify({
      articleToken: after.tokens.article ?? null,
      coverageComplete: dirtyTokens.isProjectTransferTargetStateCoverageComplete(after),
      coverageSurfaces: coverage.coveredSurfaces,
      globalUnknownToken: after.globalUnknownToken,
      promptToken: after.tokens.prompt ?? null,
      beforeCoverage: before.coverage,
    }))
  `)

  expect(result.coverageComplete).toBe(true)
  expect(result.coverageSurfaces).toEqual([...projectTransferTargetStateSafetySurfaces])
  expect(result.articleToken).toBe(1)
  expect(result.promptToken).toBe(1)
  expect(result.globalUnknownToken).toBe(1)
})
