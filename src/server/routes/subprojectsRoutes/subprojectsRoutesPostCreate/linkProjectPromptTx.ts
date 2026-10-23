import {getAppDatabaseService} from '../../../services/appDatabaseService.ts'
import * as appQueryHelpers from '../../../services/appQueryHelpers.ts'

type AppTx = Parameters<ReturnType<typeof getAppDatabaseService>['transaction']>[0] extends (
  runner: infer T,
) => Promise<unknown>
  ? T
  : never

export const linkProjectPromptTx = async (tx: AppTx, params: {order: number; projectId: string; promptId: string}) => {
  await tx.run(`
    INSERT INTO app.project_prompt (
      id,
      project_id,
      prompt_id,
      prompt_order,
      archived,
      enabled,
      origin_project_id
    )
    VALUES (
      '${appQueryHelpers.escapeSqlString(crypto.randomUUID())}',
      '${appQueryHelpers.escapeSqlString(params.projectId)}',
      '${appQueryHelpers.escapeSqlString(params.promptId)}',
      ${params.order},
      FALSE,
      TRUE,
      NULL
    )
    ON CONFLICT DO NOTHING
  `)
}
