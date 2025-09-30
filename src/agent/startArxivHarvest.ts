import {arxivWorkflowHarvest, type InputData} from './arxivWorkflow/arxivWorkflowHarvest.ts'

export const startArxivHarvest = async (input: InputData) => {
  console.log('startArxivHarvest', input)
  await arxivWorkflowHarvest(input)
}
