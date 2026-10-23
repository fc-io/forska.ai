import {canonicalFullTextStoredForm, rebuildCanonicalFullText} from '../../fullText/canonicalFullTextStore.ts'
import {HttpError} from '../../utils/httpError.ts'

export const articleAdminRoutesPostCanonicalFullTextRebuild = async ({
  body,
  params,
}: {
  body: {figureMode?: string} | null | undefined
  params: {id: string}
}) => {
  const requestedForm = body?.figureMode ?? canonicalFullTextStoredForm

  if (requestedForm !== canonicalFullTextStoredForm) {
    throw new HttpError(
      400,
      `Canonical full text is always stored with figure markers; figure mode ${requestedForm} is applied when judging. Omit figureMode or send '${canonicalFullTextStoredForm}'.`,
    )
  }

  return rebuildCanonicalFullText({articleId: params.id})
}
