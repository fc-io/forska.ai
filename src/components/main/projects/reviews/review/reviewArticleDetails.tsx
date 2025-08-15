import {Show} from 'solid-js'

type ReviewArticleDetailsProps = {
  article: {
    articleTitle: string
    articleAuthors?: string[] | null
    articleSummary?: string | null
  }
}

export const ReviewArticleDetails = (props: ReviewArticleDetailsProps) => {
  return (
    <div class="p-6 bg-white rounded-lg shadow">
      <h1 class="text-2xl font-bold mb-4">Article Details</h1>
      <div class="space-y-2">
        <p class="text-lg font-semibold">{props.article.articleTitle}</p>
        <Show when={props.article.articleAuthors}>
          <p class="text-gray-600">
            Authors: {props.article.articleAuthors?.join(', ')}
          </p>
        </Show>
        <Show when={props.article.articleSummary}>
          <div class="mt-4">
            <h3 class="font-semibold mb-2">Summary</h3>
            <p class="text-gray-700">{props.article.articleSummary}</p>
          </div>
        </Show>
      </div>
    </div>
  )
}

