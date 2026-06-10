import {For, Show} from 'solid-js'

import {
  type ComparisonProjectConflictResolutionImportAnalyzePreview,
  type ComparisonProjectConflictResolutionImportImportableRow,
  type ComparisonProjectConflictResolutionImportSkippedRow,
} from '../../../../../services/comparisonProjectsService.ts'
import {
  getArticleIdListLabel,
  getImportSummaryStats,
  getMatchKeyLabel,
  getMatchKindLabel,
  getOptionalImportValueLabel,
  getResolutionCountLabel,
  getRowCountLabel,
  getSkipReasonLabel,
  getTargetArticleIds,
  getTargetExternalArticleIds,
} from './compareProjectImportResolutionsHelpers.ts'

type CompareProjectImportResolutionsResultsProps = {preview: ComparisonProjectConflictResolutionImportAnalyzePreview}

type ImportResolutionSourceCellProps = {
  row: ComparisonProjectConflictResolutionImportImportableRow | ComparisonProjectConflictResolutionImportSkippedRow
}

type ImportResolutionTargetCellProps = ImportResolutionSourceCellProps

type ImportResolutionMatchCellProps = ImportResolutionSourceCellProps

const tableHeadClass = 'px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500'
const tableCellClass = 'px-3 py-2 align-top text-sm text-gray-700'

const ImportResolutionSourceCell = (props: ImportResolutionSourceCellProps) => {
  return (
    <div class="space-y-1">
      <p class="max-w-md font-medium text-gray-900">{getOptionalImportValueLabel(props.row.sourceTitle)}</p>
      <p class="text-xs text-gray-500">Source article: {props.row.sourceArticleRowId}</p>
      <p class="text-xs text-gray-500">External ID: {getOptionalImportValueLabel(props.row.sourceExternalArticleId)}</p>
      <p class="text-xs text-gray-500">Resolution row: {props.row.sourceResolutionId}</p>
      <p class="text-xs text-gray-500">Source project: {props.row.sourceComparisonProjectName}</p>
    </div>
  )
}

const ImportResolutionTargetCell = (props: ImportResolutionTargetCellProps) => {
  const targetArticleIds = () => {
    return getTargetArticleIds(props.row)
  }
  const targetExternalArticleIds = () => {
    return getTargetExternalArticleIds(props.row)
  }

  return (
    <div class="space-y-1">
      <p class="max-w-md font-medium text-gray-900">{getOptionalImportValueLabel(props.row.targetTitle)}</p>
      <p class="text-xs text-gray-500">Target article: {getArticleIdListLabel(targetArticleIds())}</p>
      <p class="text-xs text-gray-500">External ID: {getArticleIdListLabel(targetExternalArticleIds())}</p>
    </div>
  )
}

const ImportResolutionMatchCell = (props: ImportResolutionMatchCellProps) => {
  return (
    <div class="space-y-1">
      <p class="font-medium text-gray-900">{getMatchKindLabel(props.row.matchKind)}</p>
      <p class="max-w-xs break-words text-xs text-gray-500">
        {getMatchKeyLabel(props.row.matchKind, props.row.matchKey)}
      </p>
    </div>
  )
}

const EmptyImportRows = (props: {children: string}) => {
  return <div class="rounded-md border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">{props.children}</div>
}

const ImportableRowsTable = (props: {rows: ComparisonProjectConflictResolutionImportImportableRow[]}) => {
  return (
    <Show when={props.rows.length > 0} fallback={<EmptyImportRows>No rows will be imported.</EmptyImportRows>}>
      <div class="overflow-x-auto rounded-md border border-gray-200">
        <table class="min-w-full divide-y divide-gray-200">
          <thead class="bg-gray-50">
            <tr>
              <th class={tableHeadClass}>Source article</th>
              <th class={tableHeadClass}>Target article</th>
              <th class={tableHeadClass}>Selected resolution</th>
              <th class={tableHeadClass}>Match</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100 bg-white">
            <For each={props.rows}>
              {(row) => {
                return (
                  <tr>
                    <td class={tableCellClass}>
                      <ImportResolutionSourceCell row={row} />
                    </td>
                    <td class={tableCellClass}>
                      <ImportResolutionTargetCell row={row} />
                    </td>
                    <td class={`${tableCellClass} font-medium text-gray-900`}>{row.selectedResolution}</td>
                    <td class={tableCellClass}>
                      <ImportResolutionMatchCell row={row} />
                    </td>
                  </tr>
                )
              }}
            </For>
          </tbody>
        </table>
      </div>
    </Show>
  )
}

