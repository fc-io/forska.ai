import {For, Show} from 'solid-js'

type ArticleMetadataLine = {label: string; value: string}

export const ReviewArticleDetailsArticleMetadata = (props: {lines: ArticleMetadataLine[]}) => {
  return (
    <div class="text-sm text-gray-600" data-testid="review-article-metadata">
      <p class="font-medium text-gray-700">Article metadata (sent to the model)</p>
      <Show when={props.lines.length > 0} fallback={<p>none available</p>}>
        <dl class="grid grid-cols-[auto_1fr] gap-x-3">
          <For each={props.lines}>
            {(line) => {
              return (
                <>
                  <dt class="text-gray-500">{line.label}</dt>
                  <dd class="break-words">{line.value}</dd>
                </>
              )
            }}
          </For>
        </dl>
      </Show>
    </div>
  )
}
