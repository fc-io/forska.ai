import {Link} from '@tanstack/solid-router'
import {format} from 'date-fns'
import {For, Show} from 'solid-js'

import type {
  ComparisonProjectJudgmentsColumn,
  ComparisonProjectJudgmentsRow,
} from '../../../services/comparisonProjectsService.ts'

export type ComparisonProjectJudgmentsTableColumn = ComparisonProjectJudgmentsColumn & {sourceProjectId: string | null}

type ComparisonProjectJudgmentsTableProps = {
  columns: ComparisonProjectJudgmentsTableColumn[]
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
  return (
    <div class="overflow-x-auto bg-white rounded-lg shadow border border-gray-200">
      <table class="min-w-full table-fixed divide-y divide-gray-200">
        <thead class="bg-gray-50">
          <tr>
            <th class="sticky left-0 z-20 w-[22rem] min-w-[22rem] max-w-[22rem] bg-gray-50 px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
              Title
            </th>
            <For each={props.columns}>
              {(column) => {
                const modelLabelParts = getModelLabelParts(column.modelLabel)

                return (
                  <th
                    class={`w-[18rem] min-w-[18rem] max-w-[18rem] px-4 py-3 text-left text-xs font-medium uppercase tracking-wider ${column.kind === 'human' ? 'bg-amber-50 text-amber-800' : 'text-gray-500'}`}
                  >
                    <div class="space-y-1 normal-case tracking-normal">
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
                                    params={{articleId: row.id, id: sourceProjectId()} as never}
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
