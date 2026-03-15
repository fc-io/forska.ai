import {createMutation, useQuery, useQueryClient} from '@tanstack/solid-query'
import {createEffect, createSignal, For, onCleanup, Show} from 'solid-js'

import {apiClient} from '../../../services/apiClient.ts'
import {handleApiResponse} from '../../../services/utils/handleApiResponse.ts'

type ArticleAdminSectionProps = {articleId: string}

type PdfFetchAttempt = {
  source: string
  tried: boolean
  success: boolean
  result?: {fullTextPDF: string; fullTextSource: string; fullTextOriginalFormat: string}
  reason?: string
  details?: string
}

type OriginalFullTextUrl = {
  url: string
  site: string | null
  availability: string | null
  documentStyle: string | null
  availabilityCode: string | null
}

const fetchArticleAdminInfo = async (articleId: string) => {
  const response = await apiClient.api.articles({id: articleId})['admin-info'].get()
  return handleApiResponse(response, 'Failed to load article tools')
}

export const ArticleAdminSection = (props: ArticleAdminSectionProps) => {
  const queryClient = useQueryClient()
  const [selectedFile, setSelectedFile] = createSignal<File | null>(null)
  const [isOpen, setIsOpen] = createSignal(true)

  const adminInfoQuery = useQuery(() => {
    return {
      queryKey: ['article-admin-info', props.articleId],
      queryFn: () => {
        return fetchArticleAdminInfo(props.articleId)
      },
      staleTime: 1000 * 30,
    }
  })

  const [prevConversionStatus, setPrevConversionStatus] = createSignal<string | null | undefined>(undefined)
  const [conversionJustCompleted, setConversionJustCompleted] = createSignal(false)

  createEffect(() => {
    const conversionStatus = adminInfoQuery.data?.article?.fullTextConversionStatus
    const prev = prevConversionStatus()

    if (prev === 'pending' && conversionStatus === 'success') {
      setConversionJustCompleted(true)
      void queryClient.invalidateQueries({queryKey: ['article-details', props.articleId]})
      void queryClient.invalidateQueries({queryKey: ['article-review-details']})
    }

    setPrevConversionStatus(conversionStatus)

    if (conversionStatus === 'pending') {
      const interval = setInterval(() => {
        void queryClient.invalidateQueries({queryKey: ['article-admin-info', props.articleId]})
      }, 3000)
      onCleanup(() => {
        return clearInterval(interval)
      })
    }
  })

  const fetchPdfMutation = createMutation(() => {
    return {
      mutationFn: async () => {
        const response = await apiClient.api.articles({id: props.articleId})['fetch-pdf'].post()
        return handleApiResponse(response, 'Failed to fetch PDF')
      },
      onSuccess: () => {
        // Invalidate the admin info query to refresh the data
        void queryClient.invalidateQueries({queryKey: ['article-admin-info', props.articleId]})
        // Also invalidate the main article query in case it's being used
        void queryClient.invalidateQueries({queryKey: ['article-details', props.articleId]})
        void queryClient.invalidateQueries({queryKey: ['article-review-details']})
      },
    }
  })

  const uploadPdfMutation = createMutation(() => {
    return {
      mutationFn: async (file: File): Promise<{success: boolean; fullTextPDF: string; message: string}> => {
        const response = await apiClient.api.articles({id: props.articleId})['upload-pdf'].post({pdf: file})
        return handleApiResponse(response, 'Failed to upload PDF')
      },
      onSuccess: () => {
        setSelectedFile(null)
        // Invalidate the admin info query to refresh the data
        void queryClient.invalidateQueries({queryKey: ['article-admin-info', props.articleId]})
        // Also invalidate the main article query in case it's being used
        void queryClient.invalidateQueries({queryKey: ['article-details', props.articleId]})
        void queryClient.invalidateQueries({queryKey: ['article-review-details']})
      },
    }
  })

  const convertPdfMutation = createMutation(() => {
    return {
      mutationFn: async () => {
        const response = await apiClient.api.articles({id: props.articleId})['convert-pdf'].post()
        return handleApiResponse(response, 'Failed to convert PDF')
      },
      onSuccess: () => {
        void queryClient.invalidateQueries({queryKey: ['article-admin-info', props.articleId]})
        void queryClient.invalidateQueries({queryKey: ['article-details', props.articleId]})
        void queryClient.invalidateQueries({queryKey: ['article-review-details']})
      },
    }
  })

  const handleFileChange = (event: Event) => {
    const target = event.target as HTMLInputElement
    const file = target.files?.[0] ?? null
    setSelectedFile(file)
  }

  const handleUpload = () => {
    const file = selectedFile()
    if (file) {
      uploadPdfMutation.mutate(file)
    }
  }

  const formatDate = (date: string | Date | null | undefined) => {
    if (!date) return 'Never'
    const d = typeof date === 'string' ? new Date(date) : date
    return d.toLocaleString()
  }

  const getAttemptStatusIcon = (attempt: PdfFetchAttempt) => {
    if (!attempt.tried) return '⏭️'
    if (attempt.success) return '✅'
    return '❌'
  }

  const getAttemptStatusClass = (attempt: PdfFetchAttempt) => {
    if (!attempt.tried) return 'bg-gray-100 text-gray-600'
    if (attempt.success) return 'bg-green-100 text-green-700'
    return 'bg-red-100 text-red-700'
  }

  return (
    <div class="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4">
      <div class="flex items-center justify-between gap-2 mb-3">
        <div class="flex items-center gap-2">
          <svg class="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <h3 class="text-sm font-semibold text-amber-800">Article Tools</h3>
        </div>

        <button
          type="button"
          class="p-1 rounded hover:bg-amber-100"
          aria-expanded={isOpen()}
          onClick={() => {
            setIsOpen(!isOpen())
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke-width="2"
            stroke="currentColor"
            class="w-4 h-4 text-amber-700 transition-transform duration-200"
            classList={{'rotate-90': isOpen()}}
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
        </button>
      </div>

      <Show when={isOpen()}>
        <Show when={adminInfoQuery.isLoading}>
          <div class="text-sm text-amber-700">Loading article tools...</div>
        </Show>

        <Show when={adminInfoQuery.isError}>
          <div class="text-sm text-red-600">Failed to load article tools</div>
        </Show>

        <Show when={adminInfoQuery.data?.article}>
          {(article) => {
            return (
              <div class="space-y-2">
                <div class="text-xs">
                  <span class="font-medium text-amber-800">Article ID:</span>
                  <span class="ml-2 font-mono text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded select-all">
                    {article().id}
                  </span>
                </div>

                <div class="text-xs">
                  <span class="font-medium text-amber-800">PDF Fetched At:</span>
                  <span class="ml-2 text-amber-700">{formatDate(article().fullTextFetchedAt)}</span>
                </div>

                <div class="text-xs">
                  <span class="font-medium text-amber-800">PDF Path:</span>
                  <Show
                    when={article().fullTextPDF}
                    fallback={<span class="ml-2 text-amber-600 italic">Not available</span>}
                  >
                    <span class="ml-2 font-mono text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded text-xs break-all">
                      {article().fullTextPDF}
                    </span>
                  </Show>
                </div>

                <div class="text-xs">
                  <span class="font-medium text-amber-800">PDF Source:</span>
                  <span class="ml-2 text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
                    {article().fullTextSource === 'user_upload'
                      ? 'Manual upload'
                      : article().fullTextSource
                        ? `Fetched (${article().fullTextSource})`
                        : 'Not available'}
                  </span>
                </div>

                <Show when={article().fullTextConversionStatus}>
                  <div class="text-xs">
                    <span class="font-medium text-amber-800">Conversion Status:</span>
                    <span
                      class={`ml-2 px-1.5 py-0.5 rounded text-xs ${
                        article().fullTextConversionStatus === 'success'
                          ? 'bg-green-100 text-green-700'
                          : article().fullTextConversionStatus === 'failed'
                            ? 'bg-red-100 text-red-700'
                            : 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {article().fullTextConversionStatus}
                    </span>
                  </div>
                </Show>

                <Show when={article().fullTextConversionError}>
                  <div class="text-xs">
                    <span class="font-medium text-amber-800">Conversion Error:</span>
                    <span class="ml-2 font-mono text-red-600 text-xs break-all">
                      {article().fullTextConversionError}
                    </span>
                  </div>
                </Show>

                <div class="pt-2 border-t border-amber-200 space-y-3">
                  {/* Fetch PDF Button */}
                  <div>
                    <div class="text-xs font-medium text-amber-800 mb-1">Fetch PDF from sources</div>
                    <button
                      onClick={() => {
                        return fetchPdfMutation.mutate()
                      }}
                      disabled={fetchPdfMutation.isPending}
                      class="w-full px-3 py-1.5 text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {fetchPdfMutation.isPending ? (
                        <span class="flex items-center justify-center gap-2">
                          <svg class="animate-spin h-3 w-3" viewBox="0 0 24 24">
                            <circle
                              class="opacity-25"
                              cx="12"
                              cy="12"
                              r="10"
                              stroke="currentColor"
                              stroke-width="4"
                              fill="none"
                            />
                            <path
                              class="opacity-75"
                              fill="currentColor"
                              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                            />
                          </svg>
                          Fetching PDF...
                        </span>
                      ) : (
                        'Fetch PDF Now'
                      )}
                    </button>

                    <Show when={fetchPdfMutation.isSuccess}>
                      <div class="mt-3 space-y-2">
                        {/* Overall result */}
                        <div
                          class={`text-xs ${fetchPdfMutation.data?.fullTextPDF ? 'text-green-600' : 'text-amber-700'}`}
                        >
                          {fetchPdfMutation.data?.fullTextPDF ? (
                            <>✅ PDF saved to: {fetchPdfMutation.data.fullTextPDF}</>
                          ) : (
                            <>⚠️ No PDF found from any source</>
                          )}
                        </div>

                        {/* Detailed attempts */}
                        <Show when={(fetchPdfMutation.data as {attempts?: PdfFetchAttempt[]})?.attempts?.length}>
                          <div class="bg-white/50 rounded p-2 mt-2">
                            <div class="text-xs font-medium text-amber-800 mb-1.5">Fetch Attempts:</div>
                            <div class="space-y-1.5">
                              <For each={(fetchPdfMutation.data as {attempts: PdfFetchAttempt[]}).attempts}>
                                {(attempt) => {
                                  return (
                                    <div class={`text-xs p-1.5 rounded ${getAttemptStatusClass(attempt)}`}>
                                      <div class="flex items-center gap-1.5">
                                        <span>{getAttemptStatusIcon(attempt)}</span>
                                        <span class="font-medium">{attempt.source}</span>
                                        <span class="text-xs opacity-75">
                                          {!attempt.tried ? '(skipped)' : attempt.success ? '(success)' : '(failed)'}
                                        </span>
                                      </div>
                                      <Show when={attempt.reason}>
                                        <div class="mt-0.5 pl-5 text-xs opacity-90">{attempt.reason}</div>
                                      </Show>
                                      <Show when={attempt.details}>
                                        <div class="mt-0.5 pl-5 text-xs opacity-75 font-mono break-all">
                                          {attempt.details}
                                        </div>
                                      </Show>
                                      <Show when={attempt.result?.fullTextPDF}>
                                        <div class="mt-0.5 pl-5 text-xs font-mono break-all">
                                          {attempt.result?.fullTextPDF}
                                        </div>
                                      </Show>
                                    </div>
                                  )
                                }}
                              </For>
                            </div>
                          </div>
                        </Show>

                        {/* Helpful fallback links from original_data */}
                        <Show
                          when={
                            !fetchPdfMutation.data?.fullTextPDF
                            && (fetchPdfMutation.data as {originalFullTextUrls?: OriginalFullTextUrl[]})
                              ?.originalFullTextUrls?.length
                          }
                        >
                          <div class="bg-white/50 rounded p-2 mt-2">
                            <div class="text-xs font-medium text-amber-800 mb-1.5">Original full-text URLs:</div>
                            <div class="space-y-1.5">
                              <For
                                each={
                                  (fetchPdfMutation.data as {originalFullTextUrls: OriginalFullTextUrl[]})
                                    .originalFullTextUrls
                                }
                              >
                                {(link) => {
                                  return (
                                    <div class="text-xs p-1.5 rounded bg-gray-100 text-gray-700">
                                      <div class="flex items-center gap-2">
                                        <span class="font-medium">{link.site ?? 'Link'}</span>
                                        <Show when={link.availability}>
                                          <span class="text-xs opacity-80">{link.availability}</span>
                                        </Show>
                                        <Show when={link.availabilityCode}>
                                          <span class="text-xs font-mono opacity-70">{link.availabilityCode}</span>
                                        </Show>
                                        <Show when={link.documentStyle}>
                                          <span class="text-xs font-mono opacity-70">{link.documentStyle}</span>
                                        </Show>
                                      </div>
                                      <a
                                        href={link.url}
                                        target="_blank"
                                        rel="noreferrer"
                                        class="mt-0.5 block text-xs font-mono break-all underline opacity-90 hover:opacity-100"
                                      >
                                        {link.url}
                                      </a>
                                    </div>
                                  )
                                }}
                              </For>
                            </div>
                          </div>
                        </Show>
                      </div>
                    </Show>

                    <Show when={fetchPdfMutation.isError}>
                      <div class="mt-2 text-xs text-red-600">✗ Failed to fetch PDF</div>
                    </Show>
                  </div>

                  {/* Upload PDF Section */}
                  <div class="pt-2 border-t border-amber-200">
                    <div class="text-xs font-medium text-amber-800 mb-1">Upload PDF manually</div>
                    <div class="flex gap-2">
                      <input
                        type="file"
                        accept=".pdf,application/pdf"
                        onChange={handleFileChange}
                        class="flex-1 text-xs file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-xs file:font-medium file:bg-amber-100 file:text-amber-700 hover:file:bg-amber-200 file:cursor-pointer cursor-pointer"
                      />
                      <button
                        onClick={handleUpload}
                        disabled={!selectedFile() || uploadPdfMutation.isPending}
                        class="px-3 py-1.5 text-xs font-medium text-white bg-purple-600 hover:bg-purple-700 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {uploadPdfMutation.isPending ? (
                          <span class="flex items-center gap-1">
                            <svg class="animate-spin h-3 w-3" viewBox="0 0 24 24">
                              <circle
                                class="opacity-25"
                                cx="12"
                                cy="12"
                                r="10"
                                stroke="currentColor"
                                stroke-width="4"
                                fill="none"
                              />
                              <path
                                class="opacity-75"
                                fill="currentColor"
                                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                              />
                            </svg>
                            Uploading...
                          </span>
                        ) : (
                          'Upload'
                        )}
                      </button>
                    </div>

                    <Show when={uploadPdfMutation.isSuccess}>
                      <div class="mt-2 text-xs text-green-600 break-all">
                        PDF uploaded successfully: {uploadPdfMutation.data?.fullTextPDF}
                      </div>
                    </Show>

                    <Show when={uploadPdfMutation.isError}>
                      <div class="mt-2 text-xs text-red-600">
                        ✗ Failed to upload PDF: {(uploadPdfMutation.error as Error)?.message}
                      </div>
                    </Show>
                  </div>

                  {/* Convert PDF Section */}
                  <div class="pt-2 border-t border-amber-200">
                    <div class="text-xs font-medium text-amber-800 mb-1">Convert PDF to text</div>
                    <button
                      onClick={() => {
                        return convertPdfMutation.mutate()
                      }}
                      disabled={
                        convertPdfMutation.isPending
                        || !article().fullTextPDF
                        || article().fullTextConversionStatus === 'pending'
                      }
                      class="w-full px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {convertPdfMutation.isPending ? (
                        <span class="flex items-center justify-center gap-2">
                          <svg class="animate-spin h-3 w-3" viewBox="0 0 24 24">
                            <circle
                              class="opacity-25"
                              cx="12"
                              cy="12"
                              r="10"
                              stroke="currentColor"
                              stroke-width="4"
                              fill="none"
                            />
                            <path
                              class="opacity-75"
                              fill="currentColor"
                              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                            />
                          </svg>
                          Starting conversion...
                        </span>
                      ) : (
                        'Convert PDF Now'
                      )}
                    </button>

                    <Show when={conversionJustCompleted() && article().fullTextConversionStatus === 'success'}>
                      <div class="mt-2 p-2 text-xs bg-green-100 text-green-700 rounded">
                        <div class="font-medium">Conversion completed successfully</div>
                        <div class="mt-1 opacity-90">
                          Full text is now available ({article().fullTextCharCount?.toLocaleString() ?? 'N/A'}{' '}
                          characters).
                        </div>
                      </div>
                    </Show>

                    <Show
                      when={
                        convertPdfMutation.isSuccess
                        && !conversionJustCompleted()
                        && article().fullTextConversionStatus === 'pending'
                      }
                    >
                      <div class="mt-2 p-2 text-xs bg-blue-100 text-blue-700 rounded">
                        <div class="font-medium">Conversion started</div>
                        <div class="mt-1 opacity-90">
                          This may take several minutes. Status will update automatically.
                        </div>
                      </div>
                    </Show>

                    <Show when={convertPdfMutation.isError}>
                      <div class="mt-2 text-xs text-red-600">
                        ✗ Failed to start conversion: {(convertPdfMutation.error as Error)?.message}
                      </div>
                    </Show>

                    <Show when={article().fullTextConversionStatus === 'pending'}>
                      <div class="mt-2 p-2 text-xs bg-blue-100 text-blue-700 rounded">
                        <div class="flex items-center gap-2">
                          <svg class="animate-spin h-3 w-3" viewBox="0 0 24 24">
                            <circle
                              class="opacity-25"
                              cx="12"
                              cy="12"
                              r="10"
                              stroke="currentColor"
                              stroke-width="4"
                              fill="none"
                            />
                            <path
                              class="opacity-75"
                              fill="currentColor"
                              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                            />
                          </svg>
                          <span class="font-medium">Conversion in progress...</span>
                        </div>
                        <div class="mt-1 opacity-90">Checking status every 3 seconds</div>
                      </div>
                    </Show>
                  </div>
                </div>
              </div>
            )
          }}
        </Show>
      </Show>
    </div>
  )
}
