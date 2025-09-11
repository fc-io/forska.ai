// import {getNewestArticles} from '../../../agent/getNewestArticles.ts'
import {judge} from '../../../agent/judge.ts'
import {getNewestArticlesToJudge} from './projectsGridGetNewestArticlesToJudge.ts'
// import {runAgentHarvest} from './agent_harvest.ts'

const runJudge = async ({
  numberOfArticlesToGet = 100,
  projectId,
  sessionId,
}: {
  numberOfArticlesToGet: number
  projectId: string
  sessionId: string
}) => {
  console.log('start runJudge', projectId, numberOfArticlesToGet)
  //   if (fromDate) {
  //     console.log('fromDate:', fromDate.toISOString())
  //   }
  //   if (toDate) {
  //     console.log('toDate:', toDate.toISOString())
  //   }
  // const sessionId = crypto.randomUUID()
  // debugger
  while (true) {
    const newestArticlesToJudge = await getNewestArticlesToJudge({projectId, numberOfArticlesToGet})

    if (newestArticlesToJudge.articles.length === 0) {
      break
    }

    await judge({articles: newestArticlesToJudge.articles, prompts: newestArticlesToJudge.prompts, sessionId})
    console.log(
      'judged',
      newestArticlesToJudge.articles.length,
      'articles, with ',
      newestArticlesToJudge.prompts.length,
      'prompts',
    )
  }

  console.log('end workflow')
}

export {runJudge}
