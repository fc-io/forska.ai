import {type} from 'arktype'

import type {ESearchResultInnerType} from '../pubmedHarvest.ts'

const IdParams = type({
  baseUrl: 'string',
  searchParams: type({
    db: 'string',
    WebEnv: 'string',
    query_key: 'string',
    retstart: 'string',
    retmax: 'string',
    retmode: 'string',
    rettype: 'string',
    email: 'string',
    api_key: 'string',
    tool: 'string',
  }),
})

export const pubmedHarvestGetArticlesParams = (
  {webenv, querykey, count}: ESearchResultInnerType,
  RETMAX: number,
  retstart: number,
): typeof IdParams.infer => {
  const {VITE_NCBI_EMAIL, VITE_NCBI_API_KEY, VITE_NCBI_TOOL} = import.meta.env
  const retmax = String(Math.min(RETMAX, count - retstart))

  const baseUrl = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi'
  const idParams = IdParams.assert({
    baseUrl,
    searchParams: {
      db: 'pubmed',
      WebEnv: webenv,
      query_key: querykey,
      retstart: String(retstart),
      retmax,
      retmode: 'xml',
      rettype: 'abstract', // limits payload but keeps title+abstract
      email: VITE_NCBI_EMAIL,
      api_key: VITE_NCBI_API_KEY,
      tool: VITE_NCBI_TOOL,
    },
  })

  return idParams
}
