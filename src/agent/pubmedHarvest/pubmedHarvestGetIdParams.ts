import {type} from 'arktype'
import {format} from 'date-fns'

import type {InputData} from '../../agent.ts'

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

export const pubmedHarvestGetIdParams = (
  input: InputData,
): typeof IdParams.infer => {
  const {fromDate, toDate} = input
  const from = format(fromDate, 'yyyy/MM/dd')
  const to = format(toDate, 'yyyy/MM/dd')

  const {VITE_NCBI_EMAIL, VITE_NCBI_API_KEY, VITE_NCBI_TOOL} = import.meta.env

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
      email: VITE_NCBI_EMAIL,
      api_key: VITE_NCBI_API_KEY,
      tool: VITE_NCBI_TOOL,
    },
  })

  return idParams
}
