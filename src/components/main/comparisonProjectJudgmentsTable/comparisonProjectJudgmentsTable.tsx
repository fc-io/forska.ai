import {Link} from '@tanstack/solid-router'
import {format} from 'date-fns'
import {For, Show} from 'solid-js'

import type {
  ComparisonProjectJudgmentsColumn,
  ComparisonProjectJudgmentsRow,
} from '../../../services/comparisonProjectsService.ts'

export type ComparisonProjectJudgmentsTableColumn = ComparisonProjectJudgmentsColumn & {
  sourceProjectId: string | null
  sourceProjectName: string | null
}

type ComparisonProjectJudgmentsTableProps = {
  conflictResolutionEnabled?: boolean
  conflictResolutionOptions?: Array<{label: string; value: string}>
  conflictResolutionPendingArticleId?: string | null
  columns: ComparisonProjectJudgmentsTableColumn[]
  onConflictResolutionReset?: (articleId: string) => void | Promise<void>
  onConflictResolutionSelect?: (articleId: string, value: string) => void | Promise<void>
  rows: ComparisonProjectJudgmentsRow[]
}

const formatArticleCreatedAt = (value: Date | string | null) => {
  return value ? format(new Date(value), 'yyyy-MM-dd') : null
}

const getModelLabelParts = (label: string) => {
  const thinkingMatch = label.match(/\s+\(thinking:\s*([^)]+)\)$/i)

  return thinkingMatch
    ? {name: label.replace(/\s+\(thinking:\s*([^)]+)\)$/i, ''), thinking: `thinking: ${thinkingMatch[1]}`}
    : {name: label, thinking: null}
}

const normalizeAnswerValue = (value: string | null | undefined) => {
  return value?.trim().toLowerCase() ?? ''
}

const getRowHighlightState = (
  cells: Record<string, string | null>,
  columns: ComparisonProjectJudgmentsColumn[],
): 'match' | 'mismatch' | 'neutral' => {
  const answeredValues = columns
    .map((column) => {
      return normalizeAnswerValue(cells[column.id])
    })
    .filter(Boolean)

  if (answeredValues.length < 2) {
    return 'neutral'
  }

  return new Set(answeredValues).size === 1 ? 'match' : 'mismatch'
}

const getRowHighlightClasses = (state: 'match' | 'mismatch' | 'neutral') => {
  return state === 'match'
    ? {cell: 'bg-green-50', stickyCell: 'bg-green-50'}
    : state === 'mismatch'
      ? {cell: 'bg-red-50', stickyCell: 'bg-red-50'}
      : {cell: 'bg-white', stickyCell: 'bg-white'}
}

