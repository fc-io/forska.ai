import {For, Match, Show, splitProps, Switch} from 'solid-js'

export type FullTextStrategyPreviewData = {
  current: {judgmentCount: number; strategyId: string; strategyLabel: string} | null
  errors: string[]
  strategyId: string | null
  strategyLabel: string | null
}

type FullTextStrategyPreviewProps = {
  data: FullTextStrategyPreviewData | undefined
  isError: boolean
  isLoading: boolean
  showStrategy: boolean
}

const isStrategyChangeWithJudgments = (data: FullTextStrategyPreviewData | undefined) => {
  return Boolean(
    data?.current
    && data.current.judgmentCount > 0
    && data.strategyId !== null
    && data.strategyId !== data.current.strategyId,
  )
}

export const FullTextStrategyPreview = (props: FullTextStrategyPreviewProps) => {
  const [local] = splitProps(props, ['data', 'isError', 'isLoading', 'showStrategy'])

  return (
    <div class="space-y-2">
      <Switch>
        <Match when={local.isLoading}>
          <p class="text-xs text-muted-foreground">Resolving the full-text strategy…</p>
        </Match>
        <Match when={local.isError}>
          <p class="text-xs text-red-700">Could not resolve the full-text strategy.</p>
        </Match>
        <Match when={local.showStrategy && local.data && local.data.errors.length > 0}>
          <ul class="text-xs text-red-700 list-disc pl-4 space-y-1" data-testid="full-text-strategy-errors">
            <For each={local.data?.errors ?? []}>
              {(error) => {
                return <li>{error}</li>
              }}
            </For>
          </ul>
        </Match>
        <Match when={local.showStrategy && local.data?.strategyId}>
          <p class="text-xs text-gray-700">
            Full-text strategy: <span data-testid="full-text-strategy-label">{local.data?.strategyLabel}</span>{' '}
            <code class="text-[11px] text-muted-foreground" data-testid="full-text-strategy-id">
              {local.data?.strategyId}
            </code>
          </p>
        </Match>
      </Switch>
      <Show when={isStrategyChangeWithJudgments(local.data)}>
        <p
          class="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-2"
          data-testid="full-text-strategy-warning"
        >
          New judgments will use {local.data?.strategyLabel}. They will not be comparable with the{' '}
          {local.data?.current?.judgmentCount} existing judgments made with {local.data?.current?.strategyLabel}, and
          those stop showing in this project.
        </p>
      </Show>
    </div>
  )
}
