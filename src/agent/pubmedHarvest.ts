import {type} from 'arktype'

import {sleep} from '../utils/sleep.ts'
import type {InputData} from './arxivWorkflow/arxivWorkflowHarvest.ts'
import {pubmedHarvestGetArticlesParams} from './pubmedHarvest/pubmedHarvestGetArticlesParams.ts'
import {pubmedHarvestGetIdParams} from './pubmedHarvest/pubmedHarvestGetIdParams.ts'
import {pubmedHarvestGetParsedXML} from './pubmedHarvest/pubmedHarvestGetParsedXML.ts'
import {pubmedWorkflowStoreEntries} from './pubmedWorkflowStoreEntries.ts'

const ESearchResultInner = type({count: 'string.integer.parse', webenv: 'string', querykey: 'string'})

const Essearchresult = type({esearchresult: ESearchResultInner})

type ESearchResultInnerType = typeof ESearchResultInner.infer

const getEssearchresult = async (response: Response) => {
  const responseJson = (await response.json()) as unknown
  const parsed = Essearchresult(responseJson)

  if (parsed instanceof type.errors) {
    throw new Error('getEssearchresult: Invalid response from pubmed')
  }

  return parsed.esearchresult
}

const RETMAX = 100

const pubmedHarvestArticles = async (
  esearchresult: typeof ESearchResultInner.infer,
  importRoute: string,
): Promise<void> => {
  // console.log('pubmedHarvestArticles', esearchresult)
  console.log('esearchresult.count', esearchresult.count)
  let retstart = 0
  while (true) {
    const articleParams = pubmedHarvestGetArticlesParams(esearchresult, RETMAX, retstart)
    // console.log('fetch, with articleParams', articleParams)
    const response = await fetch(articleParams.baseUrl, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams(articleParams.searchParams).toString(),
    })
    const responseData = (await response.text()) as unknown
    // console.log('-----------------')
    // console.log(responseData)
    // console.log('-----------------')

    const entries = await pubmedHarvestGetParsedXML(responseData, importRoute)
    console.log('5 entries', entries.length)
    if (entries.length === 0) {
      console.log('no entries')
      console.log('----------')
      console.log('responseData', responseData)
      console.log('----------')
      break
    }
    if (entries.length > 0) {
      // console.log('6 store entries')
      await pubmedWorkflowStoreEntries(entries)
    }
    // console.log('responseData', responseData)
    console.log('retstart', retstart)

    retstart += RETMAX
    if (retstart >= esearchresult.count) {
      break
    }
    await sleep(100)
  }
}

const pubmedHarvest = async (input: InputData): Promise<void> => {
  // console.log('pubmed input', input)

  const idParams = pubmedHarvestGetIdParams(input)
  console.log('0pubmedIdQuery', idParams)
  const response = await fetch(idParams.baseUrl, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams(idParams.searchParams).toString(),
  })
  // console.log('1 pubmed response')
  const esearchresult = await getEssearchresult(response)
  // console.log('2 pubmed esearchresult')
  await pubmedHarvestArticles(esearchresult, input.importRoute)
}

export {type ESearchResultInnerType, Essearchresult, pubmedHarvest}
