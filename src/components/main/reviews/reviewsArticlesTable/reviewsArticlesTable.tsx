import {Link} from '@tanstack/solid-router'
import {type ColumnDef, createSolidTable, flexRender, getCoreRowModel} from '@tanstack/solid-table'
import {format} from 'date-fns'
import type {Accessor, Setter} from 'solid-js'
import {For, Show} from 'solid-js'

import {type ArticleUrlInput, getArticleUrl} from '../../../../app/utils/getArticleUrl.ts'
import {getJournalDisplayTitleForArticle} from '../../../../utils/getJournalDisplayTitleForArticle.ts'
import {ReviewsCovidenceBadges} from '../reviewsCovidenceBadges.tsx'
import {ReviewsArticlesPdfCell} from './reviewsArticlesPdfCell.tsx'

declare module '@tanstack/solid-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface TableMeta<TData> {
    projectId?: () => string
    rowSelection?: Accessor<Record<string, boolean>>
  }
}

// Minimal judgment fields used by this component
type JudgmentData = {
  id: string
  promptId: string
  answeredOriginal: string | null
  answeredOriginalAsArray?: string[] | null
}

// Minimal article data required for the reviews table
// This supports both the full article schema and the denormalized API response
export type ArticleWithJudgments = ArticleUrlInput & {
  id: string
  articleTitle: string | null
  articleCreatedAt: Date | null
  articleUpdatedAt: Date | null
  judgments: Array<JudgmentData>
  journalTitle?: string | null
  canonicalArticleId?: string | null
  fullTextPDF?: string | null
  fullTextFetchedAt?: Date | null
  fullTextConversionStatus?: string | null
  humanJudgmentMode?: 'prompt' | 'summary'
  humanAnswersByPrompt?: Record<string, string[]>
  humanSummaryAnswer?: string | null
  llmSummaryAnswer?: string | null
  judgedPromptIds?: string[]
  isFullyJudged?: boolean
  selectedExternalArticleId?: string | null
  selectedImportRecordId?: string | null
  selectedImportRouteId?: string | null
  selectedSourceRecordKey?: string | null
}

interface ReviewsArticlesTableProps {
  articles: ArticleWithJudgments[]
  projectId: string
  rowSelection: Accessor<Record<string, boolean>>
  setRowSelection: Setter<Record<string, boolean>>
}

const normalizeAnswer = (value?: string | null) => {
  return (value ?? '').toString().trim().toLowerCase()
}

const getArrayAnswerCount = (value?: string | null) => {
  const trimmed = (value ?? '').toString().trim()
  let count: number | null = null

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      count = Array.isArray(parsed) ? parsed.length : null
    } catch {
      count = null
    }
  }

  return count
}

const getAnswerLabel = (value?: string | null, asArray?: string[] | null) => {
  const providedArrayCount = Array.isArray(asArray) ? asArray.length : 0
  const parsedArrayCount = getArrayAnswerCount(value)
  const normalized = normalizeAnswer(value)
  const shortLabel =
    normalized === 'yes'
      ? 'Y'
      : normalized === 'no'
        ? 'N'
        : normalized === 'maybe'
          ? 'M'
          : normalized === 'unsure'
            ? 'U'
            : normalized.length > 0
              ? normalized.slice(0, 1).toUpperCase()
              : '—'

  return providedArrayCount > 0
    ? `[x${providedArrayCount}]`
    : parsedArrayCount !== null
      ? `[x${parsedArrayCount}]`
      : shortLabel
}

const getHumanAnswerLabel = (answers?: string[]) => {
  const labels = (answers ?? []).map((answer) => {
    return getAnswerLabel(answer)
  })
  const uniqueLabels = [...new Set(labels)]

  return labels.length === 0
    ? '—'
    : uniqueLabels.length === 1
      ? labels.length === 1
        ? (uniqueLabels[0] ?? '—')
        : `${uniqueLabels[0] ?? '—'} x${labels.length}`
      : labels.join(', ')
}

const getPromptTone = (aiAnswer: string, humanAnswers: string[]) => {
  const matches = humanAnswers.filter((answer) => {
    return answer === aiAnswer
  }).length

  return !aiAnswer || humanAnswers.length === 0
    ? 'neutral'
    : matches === humanAnswers.length
      ? 'match'
      : matches > 0
        ? 'mixed'
        : 'mismatch'
}

const getSummaryTone = (aiAnswer: string, humanAnswer: string) => {
  return !aiAnswer || !humanAnswer
    ? 'neutral'
    : aiAnswer === humanAnswer
      ? 'match'
      : aiAnswer === 'maybe' || humanAnswer === 'maybe'
        ? 'mixed'
        : 'mismatch'
}

const getJudgmentBadgeClassName = (tone: ReturnType<typeof getSummaryTone>) => {
  return tone === 'match'
    ? 'bg-green-50 text-green-800'
    : tone === 'mixed'
      ? 'bg-yellow-50 text-yellow-800'
      : tone === 'mismatch'
        ? 'bg-red-50 text-red-800'
        : 'bg-gray-50 text-gray-800'
}

const getJudgmentComparisonClassName = () => {
  return 'inline-flex min-w-[84px] flex-col overflow-hidden bg-white'
}

const getJudgmentComparisonHeadingRowClassName = () => {
  return 'grid grid-cols-2'
}

