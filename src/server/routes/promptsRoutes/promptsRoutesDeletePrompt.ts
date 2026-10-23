import type {Context} from 'elysia'

import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString} from '../../services/appQueryHelpers.ts'
import {getPromptReferenceCounts, hasPromptReferences} from './promptsRoutesDeletePrompt/promptReferenceCounts.ts'

export const promptsRoutesDeletePrompt = async ({params, set}: {params: {id: string}; set: Context['set']}) => {
  const {id} = params

  const referenceCounts = await getPromptReferenceCounts(id)

  if (hasPromptReferences(referenceCounts)) {
    set.status = 409
    return {
      data: null,
      error: 'Prompt delete blocked. Remove project, comparison project, and judgment references first.',
    }
  }

  await getAppDatabaseService().run(`
      DELETE FROM app.prompt
      WHERE id = '${escapeSqlString(id)}'
    `)

  return {success: true}
}
