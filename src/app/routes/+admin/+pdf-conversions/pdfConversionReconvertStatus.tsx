import {Show} from 'solid-js'

export const PdfConversionReconvertStatus = (props: {
  clearedConvertedText: boolean | undefined
  errorMessage: string | undefined
  isError: boolean
  isSuccess: boolean
}) => {
  return (
    <>
      <Show when={props.isSuccess}>
        <div role="status" class="mb-4 p-4 rounded-md bg-green-50 border border-green-200">
          <p class="text-green-700">
            Cleared the failed conversion<Show when={props.clearedConvertedText}> and its old converted text</Show>. The
            conversion cron converts the PDF again only when the article is in a non-archived project with full text on.
          </p>
        </div>
      </Show>
      <Show when={props.isError}>
        <div role="alert" class="mb-4 p-4 rounded-md bg-red-50 border border-red-200">
          <p class="text-red-600">{props.errorMessage || 'Failed to reconvert article'}</p>
        </div>
      </Show>
    </>
  )
}
