import {Link} from '@tanstack/solid-router'
import {type ColumnDef, createSolidTable, flexRender, getCoreRowModel} from '@tanstack/solid-table'
import {format} from 'date-fns'
import type {Accessor, Setter} from 'solid-js'
import {For, Show} from 'solid-js'

import {getArticleUrl} from '../../../../app/utils/getArticleUrl.ts'
import type {articles, judgmentsHuman} from '../../../../db/schema.ts'
import {getJournalDisplayTitleForArticle} from '../../../../utils/getJournalDisplayTitleForArticle.ts'
import {ReviewsArticlesPdfCell} from './reviewsArticlesPdfCell.tsx'

declare module '@tanstack/solid-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface TableMeta<TData> {
    projectId?: () => string
    rowSelection?: Accessor<Record<string, boolean>>
  }
}

type HumanJudgmentType = typeof judgmentsHuman.$inferSelect

type ArticleWithHumanJudgments = Omit<typeof articles.$inferSelect, 'judgments'> & {judgments: Array<HumanJudgmentType>}

interface ReviewsArticlesHumanTableProps {
  articles: ArticleWithHumanJudgments[]
  projectId: string
  rowSelection: Accessor<Record<string, boolean>>
  setRowSelection: Setter<Record<string, boolean>>
}

const selectionColumn: ColumnDef<ArticleWithHumanJudgments, unknown> = {
  id: 'select',
  header: () => {
    return <span class="sr-only">Select</span>
  },
  size: 15,
  minSize: 15,
  enableSorting: false,
  cell: (info) => {
    const selected = () => {
      const rs = info.table.options.meta?.rowSelection?.()
      return Boolean(rs && rs[info.row.id])
    }
    return (
      <input
        type="checkbox"
        class="w-[15px] h-[15px]"
        checked={selected()}
        onChange={(e) => {
          info.row.toggleSelected(Boolean((e?.currentTarget as HTMLInputElement | undefined)?.checked))
        }}
      />
    )
  },
}

const columns: ColumnDef<ArticleWithHumanJudgments, unknown>[] = [
  selectionColumn,
  {
    accessorKey: 'articleTitle',
    header: 'Title',
    size: 400,
    minSize: 200,
    maxSize: 600,
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
    id: 'journalTitle',
    header: 'Journal',
    size: 300,
    minSize: 160,
    maxSize: 300,
    cell: (info) => {
      const journalTitle = getJournalDisplayTitleForArticle(info.row.original)
      return (
        <Show when={journalTitle} fallback={<span class="text-gray-400">—</span>}>
          {(title) => {
            return (
              <span class="block w-full truncate" title={title()}>
                {title()}
              </span>
            )
          }}
        </Show>
      )
    },
  },
  {
    accessorKey: 'articleCreatedAt',
    header: 'Article Uploaded',
    size: 120,
    minSize: 100,
    cell: (info) => {
      const date = info.getValue() as Date | null
      return date ? format(date, 'yyyy-MM-dd') : 'No date'
    },
  },
  {
    accessorKey: 'articleUpdatedAt',
    header: 'Article Updated',
    size: 120,
    minSize: 100,
    cell: (info) => {
      const date = info.getValue() as Date | null
      return date ? format(date, 'yyyy-MM-dd') : 'No date'
    },
  },
  {
    accessorKey: 'articleId',
    header: 'Article ID',
    size: 180,
    minSize: 120,
    cell: (info) => {
      const articleId = info.getValue() as string
      return (
        <a
          href={getArticleUrl(articleId)}
          target="_blank"
          rel="noopener noreferrer"
          class="text-blue-600 hover:underline block truncate"
          title={articleId}
        >
          {articleId}
        </a>
      )
    },
  },
  {
    accessorKey: 'fullTextPDF',
    header: 'PDF',
    size: 140,
    minSize: 120,
    cell: (info) => {
      return (
        <ReviewsArticlesPdfCell
          fullTextPDF={info.getValue()}
          fullTextFetchedAt={(info.row.original as {fullTextFetchedAt?: unknown}).fullTextFetchedAt}
          fullTextConversionStatus={
            (info.row.original as {fullTextConversionStatus?: unknown}).fullTextConversionStatus
          }
          originalData={(info.row.original as {originalData?: unknown}).originalData}
        />
      )
    },
  },
  {
    accessorKey: 'judgments',
    header: 'Human Judgments',
    size: 100,
    minSize: 100,
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
  const rowSelection = () => {
    return props.rowSelection()
  }
  const table = createSolidTable({
    get data() {
      return props.articles
    },
    columns,
    getCoreRowModel: getCoreRowModel(),
    meta: {projectId, rowSelection},
    enableRowSelection: true,
    enableMultiRowSelection: true,
    getRowId: (row) => {
      return (row as {id: string}).id
    },
    get state() {
      return {rowSelection: props.rowSelection()}
    },
    onRowSelectionChange: (updater) => {
      const current = props.rowSelection()
      const next = typeof updater === 'function' ? (updater as (old: unknown) => unknown)(current) : updater
      props.setRowSelection((next || {}) as Record<string, boolean>)
    },
  })

  return (
    <div class="overflow-x-auto bg-white rounded-lg shadow">
      <table class="min-w-full divide-y divide-gray-200 table-fixed">
        <thead class="bg-gray-50">
          <For each={table.getHeaderGroups()}>
            {(headerGroup) => {
              return (
                <tr>
                  <For each={headerGroup.headers}>
                    {(header) => {
                      return (
                        <th
                          class={
                            header.column.id === 'select'
                              ? 'px-1.5 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider'
                              : 'px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider'
                          }
                          style={{width: `${header.getSize()}px`}}
                        >
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
                        <td
                          class={
                            cell.column.id === 'select'
                              ? 'px-1.5 py-4 text-sm text-gray-900'
                              : cell.column.id === 'articleTitle'
                                ? 'px-6 py-4 text-sm text-gray-900'
                                : 'px-6 py-4 whitespace-nowrap text-sm text-gray-900'
                          }
                          style={{width: `${cell.column.getSize()}px`, 'max-width': `${cell.column.getSize()}px`}}
                        >
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
