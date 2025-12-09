import {Link} from '@tanstack/solid-router'
import type {JSX} from 'solid-js'

interface ReviewsTabsProps {
  projectId: string
  active: 'assessed' | 'assessedBoth' | 'assessedHuman' | 'unassessed'
}

export const ReviewsTabs = (props: ReviewsTabsProps): JSX.Element => {
  const base = 'px-4 py-2 border-b-2'
  const inactive = 'text-gray-600 hover:text-gray-800 border-transparent'
  const active = 'text-blue-700 border-blue-600 font-semibold'

  return (
    <div class="mb-4 border-b border-gray-200">
      <nav class="-mb-px flex gap-4" aria-label="Tabs">
        <Link
          to="/projects/$id/reviews-llm"
          params={{id: props.projectId}}
          class={`${base} ${props.active === 'assessed' ? active : inactive}`}
        >
          Assessed by LLM
        </Link>
        <Link
          to="/projects/$id/reviews-human"
          params={{id: props.projectId}}
          class={`${base} ${props.active === 'assessedHuman' ? active : inactive}`}
        >
          Assessed by Human
        </Link>
        <Link
          to="/projects/$id/reviews-both"
          params={{id: props.projectId}}
          class={`${base} ${props.active === 'assessedBoth' ? active : inactive}`}
        >
          Assessed by Both
        </Link>
        <Link
          to="/projects/$id/reviews-unassessed"
          params={{id: props.projectId}}
          class={`${base} ${props.active === 'unassessed' ? active : inactive}`}
        >
          Unassessed
        </Link>
      </nav>
    </div>
  )
}
