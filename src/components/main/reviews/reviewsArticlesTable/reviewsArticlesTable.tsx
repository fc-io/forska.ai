import {
  type ColumnDef,
  createSolidTable,
  flexRender,
  getCoreRowModel,
} from '@tanstack/solid-table'
import {format} from 'date-fns'
import {For, Show} from 'solid-js'

import type {articles, judgments} from '../../../../../db/schema.ts'
import {getArticleUrl} from '../../../../app/utils/getArticleUrl.ts'

type JudgmentType = typeof judgments.$inferSelect

type ArticleWithJudgments = Omit<typeof articles.$inferSelect, 'judgments'> & {
  judgments: Array<JudgmentType>
}

interface ReviewsArticlesTableProps {
  articles: ArticleWithJudgments[]
}

const columns: ColumnDef<ArticleWithJudgments>[] = [
  {
    accessorKey: 'articleTitle',
    header: 'Title',
    cell: (info) => {
      return info.getValue() || 'Untitled'
    },
  },
  {
    accessorKey: 'articleCreatedAt',
    header: 'Date',
    cell: (info) => {
      const date = info.getValue() as Date | null
      return date ? format(date, 'yyyy-MM-dd') : 'No date'
    },
  },
  {
    accessorKey: 'articleId',
    header: 'Article ID',
    cell: (info) => {
      const articleId = info.getValue() as string
      return (
        <a
          href={getArticleUrl(articleId)}
          target="_blank"
          rel="noopener noreferrer"
          class="text-blue-600 hover:underline"
        >
          {articleId}
        </a>
      )
    },
  },
  {
    accessorKey: 'doi',
    header: 'DOI',
    cell: (info) => {
      const doi = info.getValue() as string | null
      return (
        <Show when={doi} fallback="-">
          <a
            href={`https://doi.org/${doi}`}
            target="_blank"
            rel="noopener noreferrer"
            class="text-blue-600 hover:underline"
          >
            {doi}
          </a>
        </Show>
      )
    },
  },
  {
    accessorKey: 'pubmedId',
    header: 'PMID',
    cell: (info) => {
      const pubmedId = info.getValue() as string | null
      return (
        <Show when={pubmedId} fallback="-">
          <a
            href={`https://pubmed.ncbi.nlm.nih.gov/${pubmedId}`}
            target="_blank"
            rel="noopener noreferrer"
            class="text-blue-600 hover:underline"
          >
            {pubmedId}
          </a>
        </Show>
      )
    },
  },
  {
    accessorKey: 'judgments',
    header: 'Judgments',
    cell: (info) => {
      const judgementsData = info.getValue() as JudgmentType[]
      return (
        <div class="flex items-center gap-2">
          <span class="text-sm text-gray-600">
            {judgementsData?.length || 0}
          </span>
          <Show when={judgementsData && judgementsData.length > 0}>
            <div class="flex gap-1">
              <For each={judgementsData.slice(0, 3)}>
                {(judgment) => {
                  return (
                    <span
                      class={`px-1.5 py-0.5 text-xs rounded ${
                        judgment.answeredOriginal
                          ? 'bg-green-100 text-green-800'
                          : 'bg-red-100 text-red-800'
                      }`}
                      title={
                        judgment.answeredOriginal ? 'Original' : 'Not Original'
                      }
                    >
                      {judgment.answeredOriginal ? 'O' : 'N'}
                    </span>
                  )
                }}
              </For>
              <Show when={judgementsData.length > 3}>
                <span class="text-xs text-gray-500">
                  +{judgementsData.length - 3}
                </span>
              </Show>
            </div>
          </Show>
        </div>
      )
    },
  },
]

export const ReviewsArticlesTable = (props: ReviewsArticlesTableProps) => {
  const table = createSolidTable({
    get data() {
      return props.articles
    },
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  return (
    <div class="overflow-x-auto bg-white rounded-lg shadow">
      <table class="min-w-full divide-y divide-gray-200">
        <thead class="bg-gray-50">
          <For each={table.getHeaderGroups()}>
            {(headerGroup) => {
              return (
                <tr>
                  <For each={headerGroup.headers}>
                    {(header) => {
                      return (
                        <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          {header.isPlaceholder
                            ? null
                            : flexRender(
                                header.column.columnDef.header,
                                header.getContext(),
                              )}
                        </th>
                      )
                    }}
                  </For>
                </tr>
              )
            }}
          </For>
        </thead>
        <tbody class="bg-white divide-y divide-gray-200">
          <For each={table.getRowModel().rows}>
            {(row) => {
              return (
                <tr class="hover:bg-gray-50">
                  <For each={row.getVisibleCells()}>
                    {(cell) => {
                      return (
                        <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext(),
                          )}
                        </td>
                      )
                    }}
                  </For>
                </tr>
              )
            }}
          </For>
        </tbody>
      </table>
      <Show when={props.articles.length === 0}>
        <div class="p-8 text-center text-gray-500">No articles to display</div>
      </Show>
    </div>
  )
}
