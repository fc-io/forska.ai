import {
  createJudgmentWorkflowTopology,
  prepareJudgmentWorkflowMigrationBoundary,
  runJudgmentWorkflowTopologyLifecycle,
  startJudgmentWorkflowTopology,
  startJudgmentWorkflowTopologyExtraJudge,
  startJudgmentWorkflowTopologyProvider,
  stopJudgmentWorkflowTopology,
  stopJudgmentWorkflowTopologyExtraJudge,
} from './judgmentWorkflowTopology.ts'

const runScenario = async ({upgrade}: {upgrade: boolean}) => {
  const provider = startJudgmentWorkflowTopologyProvider()
  const preparedTopology = upgrade ? createJudgmentWorkflowTopology() : undefined

  if (preparedTopology) {
    await prepareJudgmentWorkflowMigrationBoundary(preparedTopology)
  }

  const runningTopology = await startJudgmentWorkflowTopology(
    preparedTopology ? {topology: preparedTopology} : undefined,
  )
  const extraJudge = await startJudgmentWorkflowTopologyExtraJudge(runningTopology.topology)

  try {
    const lifecycle = await runJudgmentWorkflowTopologyLifecycle({provider, topology: runningTopology.topology})
    const providerEvidence = lifecycle.providerEvidence()

    if (
      lifecycle.result.judgments.length !== 2
      || lifecycle.result.judgments.some((row) => {
        return Number(row.count) !== 2
      })
    ) {
      throw new Error(`Topology lifecycle produced unexpected canonical judgments: ${JSON.stringify(lifecycle.result)}`)
    }
    if (providerEvidence.maxConcurrentRequests !== 1 || providerEvidence.requestCount !== 4) {
      throw new Error(`Topology provider admission evidence was unexpected: ${JSON.stringify(providerEvidence)}`)
    }
    console.log(
      `[judgment-workflow:topology] complete scenario=${upgrade ? 'migration-boundary' : 'fresh'} api=${runningTopology.topology.apiPort} maintenance=${runningTopology.topology.maintenancePort} judge=${runningTopology.topology.judgePort} judgments=4 provider_max_concurrency=1`,
    )
  } finally {
    try {
      await stopJudgmentWorkflowTopologyExtraJudge(extraJudge)
    } finally {
      await stopJudgmentWorkflowTopology(runningTopology)
      provider.close()
    }
  }
}

await runScenario({upgrade: false})
await runScenario({upgrade: true})
