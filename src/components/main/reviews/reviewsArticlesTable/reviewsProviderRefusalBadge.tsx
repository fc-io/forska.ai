export const ReviewsProviderRefusalBadge = (props: {refusedPromptCount: number}) => {
  return (
    <span
      class="inline-flex rounded px-1.5 py-0.5 text-xs font-medium bg-amber-100 text-amber-800"
      title={`The model refused ${props.refusedPromptCount} prompt(s); needs human screening`}
    >
      {`${props.refusedPromptCount} refused`}
    </span>
  )
}
