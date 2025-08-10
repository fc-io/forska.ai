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

export type UnassessedArticle = {
  id: string | number
  title?: string
  article_authors?: string | string[]
  source?: string
  created_at?: string
  // normalized/explicit fields requested for display
  article_id?: string | number
  article_title?: string
  article_created?: string
  article_judged_as_ai?: string | null
  article_judged_as_ai_agent?: string | null
  article_judged_as_healthcare?: string | null
  [key: string]: unknown
}

interface UnassessedArticlesTableProps {
  articles: UnassessedArticle[]
}

export const UnassessedArticlesTable = (
  props: UnassessedArticlesTableProps,
): JSX.Element => {
  return (
    <Table>
      <TableCaption>A list of your matched articles.</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead class="w-[160px]">Article Title</TableHead>
          <TableHead>Authors</TableHead>
          <TableHead class="w-[140px]">Article ID</TableHead>
          <TableHead>Source</TableHead>
          <TableHead class="text-right w-[140px]">Created</TableHead>
          <TableHead class="w-[110px]">Judged AI</TableHead>
          <TableHead class="w-[150px]">Judged AI Agent</TableHead>
          <TableHead class="w-[170px]">Judged Healthcare</TableHead>
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
                <TableCell>
                  {String(article.article_id ?? article.id)}
                </TableCell>
                <TableCell>{article.source ?? ''}</TableCell>
                <TableCell class="text-right">
                  <Show
                    when={article.article_created ?? article.created_at}
                    fallback={''}
                  >
                    {(article.article_created ?? article.created_at) as string}
                  </Show>
                </TableCell>
                <TableCell>{article.article_judged_as_ai ?? ''}</TableCell>
                <TableCell>
                  {article.article_judged_as_ai_agent ?? ''}
                </TableCell>
                <TableCell>
                  {article.article_judged_as_healthcare ?? ''}
                </TableCell>
              </TableRow>
            )
          }}
        </For>
      </TableBody>
    </Table>
  )
}
