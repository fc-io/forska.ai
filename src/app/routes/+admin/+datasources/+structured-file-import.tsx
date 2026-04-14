import {createMutation} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {createMemo, createSignal, For, Show} from 'solid-js'

import {Button} from '../../../../components/ui/button'
import {apiClient} from '../../../../services/apiClient.ts'
import {handleApiResponse} from '../../../../services/utils/handleApiResponse.ts'
import {postFormDataToApi} from '../../../utils/postFormDataToApi.ts'

type StructuredFileFormat = 'json' | 'xml'
type StructuredBoundaryCandidate = {
  pointer: string
  displayPath: string
  count: number
  sampleKeys: string[]
  samplePreview: string
}
type StructuredFileUpload = {assetPath: string; sourceFileName: string; format: StructuredFileFormat}
type StructuredFileAnalyzeResponse = {data: {upload: StructuredFileUpload; candidates: StructuredBoundaryCandidate[]}}
type StructuredFileCreateResponse = {
  success: boolean
  data: {dataSource: {id: string}; stats: {itemCount: number; importedCount: number}}
}

const analyzeStructuredFile = async (file: File) => {
  const formData = new FormData()
  formData.append('file', file)
  const result = await postFormDataToApi<StructuredFileAnalyzeResponse>({
    errorMessage: 'Failed to analyze file',
    formData,
    path: '/api/datasources/import/structured-file-analyze',
  })

  return result.data
}

const createStructuredFileImport = async (params: {
  title: string
  description: string
  upload: StructuredFileUpload
  candidate: StructuredBoundaryCandidate
}) => {
  const response = await apiClient.api.datasources.import['structured-file-create'].post({
    assetPath: params.upload.assetPath,
    boundaryDisplayPath: params.candidate.displayPath,
    boundaryPointer: params.candidate.pointer,
    description: params.description.trim() || undefined,
    format: params.upload.format,
    sourceFileName: params.upload.sourceFileName,
    title: params.title,
  })

  return handleApiResponse<StructuredFileCreateResponse>(response, 'Failed to import structured file')
}

