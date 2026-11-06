import {Show, splitProps} from 'solid-js'

export const ReviewProviderRefusalBanner = (props: {enabledPromptCount: number; refusedPromptCount: number}) => {
  const [local] = splitProps(props, ['enabledPromptCount', 'refusedPromptCount'])

  return (
    <Show when={local.refusedPromptCount > 0}>
      <div class="rounded-lg border border-amber-200 bg-amber-50 p-4" role="alert">
        <h2 class="text-sm font-semibold text-amber-900">Needs human screening</h2>
        <p class="mt-1 text-sm text-amber-800">
          The model refused to answer {local.refusedPromptCount} of {local.enabledPromptCount} prompts for this article.
          Refused prompts are never retried, so screen this article by hand.
        </p>
      </div>
    </Show>
  )
}
