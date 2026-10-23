import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import type {PromptRow} from './promptRow.ts'
import {
  applyHashUpdates,
  getCollisions,
  groupCollisions,
  safeUpdates,
  withHashes,
} from './promptsRoutesPostRegenerateHashes/promptHashUpdates.ts'

export const promptsRoutesPostRegenerateHashes = async () => {
  const promptRows = await getAppDatabaseService().queryJson<PromptRow>(`
      SELECT
        id,
        original_text AS originalText,
        transformed_text AS transformedText,
        prompt_heading AS promptHeading,
        type
      FROM app.prompt
    `)

  const hashed = withHashes(promptRows)
  const groups = groupCollisions(hashed)
  const collisions = getCollisions(groups)
  const updates = safeUpdates(hashed, collisions)
  const updatedCount = await applyHashUpdates(updates)

  return {success: true, data: {updatedCount, skippedCollisions: collisions}}
}
