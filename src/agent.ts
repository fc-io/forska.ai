import {type} from 'arktype'

import {getNewestArticles} from './agent/getNewestArticles.ts'
import {judge} from './agent/judge.ts'
// import {runAgentHarvest} from './agent_harvest.ts'

const inputData = type({searchTerm: 'string', fromDate: 'string.date', toDate: 'string.date', maxResults: 'number'})

type InputData = typeof inputData.infer

const run = async (numberOfArticlesToGet = 100, fromDate?: Date, toDate?: Date) => {
  console.log('start workflow', 'import.meta.env.DEV', import.meta.env.DEV, numberOfArticlesToGet)
  if (fromDate) {
    console.log('fromDate:', fromDate.toISOString())
  }
  if (toDate) {
    console.log('toDate:', toDate.toISOString())
  }
  const sessionId = crypto.randomUUID()
  // debugger
  while (true) {
    const newestArticles = await getNewestArticles({numberOfArticlesToGet})

    if (newestArticles.length === 0) {
      break
    }

    await judge({articles: newestArticles, sessionId})
    console.log('judged', newestArticles.length, 'articles')
  }

  console.log('end workflow')
}

export {type InputData, inputData, run}
