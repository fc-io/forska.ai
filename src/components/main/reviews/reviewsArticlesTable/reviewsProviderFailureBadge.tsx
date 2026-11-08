export const ReviewsProviderFailureBadge = (props: {failedPromptCodes: string | null; failedPromptCount: number}) => {
  return (
    <span
      class="inline-flex rounded px-1.5 py-0.5 text-xs font-medium bg-rose-100 text-rose-800"
      title={`The model call failed after retries (${props.failedPromptCodes ?? 'no failure code'}); resume the job to retry`}
    >
      {`${props.failedPromptCount} failed`}
    </span>
  )
}
