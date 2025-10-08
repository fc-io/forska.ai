import {type} from 'arktype'
import {format} from 'date-fns'

import type {InputData} from '../arxivWorkflow/arxivWorkflowHarvest.ts'

const IdParams = type({
  searchParams: type({db: 'string', term: 'string', datetype: 'string', mindate: 'string', maxdate: 'string'}),
})

export const pubmedHarvestGetIdParams = (input: InputData): typeof IdParams.infer => {
  const {fromDate, toDate} = input
  const from = format(fromDate, 'yyyy/MM/dd')
  const to = format(toDate, 'yyyy/MM/dd')

  const idParams = IdParams.assert({
    searchParams: {
      db: 'pubmed',
      term: '*', // wildcard – the date filter does the work
      datetype: 'mdat',
      mindate: from, // YYYY/MM/DD
      maxdate: to,
    },
  })

  return idParams
}
