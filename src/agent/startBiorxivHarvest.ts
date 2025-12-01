import type {InputData} from './arxivWorkflow/arxivWorkflowHarvest.ts'
import {biorxivHarvest} from './biorxivHarvest.ts'

export const startBiorxivHarvest = async (input: InputData) => {
  console.log('startBiorxivHarvest', input)
  await biorxivHarvest(input)
}
