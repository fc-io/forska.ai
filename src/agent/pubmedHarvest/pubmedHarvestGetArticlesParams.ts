import {type} from 'arktype'

import {env as serverEnv} from '../../server/utils/env.ts'
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
  const {NCBI_EMAIL, NCBI_API_KEY, NCBI_TOOL} = serverEnv
  const email = NCBI_EMAIL ?? ''
  const apiKey = NCBI_API_KEY ?? ''
  const tool = NCBI_TOOL ?? ''
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
      email,
      api_key: apiKey,
      tool,
    },
  })

  return idParams
}
