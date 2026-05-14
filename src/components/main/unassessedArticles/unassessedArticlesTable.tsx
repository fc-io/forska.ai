import {format} from 'date-fns'
import type {JSX} from 'solid-js'
import {For, Show} from 'solid-js'

import {formatAuthors} from '../../../app/utils/formatAuthors.ts'
import {getArticleUrl} from '../../../app/utils/getArticleUrl.ts'
import {apiClient} from '../../../services/apiClient.ts'
import {Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow} from '../../ui/table.tsx'

type ArticlesResponse = Awaited<ReturnType<typeof apiClient.api.articles.latest.get>>
type Article = NonNullable<ArticlesResponse['data']>['data'][number]

export const UnassessedArticlesTable = (props: {articles: Article[]}): JSX.Element => {
  return (
    <Table>
      <TableCaption>A list of your matched articles.</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead class="w-[140px]">Article ID</TableHead>
          <TableHead>Article Title</TableHead>
          <TableHead class="w-[160px]">Authors</TableHead>
          <TableHead class="text-right w-[140px]">Article Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <For each={props.articles}>
          {(article): JSX.Element => {
            const {articleId, articleTitle, articleAuthors, articleCreatedAt} = article
            const createdAt = articleCreatedAt ? format(articleCreatedAt, 'yyyy-MM-dd') : ''
            const url = getArticleUrl(article)

            return (
              <TableRow>
                <TableCell>
                  <Show when={url} fallback={articleId}>
                    <a href={url} target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline">
                      {articleId}
                    </a>
                  </Show>
                </TableCell>
                <TableCell class="font-medium">{articleTitle}</TableCell>
                <TableCell>{formatAuthors(articleAuthors)}</TableCell>
                <TableCell class="text-right">{createdAt}</TableCell>
              </TableRow>
            )
          }}
        </For>
      </TableBody>
    </Table>
  )
}
