import {For, Show} from 'solid-js'

type CovidenceMatchTier = 'strong_identifier' | 'covidence_id' | 'reference_id' | 'title_year_first_author'
type CovidenceSameReviewRecordSample = {
  articleIds: string[]
  articleKey: string
  covidenceIds: string[]
  matchTier: CovidenceMatchTier | null
  referenceIds: string[]
  title: string | null
}
type CovidenceRouteShare = {
  dataSourceId: string | null
  dataSourceTitle: string | null
  importRoute: string
  matchedRecordCount: number
  share: number
}
export type CovidenceSameReviewAnalysis = {
  matchSummary: {
    ambiguous: CovidenceSameReviewRecordSample[]
    ambiguousCount: number
    baseImportRoute: string
    countsByTier: Record<CovidenceMatchTier, number>
    unmatched: CovidenceSameReviewRecordSample[]
    unmatchedCount: number
  } | null
  routeShares: CovidenceRouteShare[]
  strongIdentifierRecordCount: number
  suggestedBaseImportRoute: CovidenceRouteShare | null
}

const covidenceSameReviewPreviewLimit = 25
const covidenceMatchTierLabels: Record<CovidenceMatchTier, string> = {
  covidence_id: 'Covidence #',
  reference_id: 'Ref',
  strong_identifier: 'Existing DOI/PMID',
  title_year_first_author: 'Title, year and first author',
}
const covidenceMatchTiers: CovidenceMatchTier[] = [
  'strong_identifier',
  'covidence_id',
  'reference_id',
  'title_year_first_author',
]

const getRouteShareLabel = (routeShare: CovidenceRouteShare) => {
  return `${routeShare.dataSourceTitle ?? routeShare.importRoute} · ${(routeShare.share * 100).toFixed(1)} %`
}

const getRecordSampleLabel = (record: CovidenceSameReviewRecordSample) => {
  return `${record.title ?? 'Untitled'} · ${[...record.covidenceIds, ...record.referenceIds].join(', ') || record.articleKey}`
}

const CovidenceSameReviewRecordList = (props: {records: CovidenceSameReviewRecordSample[]; title: string}) => {
  return (
    <Show when={props.records.length > 0}>
      <details class="rounded-2xl border border-stone-200 bg-stone-50 p-3 text-xs text-stone-600">
        <summary class="cursor-pointer font-medium text-stone-800">{props.title}</summary>
        <ul class="mt-2 space-y-1">
          <For each={props.records.slice(0, covidenceSameReviewPreviewLimit)}>
            {(record) => {
              return <li>{getRecordSampleLabel(record)}</li>
            }}
          </For>
        </ul>
      </details>
    </Show>
  )
}

