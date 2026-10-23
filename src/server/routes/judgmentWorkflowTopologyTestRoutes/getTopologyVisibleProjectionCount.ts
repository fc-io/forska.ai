import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getFixtureIds} from './getFixtureIds.ts'

export const getTopologyVisibleProjectionCount = async (fixtureId: string) => {
  const ids = getFixtureIds(fixtureId)
  const projectList = ids.projectIds.map(getSqlLiteral).join(', ')
  const [projection] = await getAppDatabaseService().queryJson<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT DISTINCT
        project_id,
        review_config_hash,
        payload_kind,
        article_id,
        prompt_id
      FROM mart.review_article_judgment_detail_serving_v4
      WHERE project_id IN (${projectList})
        AND payload_kind = 'llm'
    ) projection
  `)

  return Number(projection?.count ?? 0)
}
