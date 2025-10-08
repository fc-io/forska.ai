// import {pubmedHarvest} from './agent/pubmedHarvest.ts'
import {startArxivHarvest} from './agent/startArxivHarvest.ts'

export const runAgentHarvest = async () => {
  console.log('start agent_harvest', 'import.meta.env.DEV', import.meta.env.DEV)

  const config = {fromDate: '2025-07-01', toDate: '2025-07-31', importRoute: '/api/datasources/import/arxiv'}
  await startArxivHarvest(config)
  // await pubmedHarvest(config)
  console.log('end agent_harvest')
}
