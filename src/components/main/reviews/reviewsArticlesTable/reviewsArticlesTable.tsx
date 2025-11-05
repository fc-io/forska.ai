import {Link} from '@tanstack/solid-router'
import {type ColumnDef, createSolidTable, flexRender, getCoreRowModel} from '@tanstack/solid-table'
import {format} from 'date-fns'
import {For, Show} from 'solid-js'

import {getArticleUrl} from '../../../../app/utils/getArticleUrl.ts'
import type {articles, judgments} from '../../../../db/schema.ts'

declare module '@tanstack/solid-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface TableMeta<TData> {
    projectId?: () => string
  }
}

type JudgmentType = typeof judgments.$inferSelect

type ArticleWithJudgments = Omit<typeof articles.$inferSelect, 'judgments'> & {
  judgments: Array<JudgmentType>
  // Present for "Assessed by Both" view: per-prompt human answers from all qualifying humans
  humanAnswersByPrompt?: Record<string, string[]>
}

interface ReviewsArticlesTableProps {
  articles: ArticleWithJudgments[]
  projectId: string
}

const columns: ColumnDef<ArticleWithJudgments, unknown>[] = [
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
    size: 120,
    minSize: 120,
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
    accessorKey: 'fullTextPDF',
    header: 'PDF',
    size: 40,
    minSize: 40,
    cell: (info) => {
      const pdf = (info.getValue() as string | null) || ''
      const fetched = Boolean((info.row.original as {fullTextFetchedAt?: unknown}).fullTextFetchedAt)
      return pdf
        ? (
            <a
              href={pdf.startsWith('/') ? pdf : `/${pdf}`}
              target="_blank"
              rel="noopener noreferrer"
              class="px-1.5 py-0.5 text-xs rounded bg-green-100 text-green-800"
              title="Open PDF"
            >
              PDF
            </a>
          )
        : fetched
          ? (
              <span class="px-1.5 py-0.5 text-xs rounded bg-yellow-100 text-yellow-800" title="Fetched, no PDF available">
                No PDF
              </span>
            )
          : (
              <span class="text-gray-400">—</span>
            )
    },
  },
  {
    accessorKey: 'judgments',
    header: 'Judgments',
    size: 160,
    minSize: 140,
    cell: (info) => {
      const judgmentsData = info.getValue() as JudgmentType[]
      const row = info.row.original as ArticleWithJudgments

      const norm = (s?: string | null) => {
        return (s ?? '').toString().trim().toLowerCase()
      }

      const labelFor = (s?: string | null) => {
        const n = norm(s)
        if (!n) return '—'
        if (n === 'yes') return 'Y'
        if (n === 'no') return 'N'
        if (n === 'unsure') return 'U'
        return n.slice(0, 1).toUpperCase()
      }

      return (
        <div class="flex items-center gap-2">
          <span class="text-sm text-gray-600">{judgmentsData?.length || 0}</span>
          <Show when={judgmentsData && judgmentsData.length > 0}>
            <div class="flex gap-1">
              <For each={judgmentsData.slice(0, 3)}>
                {(judgment) => {
                  const llmAns = norm(judgment.answeredOriginal)
                  const humanAnswers = (row.humanAnswersByPrompt?.[judgment.promptId] ?? []).map(norm)

                  let cls = 'bg-gray-100 text-gray-800'
                  if (humanAnswers.length > 0 && llmAns) {
                    const matches = humanAnswers.filter((a) => {
                      return a === llmAns
                    }).length
                    if (matches === humanAnswers.length) {
                      cls = 'bg-green-100 text-green-800'
                    } else if (matches > 0) {
                      cls = 'bg-yellow-100 text-yellow-800'
                    } else {
                      cls = 'bg-red-100 text-red-800'
                    }
                  }

                  const tooltip = (() => {
                    const llmText = judgment.answeredOriginal ?? '—'
                    const humans = row.humanAnswersByPrompt?.[judgment.promptId]
                    const humanText = humans && humans.length > 0 ? humans.join(', ') : '—'
                    return `LLM: ${llmText} • Human(s): ${humanText}`
                  })()

                  return (
                    <span class={`px-1.5 py-0.5 text-xs rounded ${cls}`} title={tooltip}>
                      {labelFor(judgment.answeredOriginal)}
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

export const ReviewsArticlesTable = (props: ReviewsArticlesTableProps) => {
  const projectId = () => {
    return props.projectId
  }
  const table = createSolidTable({
    get data() {
      return props.articles
    },
    columns,
    getCoreRowModel: getCoreRowModel(),
    meta: {
      projectId,
      // formatMoney,    // function
    },
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
                        <th
                          class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                          style={{ width: `${header.getSize()}px` }}
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
                            cell.column.id === 'articleTitle'
                              ? 'px-6 py-4 text-sm text-gray-900'
                              : 'px-6 py-4 whitespace-nowrap text-sm text-gray-900'
                          }
                          style={{ width: `${cell.column.getSize()}px` }}
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
