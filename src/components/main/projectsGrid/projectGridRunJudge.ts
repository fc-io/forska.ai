import {type} from 'arktype'

// import {getNewestArticles} from '../../../agent/getNewestArticles.ts'
import {judge} from '../../../agent/judge.ts'
import {getNewestArticlesToJudge} from './projectsGridGetArticlesToJudge'
// import {runAgentHarvest} from './agent_harvest.ts'

const runJudge = async ({
  numberOfArticlesToGet = 100,
  projectId,
}: {
  numberOfArticlesToGet: number
  projectId: string
}) => {
  console.log('start runJudge', projectId, numberOfArticlesToGet)
  //   if (fromDate) {
  //     console.log('fromDate:', fromDate.toISOString())
  //   }
  //   if (toDate) {
  //     console.log('toDate:', toDate.toISOString())
  //   }
  const sessionId = crypto.randomUUID()
  // debugger
  while (true) {
    const newestArticles = await getNewestArticlesToJudge({
      projectId,
      numberOfArticlesToGet,
    })
    // debugger
    if (newestArticles.length === 0) {
      break
    }

    await judge({articles: newestArticles, sessionId})
    console.log('judged', newestArticles.length, 'articles')
  }

  console.log('end workflow')
}

export {runJudge}
