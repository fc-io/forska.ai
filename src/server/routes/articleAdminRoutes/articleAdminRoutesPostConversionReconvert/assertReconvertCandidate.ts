import {HttpError} from '../../../utils/httpError.ts'

export type ReconvertCandidate = {
  id: string
  fullTextPDF: string | null
  fullTextConversionError: string | null
  fullTextConversionStatus: string | null
  hasConvertedText: boolean
  hasFullText: boolean
}

/**
 * An article with a PDF is reconvertible when it has no full text, its conversion failed, or a conversion error is
 * recorded. The last case covers failures stored before failed was a status (status NULL, error set, no text).
 */
const isReconvertible = (article: ReconvertCandidate): boolean => {
  return (
    !article.hasFullText
    || article.fullTextConversionStatus === 'failed'
    || (article.fullTextConversionError ?? '').trim() !== ''
  )
}

export const assertReconvertCandidate = (
  articleId: string,
  article: ReconvertCandidate | undefined,
): ReconvertCandidate => {
  if (!article) {
    throw new HttpError(404, `Article ${articleId} not found`)
  }

  if (!article.fullTextPDF) {
    throw new HttpError(409, `Article ${articleId} has no PDF; fetch or upload one before reconverting`)
  }

  if (!isReconvertible(article)) {
    throw new HttpError(
      409,
      `Article ${articleId} has converted full text (conversion ${article.fullTextConversionStatus ?? 'not started'}) and no recorded conversion error; only articles without full text, with a failed conversion or with a recorded conversion error can be reconverted`,
    )
  }

  return article
}
