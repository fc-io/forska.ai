import {Show} from 'solid-js'

import {type ArticleMetadataLine, getArticleMetadataLinesText} from '../../../../../../utils/articleMetadataText.ts'

const escapeHtmlText = (text: string) => {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export const reviewArticleDetailsGetArticleMetadataHtml = (lines: readonly ArticleMetadataLine[]) => {
  return escapeHtmlText(getArticleMetadataLinesText(lines))
}

export const ReviewArticleDetailsArticleMetadata = (props: {
  containerRef: (element: HTMLDivElement) => void
  heading: string
  html: string
  onClick: (event: MouseEvent) => void
}) => {
  return (
    <div class="text-sm text-gray-600" data-testid="review-article-metadata">
      <p class="font-medium text-gray-700">{props.heading}</p>
      <Show when={props.html !== ''} fallback={<p>none available</p>}>
        <div
          ref={(element) => {
            props.containerRef(element)
          }}
          class="whitespace-pre-line break-words"
          onClick={(event) => {
            props.onClick(event)
          }}
          // eslint-disable-next-line solid/no-innerhtml
          innerHTML={props.html}
        />
      </Show>
    </div>
  )
}
