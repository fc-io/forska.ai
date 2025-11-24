import {Show} from 'solid-js'

type Judgment = {
  id: string
  prompt: {originalText: string}
  answeredOriginal?: string | null
  confidenceOriginal?: number | null
  quotes?: string[]
}

type ReviewArticleDetailsProps = {
  article: {articleTitle: string; articleAuthors?: string[] | null; articleSummary?: string | null; articleId: string}
  judgment?: Judgment
}
import {decodeAndSanitize} from '../../../../../app/utils/decodeAndSanitize'
import {getArticleUrl} from '../../../../../app/utils/getArticleUrl.ts'
import {reviewArticleDetailsGetHighlightedText} from './reviewArticleDetails/reviewArticleDetailsGetHighlightedText.ts'

const getHighlightedText = (text: string, judgment: Judgment) => {
  const sanitizedText = decodeAndSanitize(text)
  const pieces = reviewArticleDetailsGetHighlightedText(
    sanitizedText,
    new Array(...(judgment.quotes || [])).map((quote) => {
      // replace leading ... and trailing ..., should be better stored in the database
      return quote.replace(/^\.{3}|\.{3}$/g, '')
    }),
    {maxDistance: 1, caseInsensitive: true, fuzzyScanLimit: 'auto'},
  )

  const html = pieces
    .map(([text, isHit]) => {
      return isHit ? `<span class="text-red-500 underline">${text}</span>` : text
    })
    .join('')

  // eslint-disable-next-line solid/no-innerhtml
  return <span innerHTML={html} />
}

export const ReviewArticleDetails = (props: ReviewArticleDetailsProps) => {
  return (
    <div class="p-6 bg-white rounded-lg shadow">
      <h1 class="text-2xl font-bold mb-4">Article Details</h1>
      <div class="space-y-2">
        <p class="text-lg font-semibold">
          {props.judgment ? (
            getHighlightedText(props.article.articleTitle, props.judgment)
          ) : (
            // eslint-disable-next-line solid/no-innerhtml
            <span innerHTML={decodeAndSanitize(props.article.articleTitle)} />
          )}
        </p>
        <p class="text-gray-600">
          <a
            href={getArticleUrl(props.article.articleId)}
            target="_blank"
            rel="noopener noreferrer"
            class="text-blue-600 hover:underline"
          >
            {props.article.articleId}
          </a>
        </p>
        <Show when={props.article.articleAuthors}>
          <p class="text-gray-600">Authors: {props.article.articleAuthors?.join(', ')}</p>
        </Show>
        <Show when={props.article.articleSummary}>
          <div class="mt-4">
            <h3 class="font-semibold mb-2">Summary</h3>
            <div class="text-gray-700 assessment-container leading-relaxed">
              {props.judgment && props.article.articleSummary ? (
                getHighlightedText(props.article.articleSummary, props.judgment)
              ) : (
                // eslint-disable-next-line solid/no-innerhtml
                <span innerHTML={decodeAndSanitize(props.article.articleSummary ?? '')} />
              )}
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}
