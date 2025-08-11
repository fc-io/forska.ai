import {format} from 'date-fns'

import type {InputData} from '../../agent.ts'

const MAX_ITEMS_PER_PAGE = 2000

const getArxivIdsQueryUrl = (
  fromDate: Date,
  toDate: Date,
  resumptionToken?: string,
): string => {
  const from = format(fromDate, 'yyyy-MM-dd')
  const to = format(toDate, 'yyyy-MM-dd')

  const baseUrl = import.meta.env.DEV
    ? '/api/arxiv'
    : 'https://oaipmh.arxiv.org'

  // Add set parameter if searchTerm maps to a specific arXiv category
  // For general search terms, we'll need to filter results after fetching
  // if (isArxivCategory(searchTerm)) {
  //   url += `&set=${encodeURIComponent(searchTerm)}`
  // }

  return resumptionToken
    ? `${baseUrl}/oai?verb=ListRecords&resumptionToken=${resumptionToken}`
    : `${baseUrl}/oai?verb=ListRecords&metadataPrefix=arXiv&from=${from}&until=${to}`
}

// Helper function to check if search term is an arXiv category
// const isArxivCategory = (searchTerm: string): boolean => {
//   // Common arXiv categories - this could be expanded
//   const categories = [
//     'cs',
//     'math',
//     'physics',
//     'q-bio',
//     'q-fin',
//     'stat',
//     'astro-ph',
//     'cond-mat',
//     'gr-qc',
//     'hep-ex',
//     'hep-lat',
//     'hep-ph',
//     'hep-th',
//     'math-ph',
//     'nlin',
//     'nucl-ex',
//     'nucl-th',
//     'physics',
//     'quant-ph',
//   ]
//   return categories.some((cat) => {
//     return searchTerm.toLowerCase().startsWith(cat)
//   })
// }

const arxivWorkflowGetQuery = (
  inputData: InputData,
  resumptionToken?: string,
) => {
  const {fromDate: fromDateString, toDate: toDateString} = inputData
  const fromDate = new Date(fromDateString)
  const toDate = new Date(toDateString)
  const arxivQueryUrl = getArxivIdsQueryUrl(fromDate, toDate, resumptionToken)

  return arxivQueryUrl
}

export {arxivWorkflowGetQuery, getArxivIdsQueryUrl, MAX_ITEMS_PER_PAGE}
