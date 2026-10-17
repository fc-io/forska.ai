import {For, Show, splitProps} from 'solid-js'

import {getProviderHealthToneClass, type JudgmentJobFullTextGate} from '../jobsPageShared'

export const hasJobFullTextGateMessages = (gate: JudgmentJobFullTextGate) => {
  return gate.errors.length > 0 || gate.warnings.length > 0
}

export const JobFullTextGateNotice = (props: {gate: JudgmentJobFullTextGate}) => {
  const [local] = splitProps(props, ['gate'])

  return (
    <div class="space-y-2" data-testid="job-full-text-gate">
      <Show when={local.gate.errors.length > 0}>
        <div
          role="alert"
          class={`rounded-md border px-4 py-3 text-sm break-words [overflow-wrap:anywhere] ${getProviderHealthToneClass('rose')}`}
        >
          <p class="font-medium">Full-text checks block judging</p>
          <ul class="mt-1 list-disc space-y-1 pl-5">
            <For each={local.gate.errors}>
              {(error) => {
                return <li>{error}</li>
              }}
            </For>
          </ul>
        </div>
      </Show>
      <Show when={local.gate.warnings.length > 0}>
        <div
          class={`rounded-md border px-4 py-3 text-sm break-words [overflow-wrap:anywhere] ${getProviderHealthToneClass('amber')}`}
        >
          <p class="font-medium">Full-text warnings</p>
          <ul class="mt-1 list-disc space-y-1 pl-5">
            <For each={local.gate.warnings}>
              {(warning) => {
                return <li>{warning}</li>
              }}
            </For>
          </ul>
        </div>
      </Show>
    </div>
  )
}
