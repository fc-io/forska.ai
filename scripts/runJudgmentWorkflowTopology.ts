import {startJudgmentWorkflowTopology, stopJudgmentWorkflowTopology} from './judgmentWorkflowTopology.ts'

const runningTopology = await startJudgmentWorkflowTopology()

try {
  console.log(
    `[judgment-workflow:topology] ready api=${runningTopology.topology.apiPort} maintenance=${runningTopology.topology.maintenancePort} judge=${runningTopology.topology.judgePort}`,
  )
} finally {
  await stopJudgmentWorkflowTopology(runningTopology)
}
