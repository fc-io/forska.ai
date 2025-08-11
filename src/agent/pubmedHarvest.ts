import {type} from 'arktype'

import type {InputData} from '../agent.ts'
import {sleep} from '../utils/sleep.ts'
import {pubmedHarvestGetArticlesParams} from './pubmedHarvest/pubmedHarvestGetArticlesParams.ts'
import {pubmedHarvestGetIdParams} from './pubmedHarvest/pubmedHarvestGetIdParams.ts'
import {pubmedHarvestGetParsedXML} from './pubmedHarvest/pubmedHarvestGetParsedXML.ts'

const ESearchResultInner = type({
  count: 'string.integer.parse',
  webenv: 'string',
  querykey: 'string',
})

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

const RETMAX = 2

const pubmedHarvestArticles = async (
  esearchresult: typeof ESearchResultInner.infer,
): Promise<void> => {
  console.log('pubmedHarvestArticles', esearchresult)
  let retstart = 0
  while (true) {
    const articleParams = pubmedHarvestGetArticlesParams(
      esearchresult,
      RETMAX,
      retstart,
    )
    console.log('fetch, with articleParams', articleParams)
    const response = await fetch(articleParams.baseUrl, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams(articleParams.searchParams).toString(),
    })
    const responseData = (await response.text()) as unknown
    await pubmedHarvestGetParsedXML(responseData)
    console.log('responseData', responseData)
    retstart += RETMAX
    await sleep(100)
  }
}

const pubmedHarvest = async (input: InputData): Promise<void> => {
  const idParams = pubmedHarvestGetIdParams(input)
  console.log('pubmedIdQuery', idParams)
  const response = await fetch(idParams.baseUrl, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams(idParams.searchParams).toString(),
  })

  const esearchresult = await getEssearchresult(response)
  await pubmedHarvestArticles(esearchresult)
  // const result = await fetchRecords(arxivQueryUrl)
  // await arxivWorkflowStoreEntires(result.records)
  // if (result.resumptionToken) {
  // await sleep(5000)
  // await arxivWorkflowHarvest(input, result.resumptionToken)
  // }
}

export {type ESearchResultInnerType, Essearchresult, pubmedHarvest}
