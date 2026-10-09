import {type} from 'arktype'

import type {InputData} from '../arxivWorkflow/arxivWorkflowHarvest.ts'

const IdParams = type({
  searchParams: type({db: 'string', term: 'string', datetype: 'string', mindate: 'string', maxdate: 'string'}),
})

const toSlashDate = (isoDate: string) => {
  return isoDate.replaceAll('-', '/')
}

export const pubmedHarvestGetIdParams = (input: InputData): typeof IdParams.infer => {
  const {fromDate, toDate} = input

  const idParams = IdParams.assert({
    searchParams: {
      db: 'pubmed',
      term: '*', // wildcard – the date filter does the work
      datetype: 'mdat',
      mindate: toSlashDate(fromDate), // YYYY/MM/DD
      maxdate: toSlashDate(toDate),
    },
  })

  return idParams
}
