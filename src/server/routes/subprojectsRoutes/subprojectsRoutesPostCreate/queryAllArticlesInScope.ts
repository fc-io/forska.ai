import {getAppDatabaseService} from '../../../services/appDatabaseService.ts'

export const queryAllArticlesInScope = async (combinedWhereClause: string | null) => {
  const appDatabaseService = getAppDatabaseService()
  return appDatabaseService.queryJson<{id: string}>(`
    SELECT a.id AS id
    FROM app.article a
    ${combinedWhereClause ? `WHERE ${combinedWhereClause}` : ''}
  `)
}
