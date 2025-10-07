import {type} from 'arktype'
import {format} from 'date-fns'

import {env as serverEnv} from '../../server/utils/env.ts'
import type {InputData} from '../arxivWorkflow/arxivWorkflowHarvest.ts'

const IdParams = type({
  baseUrl: 'string',
  searchParams: type({
    db: 'string',
    term: 'string',
    datetype: 'string',
    mindate: 'string',
    maxdate: 'string',
    usehistory: 'string',
    retmax: 'string',
    retmode: 'string',
    email: 'string',
    api_key: 'string',
    tool: 'string',
  }),
})

export const pubmedHarvestGetIdParams = (input: InputData): typeof IdParams.infer => {
  const {fromDate, toDate} = input
  const from = format(fromDate, 'yyyy/MM/dd')
  const to = format(toDate, 'yyyy/MM/dd')

  const {NCBI_EMAIL, NCBI_API_KEY, NCBI_TOOL} = serverEnv
  const email = NCBI_EMAIL ?? ''
  const apiKey = NCBI_API_KEY ?? ''
  const tool = NCBI_TOOL ?? ''

  const baseUrl = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi'
  const idParams = IdParams.assert({
    baseUrl,
    searchParams: {
      db: 'pubmed',
      term: '*', // wildcard – the date filter does the work
      datetype: 'mdat',
      mindate: from, // YYYY/MM/DD
      maxdate: to,
      usehistory: 'y',
      retmax: '0',
      retmode: 'json',
      email,
      api_key: apiKey,
      tool,
    },
  })

  return idParams
}
