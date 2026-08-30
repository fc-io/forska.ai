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

  if (preparedTopology) {
    await prepareJudgmentWorkflowMigrationBoundary(preparedTopology)
  }

  const runningTopology = await startJudgmentWorkflowTopology(
    preparedTopology ? {topology: preparedTopology} : undefined,
  )
  let extraJudge: Awaited<ReturnType<typeof startJudgmentWorkflowTopologyExtraJudge>> | undefined
  let readinessMonitor: ReturnType<typeof startJudgmentWorkflowReadinessMonitor> | undefined

  try {
    const lifecycle = await runJudgmentWorkflowTopologyLifecycle({
      onDistinctJudgeOwners: () => {
        if (!extraJudge) throw new Error('Extra judge was not ready when distinct ownership was observed')
        readinessMonitor ??= startJudgmentWorkflowReadinessMonitor({extraJudge, topology: runningTopology.topology})
      },
      onFirstJobClaimed: async () => {
        extraJudge = await startJudgmentWorkflowTopologyExtraJudge(runningTopology.topology)
      },
      provider,
      topology: runningTopology.topology,
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
    // The fenced worker's accepted request is retried exactly once after its
    // heartbeat and admission lease expire. Owner-backed admission must keep
    // both the live-worker phase and that failover at the configured cap.
    if (providerEvidence.maxConcurrentRequests !== 1 || providerEvidence.requestCount !== 5) {
      throw new Error(`Topology provider admission evidence was unexpected: ${JSON.stringify(providerEvidence)}`)
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
        await stopJudgmentWorkflowTopology(runningTopology)
        provider.close()
      }
    }
  }
}

await runScenario({upgrade: false})
await runScenario({upgrade: true})

const replayProvider = startJudgmentWorkflowTopologyProvider({holdFirstRequest: true})
const replayTopology = await startJudgmentWorkflowTopology()

try {
  const replay = await runJudgmentWorkflowTopologyReplay({provider: replayProvider, topology: replayTopology.topology})
  console.log(
    `[judgment-workflow:topology] complete scenario=journal-replay job=${replay.jobId} claim=${replay.claimId} restarted_pid=${replay.restartedPid}`,
  )
} finally {
  await stopJudgmentWorkflowTopology(replayTopology)
  replayProvider.close()
}