export const CovidenceSameReviewPanel = (props: {
  isAnalyzing: boolean
  onSelectBaseImportRoute: (baseImportRoute: string | null) => void
  sameReview: CovidenceSameReviewAnalysis | undefined
  selectedBaseImportRoute: string | null
}) => {
  const selectedRouteShare = () => {
    return (
      props.sameReview?.routeShares.find((routeShare) => {
        return routeShare.importRoute === props.selectedBaseImportRoute
      }) ?? null
    )
  }
  const currentMatchSummary = () => {
    const matchSummary = props.sameReview?.matchSummary ?? null

    return matchSummary && matchSummary.baseImportRoute === props.selectedBaseImportRoute ? matchSummary : null
  }
  const defaultBaseImportRoute = () => {
    return (
      props.sameReview?.suggestedBaseImportRoute?.importRoute ?? props.sameReview?.routeShares[0]?.importRoute ?? null
    )
  }

  return (
    <Show when={props.sameReview}>
      <div class="space-y-3 rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
        <p class="text-xs font-medium uppercase tracking-wide text-amber-800">Same review</p>
        <Show
          when={(props.sameReview?.routeShares.length ?? 0) > 0}
          fallback={
            <p class="text-sm text-stone-600">
              No earlier Covidence import holds these DOI/PMID records. Every record imports as a new article.
            </p>
          }
        >
          <label class="flex items-start gap-3 text-sm text-stone-800">
            <input
              type="checkbox"
              class="mt-1"
              checked={props.selectedBaseImportRoute !== null}
              disabled={props.isAnalyzing}
              onChange={(event) => {
                props.onSelectBaseImportRoute(event.currentTarget.checked ? defaultBaseImportRoute() : null)
              }}
            />
            <span>
              Same review as{' '}
              <strong>
                {selectedRouteShare()?.dataSourceTitle
                  ?? props.sameReview?.suggestedBaseImportRoute?.dataSourceTitle
                  ?? 'an earlier import'}
              </strong>
              : reuse its articles (and their judgments) by DOI/PMID, Covidence #, Ref, then title + year + first
              author. Clear it to import every unmatched record as a new article.
            </span>
          </label>
          <Show when={(props.sameReview?.routeShares.length ?? 0) > 1 && props.selectedBaseImportRoute !== null}>
            <select
              class="w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm"
              value={props.selectedBaseImportRoute ?? ''}
              disabled={props.isAnalyzing}
              onChange={(event) => {
                props.onSelectBaseImportRoute(event.currentTarget.value || null)
              }}
            >
              <For each={props.sameReview?.routeShares ?? []}>
                {(routeShare) => {
                  return <option value={routeShare.importRoute}>{getRouteShareLabel(routeShare)}</option>
                }}
              </For>
            </select>
          </Show>
          <Show when={selectedRouteShare()}>
            {(routeShare) => {
              return (
                <p class="text-xs text-stone-600">
                  {routeShare().matchedRecordCount.toLocaleString()} of{' '}
                  {(props.sameReview?.strongIdentifierRecordCount ?? 0).toLocaleString()} DOI/PMID records already
                  belong to that import ({(routeShare().share * 100).toFixed(1)} %).
                </p>
              )
            }}
          </Show>
          <Show when={props.selectedBaseImportRoute !== null && !currentMatchSummary()}>
            <p class="text-xs text-stone-500">
              {props.isAnalyzing ? 'Matching records...' : 'Analyze to preview matches.'}
            </p>
          </Show>
          <Show when={currentMatchSummary()}>
            {(matchSummary) => {
              return (
                <div class="space-y-3">
                  <div class="grid gap-2 sm:grid-cols-3">
                    <For each={covidenceMatchTiers}>
                      {(tier) => {
                        return (
                          <div class="rounded-xl bg-white p-3">
                            <p class="text-[11px] uppercase tracking-wide text-stone-500">
                              {covidenceMatchTierLabels[tier]}
                            </p>
                            <p class="text-lg font-semibold text-stone-900">
                              {matchSummary().countsByTier[tier].toLocaleString()}
                            </p>
                          </div>
                        )
                      }}
                    </For>
                    <div class="rounded-xl bg-white p-3">
                      <p class="text-[11px] uppercase tracking-wide text-stone-500">New articles</p>
                      <p class="text-lg font-semibold text-stone-900">
                        {matchSummary().unmatchedCount.toLocaleString()}
                      </p>
                    </div>
                    <div class="rounded-xl bg-white p-3">
                      <p class="text-[11px] uppercase tracking-wide text-stone-500">Ambiguous, not imported</p>
                      <p class="text-lg font-semibold text-red-700">{matchSummary().ambiguousCount.toLocaleString()}</p>
                    </div>
                  </div>
                  <CovidenceSameReviewRecordList
                    records={matchSummary().ambiguous}
                    title={`Ambiguous records (${matchSummary().ambiguousCount.toLocaleString()})`}
                  />
                  <CovidenceSameReviewRecordList
                    records={matchSummary().unmatched}
                    title={`Records that become new articles (${matchSummary().unmatchedCount.toLocaleString()})`}
                  />
                </div>
              )
            }}
          </Show>
        </Show>
      </div>
    </Show>
  )
}
