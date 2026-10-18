import {HttpError} from '../../utils/httpError.ts'
import {rejectLegacyFullTextNoImagesBody} from '../../utils/rejectLegacyFullTextNoImagesBody.ts'

const projectPatchFields = new Set(['description', 'name'])

export const getProjectPatchSettingsBodyErrorMessage = (fields: string[]): string => {
  return `PATCH /api/projects/:id updates only name and description; it does not accept ${fields.join(', ')}. Send project settings (model, content flags, full text, fullTextFigureMode, fullTextChunkPolicy, recordCurrentFullTextStrategy, prompts, import routes, dates) to PATCH /api/projects/:id/edit.`
}

const getUnsupportedFields = (body: unknown): string[] => {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? Object.keys(body)
        .filter((field) => {
          return !projectPatchFields.has(field)
        })
        .sort()
    : []
}

/**
 * Runs before body validation, which would strip unknown fields and answer 200 as if they had been saved.
 * The legacy useFulltextNoImages message keeps precedence.
 */
export const rejectProjectPatchSettingsBody = ({body}: {body: unknown}): void => {
  rejectLegacyFullTextNoImagesBody({body})

  const unsupportedFields = getUnsupportedFields(body)

  if (unsupportedFields.length > 0) {
    throw new HttpError(400, getProjectPatchSettingsBodyErrorMessage(unsupportedFields))
  }
}
