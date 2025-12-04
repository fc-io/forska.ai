import {medrxivHarvest} from './medrxivHarvest.ts'

export const startMedrxivHarvest = async (input: Parameters<typeof medrxivHarvest>[0]) => {
  console.log('startMedrxivHarvest', input)
  await medrxivHarvest(input)
}
