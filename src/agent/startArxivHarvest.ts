import {arxivWorkflowHarvest} from './arxivWorkflow/arxivWorkflowHarvest.ts'

export const startArxivHarvest = async (input: Parameters<typeof arxivWorkflowHarvest>[0]) => {
  console.log('startArxivHarvest', input)
  await arxivWorkflowHarvest(input)
}
