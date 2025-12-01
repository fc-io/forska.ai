import type {InputData} from './arxivWorkflow/arxivWorkflowHarvest.ts'
import {medrxivHarvest} from './medrxivHarvest.ts'

export const startMedrxivHarvest = async (input: InputData) => {
  console.log('startMedrxivHarvest', input)
  await medrxivHarvest(input)
}
