import {HttpError} from './httpError.ts'

export const legacyFullTextNoImagesBodyErrorMessage =
  'useFulltextNoImages is a frozen legacy setting and can no longer be sent. Remove it from the request: projects choose full text with useFulltext, fullTextFigureMode and fullTextChunkPolicy, and existing projects and comparisons keep their stored value.'

const hasLegacyFullTextNoImagesField = (body: unknown) => {
  return typeof body === 'object' && body !== null && Object.hasOwn(body, 'useFulltextNoImages')
}

export const rejectLegacyFullTextNoImagesBody = ({body}: {body: unknown}) => {
  if (hasLegacyFullTextNoImagesField(body)) {
    throw new HttpError(400, legacyFullTextNoImagesBodyErrorMessage)
  }
}
