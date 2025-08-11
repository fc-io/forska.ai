import {format} from 'date-fns'
import type {JSX} from 'solid-js'
import {For} from 'solid-js'

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../ui/table.tsx'
import {ArticleRows} from '../articlesTable.tsx'

export const ArticlesTableArticlesTable = (props: {
  articles: typeof ArticleRows.infer
}): JSX.Element => {
  return (
    <Table>
      <TableCaption>A list of your matched articles.</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead class="w-[140px]">Article ID</TableHead>
          <TableHead class="w-[160px]">Article Title</TableHead>
          <TableHead>Authors</TableHead>
          <TableHead class="text-right w-[140px]">Article Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <For each={props.articles}>
          {(article): JSX.Element => {
            const {article_authors, article_created} = article

            return (
              <TableRow>
                <TableCell>{article.article_id}</TableCell>
                <TableCell class="font-medium">
                  {article.article_title}
                </TableCell>
                <TableCell>{article_authors}</TableCell>
                <TableCell class="text-right">
                  {format(article_created, 'yyyy-MM-dd')}
                </TableCell>
              </TableRow>
            )
          }}
        </For>
      </TableBody>
    </Table>
  )
}
