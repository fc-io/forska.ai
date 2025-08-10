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
          <TableHead class="text-right w-[140px]">Created</TableHead>
          <TableHead class="w-[110px]">Judged AI</TableHead>
          <TableHead class="w-[150px]">Judged AI Agent</TableHead>
          <TableHead class="w-[170px]">Judged Healthcare</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <For each={props.articles}>
          {(article): JSX.Element => {
            const {
              article_authors,
              article_created,
              article_judged_as_ai,
              article_judged_as_ai_agent,
              article_judged_as_healthcare,
            } = article

            return (
              <TableRow>
                <TableCell>{article.article_id}</TableCell>
                <TableCell class="font-medium">
                  {article.article_title}
                </TableCell>
                <TableCell>{article_authors}</TableCell>
                <TableCell class="text-right">{article_created}</TableCell>
                <TableCell>{article_judged_as_ai}</TableCell>
                <TableCell>{article_judged_as_ai_agent}</TableCell>
                <TableCell>{article_judged_as_healthcare}</TableCell>
              </TableRow>
            )
          }}
        </For>
      </TableBody>
    </Table>
  )
}
