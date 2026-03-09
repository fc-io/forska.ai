import {Link} from '@tanstack/solid-router'
import {format} from 'date-fns'
import {For, Show} from 'solid-js'

import type {
  ComparisonProjectJudgmentsColumn,
  ComparisonProjectJudgmentsRow,
} from '../../../services/comparisonProjectsService.ts'

type ComparisonProjectJudgmentsTableProps = {
  columns: ComparisonProjectJudgmentsColumn[]
  rows: ComparisonProjectJudgmentsRow[]
}

const formatArticleCreatedAt = (value: Date | string | null) => {
  return value ? format(new Date(value), 'yyyy-MM-dd') : null
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
                return (
                  <th
                    class={`w-[18rem] min-w-[18rem] max-w-[18rem] px-4 py-3 text-left text-xs font-medium uppercase tracking-wider ${column.kind === 'human' ? 'bg-amber-50 text-amber-800' : 'text-gray-500'}`}
                  >
                    <div class="space-y-1 normal-case tracking-normal">
                      <div class="text-sm font-semibold">{column.promptLabel}</div>
                      <div class="text-xs font-medium uppercase tracking-wide opacity-80">{column.modelLabel}</div>
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

              return (
                <tr class="align-top">
                  <td class="sticky left-0 z-10 w-[22rem] min-w-[22rem] max-w-[22rem] bg-white px-6 py-4">
                    <div class="space-y-2">
                      <Link
                        to="/articles/$id"
                        params={{id: row.id} as never}
                        class="font-medium text-blue-600 hover:underline"
                      >
                        {row.articleTitle?.trim() || 'Untitled'}
                      </Link>
                      <Show when={articleCreatedAt}>
                        <p class="text-xs text-gray-500">Created: {articleCreatedAt}</p>
                      </Show>
                    </div>
                  </td>
                  <For each={props.columns}>
                    {(column) => {
                      const cellValue = row.cells[column.id]?.trim() || null

                      return (
                        <td class="w-[18rem] min-w-[18rem] max-w-[18rem] px-4 py-4 text-sm text-gray-800">
                          <Show when={cellValue} fallback={<span class="text-gray-300">-</span>}>
                            <div class="whitespace-pre-wrap break-words leading-6">{cellValue}</div>
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
