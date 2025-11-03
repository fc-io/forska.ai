import {Link} from '@tanstack/solid-router'
import {type ColumnDef, createSolidTable, flexRender, getCoreRowModel} from '@tanstack/solid-table'
import {format} from 'date-fns'
import {For, Show} from 'solid-js'

import {getArticleUrl} from '../../../../app/utils/getArticleUrl.ts'
import type {articles, judgmentsHuman} from '../../../../db/schema.ts'

declare module '@tanstack/solid-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface TableMeta<TData> {
    projectId?: () => string
  }
}

type HumanJudgmentType = typeof judgmentsHuman.$inferSelect

type ArticleWithHumanJudgments = Omit<typeof articles.$inferSelect, 'judgments'> & {judgments: Array<HumanJudgmentType>}

interface ReviewsArticlesHumanTableProps {
  articles: ArticleWithHumanJudgments[]
  projectId: string
}

const columns: ColumnDef<ArticleWithHumanJudgments, unknown>[] = [
  {
    accessorKey: 'articleTitle',
    header: 'Title',
    cell: (info) => {
      return (
        <Link
          to="/projects/$id/reviews-llm/$articleId"
          params={{id: info.table.options.meta?.projectId?.() || '', articleId: info.row.original.id}}
          class="text-blue-600 hover:underline"
        >
          {(info.getValue() as string) || 'Untitled'}
        </Link>
      )
    },
  },
  {
    accessorKey: 'articleCreatedAt',
    header: 'Article Uploaded',
    cell: (info) => {
      const date = info.getValue() as Date | null
      return date ? format(date, 'yyyy-MM-dd') : 'No date'
    },
  },
  {
    accessorKey: 'articleUpdatedAt',
    header: 'Article Updated',
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
    accessorKey: 'judgments',
    header: 'Human Judgments',
    cell: (info) => {
      const judgmentsData = info.getValue() as HumanJudgmentType[]
      return (
        <div class="flex items-center gap-2">
          <span class="text-sm text-gray-600">{judgmentsData?.length || 0}</span>
          <Show when={judgmentsData && judgmentsData.length > 0}>
            <div class="flex gap-1">
              <For each={judgmentsData.slice(0, 3)}>
                {(judgment) => {
                  const label = (judgment.answer || '').trim() || '—'
                  return (
                    <span
                      class="px-1.5 py-0.5 text-xs rounded bg-gray-100 text-gray-800 max-w-28 truncate"
                      title={label}
                    >
                      {label}
                    </span>
                  )
                }}
              </For>
              <Show when={judgmentsData.length > 3}>
                <span class="text-xs text-gray-500">+{judgmentsData.length - 3}</span>
              </Show>
            </div>
          </Show>
        </div>
      )
    },
  },
]

export const ReviewsArticlesHumanTable = (props: ReviewsArticlesHumanTableProps) => {
  const projectId = () => {
    return props.projectId
  }
  const table = createSolidTable({
    get data() {
      return props.articles
    },
    columns,
    getCoreRowModel: getCoreRowModel(),
    meta: {projectId},
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
                            : flexRender(header.column.columnDef.header, header.getContext())}
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
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
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