const SkippedRowsTable = (props: {rows: ComparisonProjectConflictResolutionImportSkippedRow[]}) => {
  return (
    <Show when={props.rows.length > 0} fallback={<EmptyImportRows>No rows were skipped.</EmptyImportRows>}>
      <div class="overflow-x-auto rounded-md border border-gray-200">
        <table class="min-w-full divide-y divide-gray-200">
          <thead class="bg-gray-50">
            <tr>
              <th class={tableHeadClass}>Source article</th>
              <th class={tableHeadClass}>Attempted target</th>
              <th class={tableHeadClass}>Selected resolution</th>
              <th class={tableHeadClass}>Match</th>
              <th class={tableHeadClass}>Skip reason</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100 bg-white">
            <For each={props.rows}>
              {(row) => {
                return (
                  <tr>
                    <td class={tableCellClass}>
                      <ImportResolutionSourceCell row={row} />
                    </td>
                    <td class={tableCellClass}>
                      <ImportResolutionTargetCell row={row} />
                    </td>
                    <td class={`${tableCellClass} font-medium text-gray-900`}>{row.selectedResolution}</td>
                    <td class={tableCellClass}>
                      <ImportResolutionMatchCell row={row} />
                    </td>
                    <td class={tableCellClass}>
                      <span class="inline-flex rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
                        {getSkipReasonLabel(row.reason)}
                      </span>
                    </td>
                  </tr>
                )
              }}
            </For>
          </tbody>
        </table>
      </div>
    </Show>
  )
}

export const CompareProjectImportResolutionsResults = (props: CompareProjectImportResolutionsResultsProps) => {
  const stats = () => {
    return getImportSummaryStats(props.preview.summary)
  }

  return (
    <section class="space-y-6">
      <div class="rounded-lg bg-white p-6 shadow">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 class="text-lg font-semibold">Analyze result</h2>
            <p class="mt-1 text-sm text-gray-600">
              Source: {props.preview.source.comparisonProjectName} · {getRowCountLabel(props.preview.source.rowCount)}
            </p>
          </div>
          <div class="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            {getResolutionCountLabel(props.preview.summary.importable)} ready to import
          </div>
        </div>
        <div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <For each={stats()}>
            {(stat) => {
              return (
                <div class="rounded-md border border-gray-200 bg-gray-50 p-3">
                  <p class="text-xs font-medium uppercase tracking-wide text-gray-500">{stat.label}</p>
                  <p class="mt-1 text-lg font-semibold text-gray-900">{getResolutionCountLabel(stat.value)}</p>
                  <p class="mt-1 text-xs text-gray-600">{stat.description}</p>
                </div>
              )
            }}
          </For>
        </div>
      </div>

      <div class="rounded-lg bg-white p-6 shadow">
        <h2 class="text-lg font-semibold">Rows that will be imported</h2>
        <p class="mt-1 text-sm text-gray-600">
          These saved conflict-resolution decisions matched unresolved target comparison rows.
        </p>
        <div class="mt-4">
          <ImportableRowsTable rows={props.preview.importableRows} />
        </div>
      </div>

      <div class="rounded-lg bg-white p-6 shadow">
        <h2 class="text-lg font-semibold">Rows that will not be imported</h2>
        <p class="mt-1 text-sm text-gray-600">
          Skipped rows are shown with their source details, attempted target details when known, match metadata, and
          reason.
        </p>
        <div class="mt-4">
          <SkippedRowsTable rows={props.preview.skippedRows} />
        </div>
      </div>
    </section>
  )
}
