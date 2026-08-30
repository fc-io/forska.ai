import {
  createJudgmentWorkflowTopology,
  prepareJudgmentWorkflowMigrationBoundary,
  runJudgmentWorkflowTopologyLifecycle,
  runJudgmentWorkflowTopologyReplay,
  startJudgmentWorkflowReadinessMonitor,
  startJudgmentWorkflowTopology,
  startJudgmentWorkflowTopologyExtraJudge,
  startJudgmentWorkflowTopologyProvider,
  stopJudgmentWorkflowTopology,
  stopJudgmentWorkflowTopologyExtraJudge,
} from './judgmentWorkflowTopology.ts'

const runScenario = async ({upgrade}: {upgrade: boolean}) => {
  const provider = startJudgmentWorkflowTopologyProvider({holdFirstRequest: true})
  const preparedTopology = upgrade ? createJudgmentWorkflowTopology() : undefined
  let runningTopology: Awaited<ReturnType<typeof startJudgmentWorkflowTopology>> | undefined
  let extraJudge: Awaited<ReturnType<typeof startJudgmentWorkflowTopologyExtraJudge>> | undefined
  let readinessMonitor: ReturnType<typeof startJudgmentWorkflowReadinessMonitor> | undefined

  try {
    if (preparedTopology) {
      await prepareJudgmentWorkflowMigrationBoundary(preparedTopology)
    }

    const startedTopology = await startJudgmentWorkflowTopology(
      preparedTopology ? {topology: preparedTopology} : undefined,
    )
    runningTopology = startedTopology
    const lifecycle = await runJudgmentWorkflowTopologyLifecycle({
      onDistinctJudgeOwners: () => {
        if (!extraJudge) throw new Error('Extra judge was not ready when distinct ownership was observed')
        readinessMonitor ??= startJudgmentWorkflowReadinessMonitor({extraJudge, topology: startedTopology.topology})
      },
      onFirstJobClaimed: async () => {
        extraJudge = await startJudgmentWorkflowTopologyExtraJudge(startedTopology.topology)
      },
      provider,
      topology: startedTopology.topology,
    })
    const providerEvidence = lifecycle.providerEvidence()
    readinessMonitor?.assertHealthy()

    if (
      lifecycle.result.judgments.length !== 2
      || lifecycle.result.judgments.some((row) => {
        return Number(row.count) !== 2
      })
    ) {
      throw new Error(`Topology lifecycle produced unexpected canonical judgments: ${JSON.stringify(lifecycle.result)}`)
    }
    if (
      upgrade
      && (lifecycle.result.migrationBoundary.appliedMigrations.join(',')
        !== [
          '0090_comparisonServingAnswerFilterBooleans.sql',
          '0093_judgmentJobMaintenanceIndexes.sql',
          '0224_reviewServingDirtyWorkLifecycleReason.sql',
          '0225_rebuildReviewServingManifestsWithoutIndexes.sql',
        ].join(',')
        || lifecycle.result.migrationBoundary.sentinel.count !== 1
        || lifecycle.result.migrationBoundary.sentinel.requests !== 1
        || lifecycle.result.migrationBoundary.sentinel.promptTokens !== 11
        || lifecycle.result.migrationBoundary.sentinel.completionTokens !== 7
        || lifecycle.result.migrationBoundary.sentinel.totalTokens !== 18
        || lifecycle.result.migrationBoundary.sentinel.requestAttempts !== null)
    ) {
      throw new Error(
        `Migration-boundary topology did not preserve its deployed-schema sentinel: ${JSON.stringify(lifecycle.result.migrationBoundary)}`,
      )
    }
    // The fenced worker's accepted request is retried exactly once after its
    // heartbeat and admission lease expire. Owner-backed admission must keep
    // both the live-worker phase and that failover at the configured cap.
    if (providerEvidence.maxConcurrentRequests !== 1 || providerEvidence.requestCount !== 5) {
      const requestSummary = providerEvidence.renderedInputs.map((input) => {
        return {
          article: input.includes('Topology article A') ? 'A' : input.includes('Topology article B') ? 'B' : 'unknown',
          criterion: input.includes('criterion A') ? 'A' : input.includes('criterion B') ? 'B' : 'unknown',
          retry: input.includes('Your previous answer'),
        }
      })
      throw new Error(
        `Topology provider admission evidence was unexpected: ${JSON.stringify({maxConcurrentRequests: providerEvidence.maxConcurrentRequests, requestCount: providerEvidence.requestCount, requestSummary})}`,
      )
    }
    if (
      lifecycle.result.judgments.some((row) => {
        return (
          row.modelId !== lifecycle.fixture.modelId
          || !row.useTitle
          || !row.useAbstract
          || row.useFulltext
          || row.useFulltextNoImages
        )
      })
    ) {
      throw new Error(`Topology persisted incorrect model/content flags: ${JSON.stringify(lifecycle.result.judgments)}`)
    }
    const renderedText = providerEvidence.renderedInputs.join('\n')
    if (
      !renderedText.includes('Topology article A')
      || !renderedText.includes('Topology article B')
      || !renderedText.includes('Deterministic abstract A')
      || !renderedText.includes('Deterministic abstract B')
      || renderedText.includes('FULLTEXT_SENTINEL_')
      || renderedText.includes('IMAGE_SENTINEL_')
    ) {
      throw new Error(`Topology rendered input violated title/abstract-only contract: ${renderedText}`)
    }
    console.log(
      `[judgment-workflow:topology] complete scenario=${upgrade ? 'migration-boundary' : 'fresh'} api=${runningTopology.topology.apiPort} maintenance=${runningTopology.topology.maintenancePort} judge=${runningTopology.topology.judgePort} judgments=4 provider_max_concurrency=1`,
    )
  } finally {
    try {
      await readinessMonitor?.stop()
    } finally {
      try {
        if (extraJudge) await stopJudgmentWorkflowTopologyExtraJudge(extraJudge)
      } finally {
        try {
          if (runningTopology) await stopJudgmentWorkflowTopology(runningTopology)
        } finally {
          provider.close()
        }
      }
    }
  }
}

const requestedScenario = process.argv[2] ?? 'all'
if (!['all', 'fresh', 'migration-boundary', 'journal-replay'].includes(requestedScenario)) {
  throw new Error(`Unknown topology scenario: ${requestedScenario}`)
}

if (requestedScenario === 'all' || requestedScenario === 'fresh') await runScenario({upgrade: false})
if (requestedScenario === 'all' || requestedScenario === 'migration-boundary') await runScenario({upgrade: true})

if (requestedScenario === 'all' || requestedScenario === 'journal-replay') {
  const replayProvider = startJudgmentWorkflowTopologyProvider({holdFirstRequest: true})
  let replayTopology: Awaited<ReturnType<typeof startJudgmentWorkflowTopology>> | undefined

  try {
    replayTopology = await startJudgmentWorkflowTopology()
    const replay = await runJudgmentWorkflowTopologyReplay({
      provider: replayProvider,
      topology: replayTopology.topology,
    })
    console.log(
      `[judgment-workflow:topology] complete scenario=journal-replay job=${replay.jobId} claim=${replay.claimId} restarted_pid=${replay.restartedPid}`,
    )
  } finally {
    try {
      if (replayTopology) await stopJudgmentWorkflowTopology(replayTopology)
    } finally {
      replayProvider.close()
    }
  }
}
