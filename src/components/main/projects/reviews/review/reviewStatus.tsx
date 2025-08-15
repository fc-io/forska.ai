type ReviewStatusProps = {
  review:
    | {
        reviewedTitle?: boolean | null
        reviewedAbstract?: boolean | null
        reviewedIntro?: boolean | null
        reviewedMethod?: boolean | null
        reviewedResults?: boolean | null
        reviewedDiscussion?: boolean | null
      }
    | undefined
}

const ReviewStatusItem = (props: {
  label: string
  reviewed?: boolean | null
}) => {
  return (
    <div>
      <span class="font-semibold">{props.label}: </span>
      <span class={props.reviewed ? 'text-green-600' : 'text-gray-400'}>
        {props.reviewed ? '✓ Reviewed' : 'Not reviewed'}
      </span>
    </div>
  )
}

export const ReviewStatus = (props: ReviewStatusProps) => {
  return (
    <div class="p-6 bg-white rounded-lg shadow">
      <h2 class="text-xl font-bold mb-4">Review Status</h2>
      <div class="grid grid-cols-2 md:grid-cols-3 gap-4">
        <ReviewStatusItem
          label="Title"
          reviewed={props.review?.reviewedTitle}
        />
        <ReviewStatusItem
          label="Abstract"
          reviewed={props.review?.reviewedAbstract}
        />
        <ReviewStatusItem
          label="Introduction"
          reviewed={props.review?.reviewedIntro}
        />
        <ReviewStatusItem
          label="Method"
          reviewed={props.review?.reviewedMethod}
        />
        <ReviewStatusItem
          label="Results"
          reviewed={props.review?.reviewedResults}
        />
        <ReviewStatusItem
          label="Discussion"
          reviewed={props.review?.reviewedDiscussion}
        />
      </div>
    </div>
  )
}