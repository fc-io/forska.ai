import {For, Show} from 'solid-js'

import {getArticleSourceMetadataValue} from '../../../utils/articleSourceMetadata.ts'

type ReviewsCovidenceBadgesProps = {sourceMetadata?: unknown}

const getBadgeTitle = (props: {
  covidenceIds: string[]
  duplicateStudyRecordCount: number
  hasStudyDecisionConflict: boolean
}) => {
  const idText = props.covidenceIds.length > 0 ? `Covidence IDs: ${props.covidenceIds.join(', ')}` : 'No Covidence ID'
  const duplicateText = `Study group size: ${props.duplicateStudyRecordCount}`
  const conflictText = props.hasStudyDecisionConflict ? 'This study group has conflicting seeded decisions.' : null

  return [idText, duplicateText, conflictText]
    .filter((value): value is string => {
      return value !== null
    })
    .join(' ')
}

export const ReviewsCovidenceBadges = (props: ReviewsCovidenceBadgesProps) => {
  const covidence = () => {
    return getArticleSourceMetadataValue(props.sourceMetadata)?.covidence ?? null
  }

  const badges = () => {
    const metadata = covidence()

    if (!metadata) {
      return [] as Array<{className: string; label: string; title: string}>
    }

    return [
      metadata.hasStudyDecisionConflict
        ? {className: 'bg-rose-100 text-rose-800', label: 'Conflict', title: getBadgeTitle(metadata)}
        : null,
      metadata.hasDuplicateStudyRecords
        ? {
            className: 'bg-amber-100 text-amber-800',
            label:
              metadata.duplicateStudyRecordCount > 1 ? `Duplicate x${metadata.duplicateStudyRecordCount}` : 'Duplicate',
            title: getBadgeTitle(metadata),
          }
        : null,
    ].filter((value): value is {className: string; label: string; title: string} => {
      return value !== null
    })
  }

  return (
    <Show when={badges().length > 0}>
      <div class="mt-2 flex flex-wrap gap-2">
        <For each={badges()}>
          {(badge) => {
            return (
              <span
                class={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}
                title={badge.title}
              >
                {badge.label}
              </span>
            )
          }}
        </For>
      </div>
    </Show>
  )
}
