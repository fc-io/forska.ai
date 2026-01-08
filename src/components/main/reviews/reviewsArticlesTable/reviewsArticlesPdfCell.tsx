import {format} from 'date-fns'
import {createMemo, Match, Show, splitProps, Switch} from 'solid-js'

type OriginalFullTextUrl = {
  url: string
  site: string | null
  availability: string | null
  availabilityCode: string | null
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getStringField = (value: Record<string, unknown>, key: string) => {
  const candidate = value[key]
  return typeof candidate === 'string' ? candidate : null
}

const getOriginalFullTextUrls = (originalData: unknown): OriginalFullTextUrl[] => {
  const fullTextUrlList = isRecord(originalData) ? originalData.fullTextUrlList : null
  const fullTextUrl = isRecord(fullTextUrlList) ? fullTextUrlList.fullTextUrl : null
  const entries = Array.isArray(fullTextUrl) ? fullTextUrl : fullTextUrl ? [fullTextUrl] : []

  return entries
    .map((entry): OriginalFullTextUrl | null => {
      const record = isRecord(entry) ? entry : null
      const url = record ? getStringField(record, 'url') : null

      return url
        ? {
            url,
            site: record ? getStringField(record, 'site') : null,
            availability: record ? getStringField(record, 'availability') : null,
            availabilityCode: record ? getStringField(record, 'availabilityCode') : null,
          }
        : null
    })
    .filter((v): v is OriginalFullTextUrl => {
      return v !== null
    })
    .slice(0, 25)
}

const isSubscriptionRequired = (url: OriginalFullTextUrl) => {
  const code = url.availabilityCode ?? ''
  const availability = (url.availability ?? '').toLowerCase()
  return code === 'S' || availability.includes('subscription')
}

const toValidDate = (value: unknown): Date | null => {
  const candidate =
    value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null
  const time = candidate ? candidate.getTime() : NaN
  return Number.isFinite(time) ? candidate : null
}

export const ReviewsArticlesPdfCell = (props: {
  fullTextPDF: unknown
  fullTextFetchedAt?: unknown
  fullTextConversionStatus?: unknown
  originalData?: unknown
}) => {
  const [local] = splitProps(props, ['fullTextPDF', 'fullTextFetchedAt', 'fullTextConversionStatus', 'originalData'])
  const view = createMemo(() => {
    const pdfValue = local.fullTextPDF
    const pdf = typeof pdfValue === 'string' ? pdfValue : ''
    const hasPdfField = pdfValue !== undefined
    const fetchedAt = toValidDate(local.fullTextFetchedAt)
    const fetchedAtText = fetchedAt ? format(fetchedAt, 'yyyy-MM-dd HH:mm') : null
    const conversionStatusValue = local.fullTextConversionStatus
    const conversionStatus = typeof conversionStatusValue === 'string' ? conversionStatusValue.trim() : ''
    const isConverted = conversionStatus.toLowerCase() === 'success'
    const subscriptionRequiredFullTextUrls = getOriginalFullTextUrls(local.originalData).filter(isSubscriptionRequired)
    const subscriptionText = subscriptionRequiredFullTextUrls[0]?.site
      ? `Requires subscription (${subscriptionRequiredFullTextUrls[0]?.site ?? ''})`
      : subscriptionRequiredFullTextUrls.length
        ? 'Requires subscription'
        : null
    const hasPdf = Boolean(pdf)
    const showNoPdf = !hasPdf && (hasPdfField || Boolean(fetchedAtText) || Boolean(subscriptionText))

    return {hasPdf, pdf, fetchedAtText, isConverted, subscriptionText, showNoPdf}
  })

  return (
    <Switch fallback={<span class="text-gray-400">—</span>}>
      <Match when={view().hasPdf}>
        <a
          href={view().pdf.startsWith('/') ? view().pdf : `/${view().pdf}`}
          target="_blank"
          rel="noopener noreferrer"
          class="px-1.5 py-0.5 text-xs rounded bg-green-100 text-green-800"
          title={view().isConverted ? 'Open converted PDF' : 'Open PDF'}
        >
          {view().isConverted ? 'PDF Converted' : 'PDF'}
        </a>
      </Match>
      <Match when={view().showNoPdf}>
        <div class="flex flex-col gap-1">
          <span
            class={`px-1.5 py-0.5 text-xs rounded ${
              view().fetchedAtText ? 'bg-yellow-100 text-yellow-800' : 'bg-gray-100 text-gray-700'
            }`}
            title={view().fetchedAtText ? `Fetched at ${view().fetchedAtText} (no PDF available)` : 'No PDF available'}
          >
            No PDF
          </span>
          <Show when={view().fetchedAtText}>
            <span class="text-[10px] text-gray-500">Fetched: {view().fetchedAtText}</span>
          </Show>
          <Show when={view().subscriptionText}>
            <span class="text-[10px] text-amber-700">{view().subscriptionText}</span>
          </Show>
        </div>
      </Match>
    </Switch>
  )
}
