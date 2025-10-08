import {type} from 'arktype'
import {$} from 'bun'
import {XMLParser} from 'fast-xml-parser'

import {sleep} from '../utils/sleep.ts'
import type {InputData} from './arxivWorkflow/arxivWorkflowHarvest.ts'
import {pubmedHarvestGetArticlesParams} from './pubmedHarvest/pubmedHarvestGetArticlesParams.ts'
import {pubmedHarvestGetIdParams} from './pubmedHarvest/pubmedHarvestGetIdParams.ts'
import {pubmedHarvestGetParsedXML} from './pubmedHarvest/pubmedHarvestGetParsedXML.ts'
import {pubmedWorkflowStoreEntries} from './pubmedWorkflowStoreEntries.ts'

const ESearchResultInner = type({count: 'string.integer.parse', webenv: 'string', querykey: 'string'})

const Essearchresult = type({esearchresult: ESearchResultInner})

type ESearchResultInnerType = typeof ESearchResultInner.infer

const getEssearchresult = (cliOutput: string) => {
  const parser = new XMLParser({ignoreAttributes: true})
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const root = parser.parse(cliOutput)
  // Support common capitalizations just in case
  const node = root?.eSearchResult ?? root?.esearchresult ?? root?.ESearchResult ?? root?.ESEARCHRESULT
  const count = node?.Count ?? node?.count
  const querykey = node?.QueryKey ?? node?.querykey
  const webenv = node?.WebEnv ?? node?.webenv

  const shaped = {
    esearchresult: {count: String(count ?? '0'), webenv: String(webenv ?? ''), querykey: String(querykey ?? '')},
  }
  const parsed = Essearchresult(shaped)
  if (parsed instanceof type.errors) {
    throw new Error('getEssearchresult: Invalid response from esearch CLI')
  }
  return parsed.esearchresult
}

const RETMAX = 1000

const pubmedHarvestArticles = async (
  esearchresult: typeof ESearchResultInner.infer,
  importRoute: string,
): Promise<void> => {
  // console.log('pubmedHarvestArticles', esearchresult)
  console.log('esearchresult.count', esearchresult.count)
  let retstart = 0
  while (true) {
    const articleParams = pubmedHarvestGetArticlesParams(esearchresult, RETMAX, retstart)
    // Use EDirect CLI (efetch) instead of HTTP fetch
    const sp = articleParams.searchParams
    // Prefer XML output with abstract-only payload when supported
    const responseData =
      await $`efetch -db ${sp.db} -webenv ${sp.WebEnv} -query_key ${sp.query_key} -retstart ${sp.retstart} -retmax ${sp.retmax} -retmode ${sp.retmode} -rettype ${sp.rettype} -email ${sp.email} -api_key ${sp.api_key} -tool ${sp.tool}`.text()
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
  // Use EDirect CLI (esearch) with history to obtain WebEnv/QueryKey
  const sp = idParams.searchParams
  const esearchOutput =
    await $`esearch -db ${sp.db} -query ${sp.term} -datetype ${sp.datetype} -mindate ${sp.mindate} -maxdate ${sp.maxdate} -usehistory ${sp.usehistory} -retmax ${sp.retmax} -email ${sp.email} -api_key ${sp.api_key} -tool ${sp.tool}`.text()
  // console.log('1 pubmed response (CLI)')
  const esearchresult = getEssearchresult(esearchOutput)
  // console.log('2 pubmed esearchresult')
  await pubmedHarvestArticles(esearchresult, input.importRoute)
}

export {type ESearchResultInnerType, Essearchresult, pubmedHarvest}
