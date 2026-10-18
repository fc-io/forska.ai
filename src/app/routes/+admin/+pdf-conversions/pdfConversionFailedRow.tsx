import {Link} from '@tanstack/solid-router'
import {For, Show} from 'solid-js'

import {type apiClient} from '../../../../services/apiClient.ts'

type ConversionStatsResponse = Awaited<ReturnType<(typeof apiClient.api.articles)['conversion-stats']['get']>>
type FailedPdfConversion = NonNullable<ConversionStatsResponse['data']>['lastFailed'][number]

const getConversionDetails = (article: FailedPdfConversion) => {
  return [
    {label: 'Converter', value: article.converterKind},
    {label: 'Version', value: article.converterVersion},
    {label: 'Options hash', value: article.optionsHash},
    {label: 'Canonical', value: article.canonicalVersion},
    {label: 'Provider', value: article.providerKind},
    {label: 'Model', value: article.modelName},
  ]
}

export const PdfConversionFailedRow = (props: {
  article: FailedPdfConversion
  isReconvertDisabled: boolean
  isReconverting: boolean
  onReconvert: (articleId: string) => void
}) => {
  return (
    <li class="px-4 py-4 sm:px-6">
      <div class="flex items-center justify-between">
        <div class="truncate text-sm font-medium text-blue-600">
          <Link to="/articles/$id" params={{id: props.article.id}} class="hover:underline">
            {props.article.title}
          </Link>
        </div>
        <div class="ml-2 flex-shrink-0 flex items-center space-x-4">
          <span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-red-100 text-red-800">
            {props.article.attempts} attempts
          </span>
          <button
            onClick={() => {
              return props.onReconvert(props.article.id)
            }}
            disabled={props.isReconvertDisabled}
            class="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Show when={props.isReconverting} fallback="Reconvert">
              Reconverting...
            </Show>
          </button>
        </div>
      </div>
      <div class="mt-2 text-sm text-gray-500">
        <p class="truncate font-mono bg-gray-50 p-1 rounded text-xs">{props.article.error || 'Unknown error'}</p>
      </div>
      <div class="mt-2 flex flex-wrap gap-x-4 text-xs text-gray-500">
        <For each={getConversionDetails(props.article)}>
          {(detail) => {
            return (
              <span>
                {detail.label}: <span class="font-mono">{detail.value ?? '—'}</span>
              </span>
            )
          }}
        </For>
      </div>
      <div class="mt-2 text-xs text-gray-400">
        Last updated: {props.article.updatedAt ? new Date(props.article.updatedAt).toLocaleString() : 'Unknown'}
      </div>
    </li>
  )
}
