import {format} from 'date-fns'
import type {JSX} from 'solid-js'
import {For, Show} from 'solid-js'

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../ui/table.tsx'

export const UnassessedArticlesTable = (props: any): JSX.Element => {
  return (
    <Table>
      <TableCaption>A list of your matched articles.</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead class="w-[160px]">Article Title</TableHead>
          <TableHead>Authors</TableHead>
          <TableHead class="w-[140px]">Article ID</TableHead>
          <TableHead class="text-right w-[140px]">Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <For each={props.articles}>
          {(article): JSX.Element => {
            // Normalize authors from several possible known keys without using any
            const pickAuthors = (a: unknown): string | string[] | undefined => {
              if (Array.isArray(a)) return a as string[]
              if (typeof a === 'string') return a
              return undefined
            }
            const record = article as Record<string, unknown>
            const authorsValue =
              pickAuthors(article.authors)
              ?? pickAuthors(record.author)
              ?? pickAuthors(record.creator)
              ?? pickAuthors(record.authors_list)
            const authors = Array.isArray(authorsValue)
              ? authorsValue.join(', ')
              : (authorsValue ?? '')
            return (
              <TableRow>
                <TableCell class="font-medium">
                  {article.article_title ?? article.title ?? String(article.id)}
                </TableCell>
                <TableCell>{authors}</TableCell>
                <TableCell>{article.article_id}</TableCell>
                <TableCell class="text-right">
                  {format(article.created_at, 'yyyy-MM-dd HH:mm')}
                </TableCell>
              </TableRow>
            )
          }}
        </For>
      </TableBody>
    </Table>
  )
}
