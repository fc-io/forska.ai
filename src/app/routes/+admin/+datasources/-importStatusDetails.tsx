import {Match, Show, Switch} from 'solid-js'

import {
  type DataSourceImportStatusView,
  formatImportStatusTime,
  getImportEtaLabel,
  getImportProgressLabel,
  getImportRetryLabel,
} from './-importStatus.ts'

type ImportStatusProps = {importStatus: DataSourceImportStatusView}

const ImportStatusHeading = (props: {class: string; label: string; time?: string | null}) => {
  return (
    <div class="text-sm text-gray-500">
      <span class="font-medium text-gray-700">Import:</span> <span class={props.class}>{props.label}</span>
      <Show when={props.time}>
        {(time) => {
          return <> {formatImportStatusTime(time())}</>
        }}
      </Show>
    </div>
  )
}

const RunningImportStatus = (props: ImportStatusProps) => {
  return (
    <>
      <ImportStatusHeading class="font-medium text-blue-700" label="Running" />
      <div class="text-sm text-gray-500 whitespace-normal">{getImportProgressLabel(props.importStatus)}</div>
      <div class="text-sm text-gray-500 whitespace-normal">
        <Show when={props.importStatus.lastProgressAt} fallback="Waiting for the first page">
          {(lastProgressAt) => {
            return <>Last page {formatImportStatusTime(lastProgressAt())}</>
          }}
        </Show>
        <Show when={getImportEtaLabel(props.importStatus)}>
          {(etaLabel) => {
            return <>, {etaLabel()}</>
          }}
        </Show>
      </div>
    </>
  )
}

const FailedImportStatus = (props: ImportStatusProps) => {
  return (
    <>
      <ImportStatusHeading class="font-medium text-red-600" label="Failed" time={props.importStatus.failedAt} />
      <Show when={props.importStatus.lastError}>
        {(lastError) => {
          return <div class="text-sm text-red-600 whitespace-normal break-words max-w-md">{lastError()}</div>
        }}
      </Show>
      <Show when={props.importStatus.storedCount > 0}>
        <div class="text-sm text-gray-500 whitespace-normal">{getImportProgressLabel(props.importStatus)}</div>
      </Show>
      <div class="text-sm text-gray-500 whitespace-normal">{getImportRetryLabel(props.importStatus)}</div>
    </>
  )
}

export const DataSourceImportStatusDetails = (props: {importStatus: DataSourceImportStatusView | null}) => {
  return (
    <Show when={props.importStatus}>
      {(importStatus) => {
        return (
          <Switch>
            <Match when={importStatus().status === 'running'}>
              <RunningImportStatus importStatus={importStatus()} />
            </Match>
            <Match when={importStatus().status === 'failed'}>
              <FailedImportStatus importStatus={importStatus()} />
            </Match>
            <Match when={importStatus().status === 'interrupted'}>
              <ImportStatusHeading class="font-medium text-amber-700" label="Interrupted" />
              <div class="text-sm text-gray-500 whitespace-normal">
                The import stopped before it finished. Resume continues from the saved cursor.
              </div>
            </Match>
            <Match when={importStatus().status === 'completed'}>
              <ImportStatusHeading
                class="font-medium text-green-700"
                label="Completed"
                time={importStatus().completedAt}
              />
            </Match>
          </Switch>
        )
      }}
    </Show>
  )
}
