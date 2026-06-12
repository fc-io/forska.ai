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

test('project transfer set-based commit advances dirty tokens for touched write surfaces', () => {
  const result = runDirtyTokenServiceScript<{
    articleIdentifierToken: number | null
    articleToken: number | null
    projectArticleToken: number | null
    projectToken: number | null
    projectTransferHistoryToken: number | null
  }>(`
    const [{writeProjectTransferCommitAppTables}, {getProjectTransferOperationTableNames}] = await Promise.all([
      import('./src/server/services/projectTransfer/projectTransferCommitWriter.ts'),
      import('./src/server/services/projectTransfer/projectTransferOperationTables.ts'),
    ])
    await database.run("INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode) VALUES ('target-provider', 'openai', 'Target Provider', TRUE, 'none')")
    await database.run("INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled) VALUES ('target-model', 'target-provider', 'target-model-name', 'target-remote', 'Target Model', 'manual', TRUE)")

    const escapeSql = (value) => String(value).replaceAll("'", "''")
    const jsonLiteral = (value) => "CAST('" + escapeSql(JSON.stringify(value)) + "' AS JSON)"
    const operationDatabase = (tx) => ({
      queryJson: tx.queryJson,
      run: tx.run,
      transaction: (work) => Promise.resolve(work(tx)),
    })
    const createOperationPayloadTable = (tx, tableName, rows) => {
      return tx.run(\`
        CREATE TEMP TABLE \${tableName} AS
        SELECT
          row_number() OVER () - 1 AS row_index,
          row_json AS payload_json
        FROM UNNEST(json_extract(\${jsonLiteral(rows)}, '$[*]')) AS rows(row_json)
      \`)
    }
    const now = new Date('2026-06-12T11:00:00.000Z')
    const settings = {humanJudgmentMode: 'prompt', useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
    const article = {
      articleId: 'legacy-dirty-token-article',
      articleTitle: 'Dirty Token Article',
      doi: '10.1000/dirty-token-article',
      identifierInputs: [],
      provenance: {sourceArticleId: 'source-dirty-token-article'},
      signature: {identifierKeys: ['doi:10.1000/dirty-token-article'], title: 'Dirty Token Article'},
      sourceArticleId: 'source-dirty-token-article',
    }
    const projectArticle = {
      provenance: {sourceArticleId: 'source-dirty-token-article', sourceProjectId: 'source-project'},
      signature: {},
      sourceArticleId: 'source-dirty-token-article',
      sourceProjectArticleId: 'source-project-article-dirty-token',
      sourceProjectId: 'source-project',
    }
    const project = {
      dateFrom: null,
      dateTo: null,
      description: 'Dirty token project',
      modelSignature: {name: 'Model Signature'},
      name: 'Dirty Token Project',
      provenance: {sourceProjectId: 'source-project'},
      settings,
      signature: {modelSignature: {name: 'Model Signature'}, name: 'Dirty Token Project', settings},
      sourceProjectId: 'source-project',
    }
    const model = {
      modelName: 'target-model-name',
      name: 'target-model-name',
      provenance: {sourceModelId: 'source-model', sourceProviderConnectionId: 'source-provider'},
      remoteModelId: 'target-remote',
      signature: {name: 'Model Signature'},
      sourceModelId: 'source-model',
      sourceProviderConnectionId: 'source-provider',
      variant: null,
      version: null,
    }
    const targetPlan = {
      articleMatches: [
        {
          action: 'create',
          candidates: [],
          conflicts: [],
          identifierKeys: ['doi:10.1000/dirty-token-article'],
          packageArticleId: 'legacy-dirty-token-article',
          selectedTargetArticleId: null,
          sourceArticleId: 'source-dirty-token-article',
        },
      ],
      articleRoutePlan: [],
      articleUpdatePlan: [],
      assetPromotionPlan: [],
      duplicateImportMatches: [],
      projectPromptPlan: [],
      projectRoutePlan: [],
      promptPlan: [],
    }
    const plan = {
      blockers: [],
      canCommit: true,
      dependencyResolution: {
        modelTargetBySourceId: {'source-model': 'target-model'},
        providerTargetBySourceId: {'source-provider': 'target-provider'},
      },
      packageCounts: {
        articleImportRoutes: 0,
        assetManifest: 0,
        articles: 1,
        humanJudgmentSummaries: 0,
        humanJudgments: 0,
        importRoutes: 0,
        judgmentAssessments: 0,
        judgments: 0,
        models: 1,
        project: 1,
        projectArticles: 1,
        projectImportRoutes: 0,
        projectPrompts: 0,
        prompts: 0,
        providerConnections: 0,
        reviews: 0,
      },
      packageFingerprint: 'fingerprint-dirty-token-commit',
      packageWarnings: [],
      planRevision: 1,
      resolutionKinds: {},
      summary: {
        blockerCount: 0,
        conflictCounts: {
          articleConflictCount: 0,
          humanReviewFidelityConflictCount: 0,
          judgmentConflictCount: 0,
          packageContractConflictCount: 0,
          projectPromptConflictCount: 0,
        },
        dependencyStatuses: {},
        judgmentConflictStatus: 'clear',
        overlapCounts: {
          currentReviewRowsSignatureHumanReviewCount: 0,
          currentReviewRowsSignatureJudgmentCount: 0,
          dirtiedExistingProjectCount: 0,
          duplicateImportMatchCount: 0,
          newArticleCount: 1,
          omittedArticleRouteLinkCount: 0,
          omittedRouteLinkCount: 0,
          reusedArticleAssetPromotionCount: 0,
          reusedArticleCount: 0,
          reusedArticleFieldFillCount: 0,
          reusedArticleUpdateCount: 0,
          reusedJudgmentCount: 0,
          routeArticleSnapshotLinkCount: 0,
          snapshotVerifiedJudgmentCount: 0,
          storedSignatureHumanReviewCount: 0,
          storedSignatureJudgmentCount: 0,
        },
        warningCount: 0,
      },
      targetPlan,
    }
    const payloads = {articles: [article], models: [model], project, projectArticles: [projectArticle]}
    const promotion = {
      articleCreates: [{article, sourceArticleId: 'source-dirty-token-article'}],
      articleFieldFills: [],
      manifest: {createdAt: now.toISOString(), promotions: [], sessionId: 'session-dirty-token-commit', updatedAt: now.toISOString()},
      promotionPathByPackagePath: {},
    }
    const operationTables = getProjectTransferOperationTableNames('commit_dirty_token_writer')

    await database.transaction(async (tx) => {
      await createOperationPayloadTable(tx, operationTables.tableNames.articles, [article])
      await createOperationPayloadTable(tx, operationTables.tableNames.articleImportRoutes, [])
      await createOperationPayloadTable(tx, operationTables.tableNames.projectArticles, [projectArticle])

      await writeProjectTransferCommitAppTables({
        commitId: 'commit-dirty-token-writer',
        database: operationDatabase(tx),
        now,
        operationTables,
        payloads,
        plan,
        promotion,
        schemaVersion: 1,
        sessionId: 'session-dirty-token-commit',
      })
    })

    const snapshot = await service.getTargetStateDirtyTokenSnapshot()

    console.log(JSON.stringify({
      articleIdentifierToken: snapshot.tokens.articleIdentifier ?? null,
      articleToken: snapshot.tokens.article ?? null,
      projectArticleToken: snapshot.tokens.projectArticle ?? null,
      projectToken: snapshot.tokens.project ?? null,
      projectTransferHistoryToken: snapshot.tokens.projectTransferHistory ?? null,
    }))
  `)

  expect(result).toEqual({
    articleIdentifierToken: 1,
    articleToken: 1,
    projectArticleToken: 1,
    projectToken: 1,
    projectTransferHistoryToken: 1,
  })
})
