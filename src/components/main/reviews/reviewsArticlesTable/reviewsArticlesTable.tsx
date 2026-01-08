import {Link} from '@tanstack/solid-router'
import {type ColumnDef, createSolidTable, flexRender, getCoreRowModel} from '@tanstack/solid-table'
import {format} from 'date-fns'
import type {Accessor, Setter} from 'solid-js'
import {For, Show} from 'solid-js'

import {getArticleUrl} from '../../../../app/utils/getArticleUrl.ts'
import type {judgments} from '../../../../db/schema.ts'
import {getJournalTitleFromOriginalData} from '../../../../utils/getJournalTitleFromOriginalData.ts'
import {ReviewsArticlesPdfCell} from './reviewsArticlesPdfCell.tsx'

declare module '@tanstack/solid-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface TableMeta<TData> {
    projectId?: () => string
    rowSelection?: Accessor<Record<string, boolean>>
  }
}

type JudgmentType = typeof judgments.$inferSelect

// Minimal article data required for the reviews table
// This supports both the full article schema and the denormalized API response
type ArticleWithJudgments = {
  id: string
  articleTitle: string | null
  articleCreatedAt: Date | null
  articleUpdatedAt: Date | null
  judgments: Array<JudgmentType>
  journalTitle?: string | null
  // Optional fields from full article schema
  url?: string | null
  fullTextPDF?: string | null
  fullTextFetchedAt?: Date | null
  originalData?: unknown
  // Present for "Assessed by Both" view: per-prompt human answers from all qualifying humans
  humanAnswersByPrompt?: Record<string, string[]>
  // Judged status (from new API response)
  judgedPromptIds?: string[]
  isFullyJudged?: boolean
}

interface ReviewsArticlesTableProps {
  articles: ArticleWithJudgments[]
  projectId: string
  rowSelection: Accessor<Record<string, boolean>>
  setRowSelection: Setter<Record<string, boolean>>
}

const selectionColumn: ColumnDef<ArticleWithJudgments, unknown> = {
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

const getJournalTitleForArticle = (article: {journalTitle?: unknown; originalData?: unknown}) => {
  const fromField = typeof article.journalTitle === 'string' ? article.journalTitle.trim() : null
  return fromField ? fromField : getJournalTitleFromOriginalData(article.originalData)
}

const columns: ColumnDef<ArticleWithJudgments, unknown>[] = [
  selectionColumn,
  {
    id: 'status',
    header: 'Status',
    size: 80,
    minSize: 60,
    cell: (info) => {
      const isFullyJudged = info.row.original.isFullyJudged
      const judgedCount = info.row.original.judgedPromptIds?.length ?? 0
      const totalJudgments = info.row.original.judgments?.length ?? 0

      return (
        <Show when={isFullyJudged !== undefined} fallback={<span class="text-gray-400">—</span>}>
          <Show
            when={isFullyJudged}
            fallback={
              <span
                class="px-1.5 py-0.5 text-xs rounded bg-yellow-100 text-yellow-800"
                title={`${judgedCount} prompt(s) judged, ${totalJudgments} judgment(s)`}
              >
                Partial
              </span>
            }
          >
            <span class="px-1.5 py-0.5 text-xs rounded bg-green-100 text-green-800" title="All prompts judged">
              Complete
            </span>
          </Show>
        </Show>
      )
    },
  },
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
    size: 240,
    minSize: 160,
    maxSize: 360,
    cell: (info) => {
      const journalTitle = getJournalTitleForArticle(info.row.original)
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
    size: 140,
    minSize: 120,
    cell: (info) => {
      return (
        <ReviewsArticlesPdfCell
          fullTextPDF={info.getValue()}
          fullTextFetchedAt={(info.row.original as {fullTextFetchedAt?: unknown}).fullTextFetchedAt}
          originalData={(info.row.original as {originalData?: unknown}).originalData}
        />
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
      const row = info.row.original

      const norm = (s?: string | null) => {
        return (s ?? '').toString().trim().toLowerCase()
      }

      const labelFor = (s?: string | null, asArray?: string[] | null) => {
        // If we have an array representation, show count
        if (asArray && Array.isArray(asArray) && asArray.length > 0) {
          return `[x${asArray.length}]`
        }
        // Check if the string looks like a JSON array (starts with '[')
        const trimmed = (s ?? '').toString().trim()
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed) as unknown
            if (Array.isArray(parsed)) {
              return `[x${parsed.length}]`
            }
          } catch {
            // Not valid JSON, fall through
          }
        }
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

                  const text = (() => {
                    const hasHuman =
                      Array.isArray(row.humanAnswersByPrompt?.[judgment.promptId])
                      && (row.humanAnswersByPrompt?.[judgment.promptId] || []).length > 0
                    if (!hasHuman) return labelFor(judgment.answeredOriginal, judgment.answeredOriginalAsArray)

                    const humans = row.humanAnswersByPrompt?.[judgment.promptId] || []
                    const normalizedHumans = humans.map(norm)
                    const firstDiff = normalizedHumans.find((h) => {
                      return h !== llmAns
                    })
                    const humanLetter = labelFor(firstDiff ?? llmAns)
                    const llmLetter = labelFor(judgment.answeredOriginal, judgment.answeredOriginalAsArray)
                    return `${llmLetter}/${humanLetter}`
                  })()

                  return (
                    <span class={`px-1.5 py-0.5 text-xs rounded ${cls}`} title={tooltip}>
                      {text}
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
                          style={{width: `${cell.column.getSize()}px`}}
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
