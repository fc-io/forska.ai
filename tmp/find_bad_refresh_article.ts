import {getProjectMartRefreshStateService} from '../src/server/services/projectMartRefreshStateService.ts'
import {getDuckdbMartRefreshService} from '../src/server/services/getDuckdbMartRefreshService.ts'

const projectId = process.argv[2]
if (!projectId) throw new Error('project id arg required')

const svc = getProjectMartRefreshStateService()
const projectRows = await svc.getDirtyArticlesForClaim({
  projectId,
  claimedToken: 999999,
  lastCompletedToken: 0,
})
console.log('articleCount', projectRows.length)
for (const [index, row] of projectRows.entries()) {
  try {
    await getDuckdbMartRefreshService().refreshJudgmentArticle(row.articleId)
    console.log('ok', index + 1, row.articleId)
  } catch (error) {
    console.log('failed', index + 1, row.articleId, error instanceof Error ? error.message : String(error))
    break
  }
}
