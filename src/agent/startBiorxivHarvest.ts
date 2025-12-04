import {biorxivHarvest} from './biorxivHarvest.ts'

export const startBiorxivHarvest = async (input: Parameters<typeof biorxivHarvest>[0]) => {
  console.log('startBiorxivHarvest', input)
  await biorxivHarvest(input)
}