const AdminStructuredFileImport = () => {
  const navigate = useNavigate()
  const [title, setTitle] = createSignal('')
  const [description, setDescription] = createSignal('')
  const [selectedFile, setSelectedFile] = createSignal<File | null>(null)
  const [analysis, setAnalysis] = createSignal<{
    upload: StructuredFileUpload
    candidates: StructuredBoundaryCandidate[]
  } | null>(null)
  const [selectedBoundaryPointer, setSelectedBoundaryPointer] = createSignal('')
  const [pageError, setPageError] = createSignal('')

  const analyzeMutation = createMutation(() => {
    return {
      mutationFn: analyzeStructuredFile,
      onSuccess: (data) => {
        setAnalysis(data)
        setSelectedBoundaryPointer(data.candidates[0]?.pointer ?? '')
      },
    }
  })

  const createImportMutation = createMutation(() => {
    return {
      mutationFn: createStructuredFileImport,
      onSuccess: (result) => {
        void navigate({params: {id: result.data.dataSource.id}, to: '/admin/datasources/$id/edit'})
      },
    }
  })

  const selectedCandidate = createMemo(() => {
    return (
      analysis()?.candidates.find((candidate) => {
        return candidate.pointer === selectedBoundaryPointer()
      }) ?? null
    )
  })

  const handleFileChange = (event: Event) => {
    const nextFile = event.currentTarget instanceof HTMLInputElement ? (event.currentTarget.files?.[0] ?? null) : null
    setSelectedFile(nextFile)
    setAnalysis(null)
    setSelectedBoundaryPointer('')
    setPageError('')
  }

  const handleAnalyze = () => {
    const file = selectedFile()

    if (!file) {
      setPageError('Choose a JSON or XML file first')
      return
    }

    setPageError('')
    analyzeMutation.mutate(file)
  }

  const handleImport = () => {
    const upload = analysis()?.upload ?? null
    const candidate = selectedCandidate()
    const trimmedTitle = title().trim()

    if (!trimmedTitle) {
      setPageError('Title is required')
      return
    }

    if (!upload || !candidate) {
      setPageError('Analyze the file and pick a boundary first')
      return
    }

    setPageError('')
    createImportMutation.mutate({candidate, description: description(), title: trimmedTitle, upload})
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6">
      <div class="max-w-5xl mx-auto space-y-6">
        <div class="bg-white border border-gray-200 rounded-lg shadow-sm p-6">
          <div class="mb-4 flex items-center justify-between gap-4">
            <div>
              <h1 class="text-2xl font-bold text-gray-900">Import XML / JSON</h1>
              <p class="text-sm text-gray-600 mt-1">
                Upload a structured file, inspect repeating boundaries, then import one boundary as articles.
              </p>
            </div>
            <Link to="/admin/datasources" class="text-sm text-blue-600 hover:text-blue-800">
              Back to Data Sources
            </Link>
          </div>

          <div class="grid gap-6 lg:grid-cols-2">
            <div class="space-y-4">
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-2">Title</label>
                <input
                  type="text"
                  value={title()}
                  onInput={(event) => {
                    setTitle(event.currentTarget.value)
                  }}
                  class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Clinical export March 2026"
                />
              </div>

              <div>
                <label class="block text-sm font-medium text-gray-700 mb-2">Description</label>
                <textarea
                  value={description()}
                  onInput={(event) => {
                    setDescription(event.currentTarget.value)
                  }}
                  rows={4}
                  class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Optional notes about the uploaded file"
                />
              </div>

              <div>
                <label class="block text-sm font-medium text-gray-700 mb-2">File</label>
                <input
                  type="file"
                  accept=".json,.xml,application/json,text/xml,application/xml"
                  onChange={handleFileChange}
                  class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 file:mr-3 file:px-3 file:py-2 file:border-0 file:bg-blue-50 file:text-blue-700 file:rounded-md"
                />
                <Show when={selectedFile()}>
                  <p class="text-xs text-gray-500 mt-2">
                    Selected: {selectedFile()?.name} · {(selectedFile()?.size ?? 0).toLocaleString()} bytes
                  </p>
                </Show>
              </div>

              <div class="flex items-center gap-3">
                <Button type="button" onClick={handleAnalyze} disabled={!selectedFile() || analyzeMutation.isPending}>
                  {analyzeMutation.isPending ? 'Analyzing…' : 'Analyze file'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleImport}
                  disabled={!analysis() || !selectedCandidate() || createImportMutation.isPending}
                >
                  {createImportMutation.isPending ? 'Importing…' : 'Import selected boundary'}
                </Button>
              </div>

              <Show when={pageError || analyzeMutation.isError || createImportMutation.isError}>
                <div class="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {pageError()
                    || (analyzeMutation.error instanceof Error ? analyzeMutation.error.message : '')
                    || (createImportMutation.error instanceof Error ? createImportMutation.error.message : '')}
                </div>
              </Show>

              <Show when={analysis()}>
                <div class="rounded-md border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
                  <p>
                    Stored file: <span class="font-medium">{analysis()?.upload.sourceFileName}</span>
                  </p>
                  <p>
                    Format: <span class="font-medium uppercase">{analysis()?.upload.format}</span>
                  </p>
                  <p>
                    Candidates found: <span class="font-medium">{analysis()?.candidates.length}</span>
                  </p>
                </div>
              </Show>
            </div>

            <div class="bg-gray-50 border border-gray-200 rounded-lg p-4 min-h-[24rem]">
              <h2 class="text-lg font-semibold text-gray-900 mb-3">Repeating boundaries</h2>
              <Show when={!analysis() && !analyzeMutation.isPending}>
                <p class="text-sm text-gray-500">Analyze a file to see candidate boundaries.</p>
              </Show>
              <Show when={analyzeMutation.isPending}>
                <p class="text-sm text-gray-500">Inspecting JSON/XML structure…</p>
              </Show>
              <Show when={analysis()}>
                <div class="space-y-3">
                  <For each={analysis()?.candidates ?? []}>
                    {(candidate) => {
                      const isSelected = () => {
                        return selectedBoundaryPointer() === candidate.pointer
                      }

                      return (
                        <label
                          class={`block rounded-lg border p-4 cursor-pointer transition ${
                            isSelected()
                              ? 'border-blue-500 bg-white shadow-sm'
                              : 'border-gray-200 bg-white hover:border-gray-300'
                          }`}
                        >
                          <div class="flex items-start gap-3">
                            <input
                              type="radio"
                              name="boundary"
                              checked={isSelected()}
                              onChange={() => {
                                setSelectedBoundaryPointer(candidate.pointer)
                              }}
                              class="mt-1"
                            />
                            <div class="min-w-0 flex-1 space-y-2">
                              <div class="flex flex-wrap items-center gap-2">
                                <span class="font-mono text-sm text-gray-900 break-all">{candidate.displayPath}</span>
                                <span class="text-xs rounded-full bg-blue-100 text-blue-700 px-2 py-0.5">
                                  {candidate.count.toLocaleString()} items
                                </span>
                              </div>
                              <Show when={candidate.sampleKeys.length > 0}>
                                <p class="text-xs text-gray-600">Keys: {candidate.sampleKeys.join(', ')}</p>
                              </Show>
                              <div class="space-y-1">
                                <p class="text-xs font-medium text-gray-700">Example element</p>
                                <pre class="max-h-80 overflow-auto text-xs text-gray-600 whitespace-pre-wrap break-words bg-gray-50 rounded-md p-3 border border-gray-100">
                                  {candidate.samplePreview}
                                </pre>
                              </div>
                            </div>
                          </div>
                        </label>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/admin/datasources/structured-file-import')({
  component: AdminStructuredFileImport,
})