export const ComparisonProjectJudgmentsTable = (props: ComparisonProjectJudgmentsTableProps) => {
  const conflictResolutionOptions = () => {
    return props.conflictResolutionOptions ?? []
  }
  const getIsConflictResolutionPending = (articleId: string) => {
    return props.conflictResolutionPendingArticleId === articleId
  }

  return (
    <div class="overflow-x-auto bg-white rounded-lg shadow border border-gray-200">
      <table class="min-w-full table-fixed divide-y divide-gray-200">
        <thead class="bg-gray-50">
          <tr>
            <th class="sticky left-0 z-20 w-[22rem] min-w-[22rem] max-w-[22rem] bg-gray-50 px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
              Title
            </th>
            <Show when={props.conflictResolutionEnabled}>
              <th class="w-[13rem] min-w-[13rem] max-w-[13rem] bg-gray-50 px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Conflict Handling
              </th>
            </Show>
            <For each={props.columns}>
              {(column) => {
                const modelLabelParts = getModelLabelParts(column.modelLabel)

                return (
                  <th
                    class={`w-[18rem] min-w-[18rem] max-w-[18rem] px-4 py-3 text-left text-xs font-medium uppercase tracking-wider ${column.kind === 'human' ? 'bg-amber-50 text-amber-800' : 'text-gray-500'}`}
                  >
                    <div class="space-y-1 normal-case tracking-normal">
                      <Show when={column.sourceProjectName}>
                        {(sourceProjectName) => {
                          return (
                            <div class="truncate text-xs font-semibold text-gray-900" title={sourceProjectName()}>
                              {sourceProjectName()}
                            </div>
                          )
                        }}
                      </Show>
                      <div class="text-sm font-semibold">{column.promptLabel}</div>
                      <div class="text-xs font-medium uppercase tracking-wide opacity-80">
                        <div>{modelLabelParts.name}</div>
                        <Show when={column.contentLabel}>
                          {(contentLabel) => {
                            return <div>{contentLabel()}</div>
                          }}
                        </Show>
                        <Show when={modelLabelParts.thinking}>
                          {(thinking) => {
                            return <div>{thinking()}</div>
                          }}
                        </Show>
                      </div>
                    </div>
                  </th>
                )
              }}
            </For>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-200 bg-white">
          <For each={props.rows}>
            {(row) => {
              const articleCreatedAt = formatArticleCreatedAt(row.articleCreatedAt)
              const rowHighlightState = getRowHighlightState(row.cells, props.columns)
              const rowHighlightClasses = getRowHighlightClasses(rowHighlightState)

              return (
                <tr class="align-top">
                  <td
                    class={`sticky left-0 z-10 w-[22rem] min-w-[22rem] max-w-[22rem] px-6 py-4 ${rowHighlightClasses.stickyCell}`}
                  >
                    <div class="space-y-2">
                      <p class="font-medium text-gray-900">{row.articleTitle?.trim() || 'Untitled'}</p>
                      <Show when={articleCreatedAt}>
                        <p class="text-xs text-gray-500">Created: {articleCreatedAt}</p>
                      </Show>
                    </div>
                  </td>
                  <Show when={props.conflictResolutionEnabled}>
                    <td class={`w-[13rem] min-w-[13rem] max-w-[13rem] px-4 py-4 text-sm ${rowHighlightClasses.cell}`}>
                      <Show when={row.hasConflict} fallback={<span class="text-gray-400">No conflict</span>}>
                        <Show
                          when={row.conflictResolution}
                          fallback={
                            <Show
                              when={conflictResolutionOptions().length > 0}
                              fallback={<span class="text-gray-400">No options available</span>}
                            >
                              <select
                                value=""
                                disabled={getIsConflictResolutionPending(row.canonicalArticleId)}
                                class="w-full max-w-[180px] rounded-md border border-gray-300 bg-white px-2 py-1 text-sm disabled:opacity-60"
                                onChange={(event) => {
                                  const value = event.currentTarget.value

                                  if (value) {
                                    void props.onConflictResolutionSelect?.(row.canonicalArticleId, value)
                                  }
                                }}
                              >
                                <option value="" disabled selected>
                                  Conflict resolution:
                                </option>
                                <For each={conflictResolutionOptions()}>
                                  {(option) => {
                                    return <option value={option.value}>{option.label}</option>
                                  }}
                                </For>
                              </select>
                            </Show>
                          }
                        >
                          {(resolution) => {
                            return (
                              <div class="flex items-start justify-between gap-2">
                                <span
                                  class="min-w-0 whitespace-pre-wrap break-words leading-6 text-gray-800"
                                  title={resolution().label}
                                >
                                  {resolution().label}
                                </span>
                                <button
                                  type="button"
                                  class="inline-flex size-7 shrink-0 items-center justify-center rounded border border-gray-300 bg-white text-gray-600 shadow-sm hover:border-gray-400 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-60"
                                  title="Reset conflict resolution"
                                  aria-label={`Reset conflict resolution for ${row.articleTitle?.trim() || 'article'}`}
                                  disabled={getIsConflictResolutionPending(row.canonicalArticleId)}
                                  onClick={() => {
                                    void props.onConflictResolutionReset?.(row.canonicalArticleId)
                                  }}
                                >
                                  <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    stroke-width="2.5"
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    class="size-4"
                                  >
                                    <path d="M18 6L6 18" />
                                    <path d="M6 6l12 12" />
                                  </svg>
                                </button>
                              </div>
                            )
                          }}
                        </Show>
                      </Show>
                    </td>
                  </Show>
                  <For each={props.columns}>
                    {(column) => {
                      const cellValue = row.cells[column.id]?.trim() || null

                      return (
                        <td
                          class={`w-[18rem] min-w-[18rem] max-w-[18rem] px-4 py-4 text-sm text-gray-800 ${rowHighlightClasses.cell}`}
                        >
                          <Show when={cellValue} fallback={<span class="text-gray-300">-</span>}>
                            <Show
                              when={column.sourceProjectId}
                              fallback={<div class="whitespace-pre-wrap break-words leading-6">{cellValue}</div>}
                            >
                              {(sourceProjectId) => {
                                return (
                                  <Link
                                    to="/projects/$id/reviews-llm/$articleId"
                                    params={{articleId: row.canonicalArticleId, id: sourceProjectId()} as never}
                                    class="block whitespace-pre-wrap break-words leading-6 text-blue-600 hover:underline"
                                  >
                                    {cellValue}
                                  </Link>
                                )
                              }}
                            </Show>
                          </Show>
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
    </div>
  )
}