const getJudgmentComparisonValueRowClassName = (tone: ReturnType<typeof getSummaryTone>) => {
  return `grid grid-cols-2 border border-gray-200 ${getJudgmentBadgeClassName(tone)}`
}

const getJudgmentComparisonHeadingClassName = () => {
  return 'px-1.5 py-1 text-center text-[9px] font-medium uppercase tracking-[0.12em] text-gray-500'
}

const getJudgmentComparisonValueClassName = () => {
  return 'px-1.5 py-1 text-center text-xs font-semibold text-gray-900'
}

const getSourceArticleId = (article: ArticleWithJudgments) => {
  const value = article.articleId ?? article.selectedExternalArticleId
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed ? trimmed : null
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
        <div>
          <Link
            to="/projects/$id/reviews-llm/$articleId"
            params={{id: info.table.options.meta?.projectId?.() || '', articleId: info.row.original.id}}
            class="text-blue-600 hover:underline"
          >
            {(info.getValue() as string) || 'Untitled'}
          </Link>
          <ReviewsCovidenceBadges sourceMetadata={info.row.original.sourceMetadata} />
        </div>
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
      const article = info.row.original
      const articleId = getSourceArticleId(article)
      const articleUrl = getArticleUrl(article)
      return (
        <Show when={articleId} fallback={<span class="text-gray-400">—</span>}>
          {(displayId) => {
            return (
              <Show
                when={articleUrl}
                fallback={
                  <span class="block truncate" title={displayId()}>
                    {displayId()}
                  </span>
                }
              >
                {(url) => {
                  return (
                    <a
                      href={url()}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="text-blue-600 hover:underline block truncate"
                      title={displayId()}
                    >
                      {displayId()}
                    </a>
                  )
                }}
              </Show>
            )
          }}
        </Show>
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
          sourceMetadata={(info.row.original as {sourceMetadata?: unknown}).sourceMetadata}
        />
      )
    },
  },
  {
    accessorKey: 'judgments',
    header: 'Judgments',
    size: 210,
    minSize: 180,
    cell: (info) => {
      const judgmentsData = info.getValue() as JudgmentData[]
      const row = info.row.original

      return (
        <div class="space-y-2">
          <Show
            when={row.humanJudgmentMode === 'summary'}
            fallback={
              <Show when={judgmentsData && judgmentsData.length > 0}>
                <div class="flex flex-wrap gap-2">
                  <For each={judgmentsData.slice(0, 3)}>
                    {(judgment) => {
                      const aiAnswer = normalizeAnswer(judgment.answeredOriginal)
                      const humanAnswers = (row.humanAnswersByPrompt?.[judgment.promptId] ?? []).map((answer) => {
                        return normalizeAnswer(answer)
                      })
                      const humanValue = getHumanAnswerLabel(row.humanAnswersByPrompt?.[judgment.promptId])
                      const aiValue = getAnswerLabel(judgment.answeredOriginal, judgment.answeredOriginalAsArray)

                      const tooltip = (() => {
                        const aiText = judgment.answeredOriginal ?? '—'
                        const humans = row.humanAnswersByPrompt?.[judgment.promptId]
                        const humanText = humans && humans.length > 0 ? humans.join(', ') : '—'
                        return `AI: ${aiText} • Human: ${humanText}`
                      })()
                      const tone = getPromptTone(aiAnswer, humanAnswers)

                      return (
                        <div class={getJudgmentComparisonClassName()} title={tooltip}>
                          <div class={getJudgmentComparisonHeadingRowClassName()}>
                            <span class={getJudgmentComparisonHeadingClassName()}>AI</span>
                            <span class={getJudgmentComparisonHeadingClassName()}>H</span>
                          </div>
                          <div class={getJudgmentComparisonValueRowClassName(tone)}>
                            <span class={getJudgmentComparisonValueClassName()}>{aiValue}</span>
                            <span class={getJudgmentComparisonValueClassName()}>{humanValue}</span>
                          </div>
                        </div>
                      )
                    }}
                  </For>
                  <Show when={judgmentsData.length > 3}>
                    <span class="self-center text-xs text-gray-500">+{judgmentsData.length - 3}</span>
                  </Show>
                </div>
              </Show>
            }
          >
            <div
              class={getJudgmentComparisonClassName()}
              title={`AI: ${row.llmSummaryAnswer ?? '—'} • Human: ${row.humanSummaryAnswer ?? '—'}`}
            >
              <div class={getJudgmentComparisonHeadingRowClassName()}>
                <span class={getJudgmentComparisonHeadingClassName()}>AI</span>
                <span class={getJudgmentComparisonHeadingClassName()}>H</span>
              </div>
              <div
                class={getJudgmentComparisonValueRowClassName(
                  getSummaryTone(normalizeAnswer(row.llmSummaryAnswer), normalizeAnswer(row.humanSummaryAnswer)),
                )}
              >
                <span class={getJudgmentComparisonValueClassName()}>{getAnswerLabel(row.llmSummaryAnswer)}</span>
                <span class={getJudgmentComparisonValueClassName()}>{getAnswerLabel(row.humanSummaryAnswer)}</span>
              </div>
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
                                : cell.column.id === 'judgments'
                                  ? 'px-6 py-4 align-top text-sm text-gray-900'
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
