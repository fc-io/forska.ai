import {type} from 'arktype'
import {$} from 'bun'
import {XMLParser} from 'fast-xml-parser'

import {sleep} from '../utils/sleep.ts'
import type {InputData} from './arxivWorkflow/arxivWorkflowHarvest.ts'
import {pubmedHarvestGetIdParams} from './pubmedHarvest/pubmedHarvestGetIdParams.ts'
import {pubmedHarvestGetParsedXML} from './pubmedHarvest/pubmedHarvestGetParsedXML.ts'
import {pubmedWorkflowStoreEntries} from './pubmedWorkflowStoreEntries.ts'

const ESearchResultInner = type({count: 'string.integer.parse', webenv: 'string', querykey: 'string'})

const Essearchresult = type({esearchresult: ESearchResultInner})

const getEssearchresult = (cliOutput: string) => {
  console.log('getEssearchresult', cliOutput)
  const parser = new XMLParser({ignoreAttributes: true})
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const root = parser.parse(cliOutput)
  const asObject = (x: unknown): Record<string, unknown> | undefined => {
    return typeof x === 'object' && x !== null ? (x as Record<string, unknown>) : undefined
  }
  const r = asObject(root)
  const eNode = asObject(r?.['eSearchResult'] ?? r?.['esearchresult'] ?? r?.['ESearchResult'] ?? r?.['ESEARCHRESULT'])
  const dNode = asObject(r?.['ENTREZ_DIRECT'] ?? r?.['Entrez_Direct'] ?? r?.['entrez_direct'])
  const count = eNode?.['Count'] ?? eNode?.['count'] ?? dNode?.['Count'] ?? dNode?.['count']
  const querykey = eNode?.['QueryKey'] ?? eNode?.['querykey']
  const webenv = eNode?.['WebEnv'] ?? eNode?.['webenv']
  const countStr = typeof count === 'string' || typeof count === 'number' ? String(count) : '0'
  const querykeyStr = typeof querykey === 'string' ? querykey : ''
  const webenvStr = typeof webenv === 'string' ? webenv : ''

  const shaped = {esearchresult: {count: countStr, webenv: webenvStr, querykey: querykeyStr}}
  const parsed = Essearchresult(shaped)
  if (parsed instanceof type.errors) {
    throw new Error('getEssearchresult: Invalid response from esearch CLI')
  }
  return parsed.esearchresult
}

const RETMAX = 10

const pubmedHarvestArticles = async (
  esearchresult: typeof ESearchResultInner.infer,
  importRoute: string,
): Promise<void> => {
  // console.log('pubmedHarvestArticles', esearchresult)
  console.log('esearchresult.count', esearchresult.count)
  let retstart = 0
  while (true) {
    // const retmax = String(Math.min(RETMAX, esearchresult.count - retstart))
    // Use EDirect CLI (efetch) instead of HTTP fetch
    // Prefer XML output with abstract-only payload when supported
    const responseData = await $`
      efetch \
        -db pubmed \
        -format xml \
    `.text()
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
  let esearchOutput = ''
  try {
    esearchOutput = await $`
    esearch \
      -db ${sp.db} \
      -query ${sp.term} \
      -datetype ${sp.datetype} \
      -mindate ${sp.mindate} \
      -maxdate ${sp.maxdate}
    `.text()
  } catch (error) {
    console.error('Error executing esearch', error)
    throw error
  }
  console.log('1 pubmed response (CLI)')
  try {
    const esearchresult = getEssearchresult(esearchOutput)
    console.log('2 pubmed esearchresult')
    await pubmedHarvestArticles(esearchresult, input.importRoute)
  } catch (error) {
    console.error('Error getting esearchresult', error)
    throw error
  }
}

export {Essearchresult, pubmedHarvest}
