import {format} from 'date-fns'
import {For, Show} from 'solid-js'

import type {articles, judgments} from '../../../../db/schema.ts'
import {getArticleUrl} from '../../../app/utils/getArticleUrl.ts'

type ArticleWithJudgments = typeof articles.$inferSelect & {
  judgments: Array<typeof judgments.$inferSelect>
}

interface ReviewsArticleCardProps {
  article: ArticleWithJudgments
}

export const ReviewsArticleCard = (props: ReviewsArticleCardProps) => {
  return (
    <div class="p-4 bg-white rounded-lg shadow hover:shadow-md transition-shadow">
      <div class="mb-2">
        <h4 class="font-semibold text-lg">{props.article.articleTitle}</h4>
        <p class="text-sm text-gray-600">
          {props.article.articleCreatedAt
            ? format(props.article.articleCreatedAt, 'yyyy-MM-dd')
            : 'No date provided'}
        </p>
        <a
          href={getArticleUrl(props.article.articleId)}
          target="_blank"
          rel="noopener noreferrer"
          class="text-blue-600 hover:underline"
        >
          {props.article.articleId}
        </a>
      </div>

      <div class="flex gap-4 text-sm">
        <Show when={props.article.doi}>
          <a
            href={`https://doi.org/${props.article.doi}`}
            target="_blank"
            rel="noopener noreferrer"
            class="text-blue-600 hover:underline"
          >
            DOI: {props.article.doi}
          </a>
        </Show>

        <Show when={props.article.pubmedId}>
          <a
            href={`https://pubmed.ncbi.nlm.nih.gov/${props.article.pubmedId}`}
            target="_blank"
            rel="noopener noreferrer"
            class="text-blue-600 hover:underline"
          >
            PMID: {props.article.pubmedId}
          </a>
        </Show>
      </div>

      <div class="mt-3 pt-3 border-t">
        <p class="text-sm text-gray-600">
          Judgments: {props.article.judgments?.length || 0}
        </p>
        <Show
          when={props.article.judgments && props.article.judgments.length > 0}
        >
          <div class="mt-2 flex flex-wrap gap-2">
            <For each={props.article.judgments}>
              {(judgment) => {
                return (
                  <span
                    class={`px-2 py-1 text-xs rounded ${
                      judgment.answeredOriginal
                        ? 'bg-green-100 text-green-800'
                        : 'bg-red-100 text-red-800'
                    }`}
                  >
                    {judgment.answeredOriginal ? 'Original' : 'Not Original'}
                  </span>
                )
              }}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}
