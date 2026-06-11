import {useMutation, useQuery} from '@tanstack/solid-query'
import {createEffect, createMemo, createSignal, For, Show} from 'solid-js'

import {getApiRequestUrl} from '../../../app/utils/getApiRequestUrl.ts'
import {apiClient} from '../../../services/apiClient.ts'
import {handleApiResponse} from '../../../services/utils/handleApiResponse.ts'
import {Button} from '../../ui/button'

type ProjectTransferExportPendingStatus = 'assembling' | 'packaging' | 'queued'
type ProjectTransferExportProgress = Record<string, unknown> & {percent?: number | null}
type ProjectTransferExportPendingSession = {
  downloadUrl?: string
  expiresAt: string
  exportId: string
  filename?: string
  progress: ProjectTransferExportProgress | null
  status: ProjectTransferExportPendingStatus
}
type ProjectTransferExportReadySession = {
  byteLength: number
  checksumSha256: string
  downloadUrl: string
  expiresAt: string
  exportId: string
  filename: string
  packageFingerprint: string
  progress: ProjectTransferExportProgress | null
  status: 'ready'
}
type ProjectTransferExportSession = ProjectTransferExportPendingSession | ProjectTransferExportReadySession
type ProjectTransferExportStartResult =
  | {session: ProjectTransferExportSession; status: 'session'}
  | {status: 'downloaded'}
type ProjectTransferRawArticleProvenanceMode = 'auto' | 'include' | 'omit'
type ProjectTransferExportStartInput = {
  projectId: string
  rawArticleProvenanceMode: ProjectTransferRawArticleProvenanceMode
}

type ProjectTransferExportActionProps = {align?: 'end' | 'start'; class?: string; projectId: string}

const rawArticleProvenanceModeOptions: Array<{label: string; value: ProjectTransferRawArticleProvenanceMode}> = [
  {label: 'Auto', value: 'auto'},
  {label: 'Include raw', value: 'include'},
  {label: 'Omit raw', value: 'omit'},
]

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}

const getStringValue = (record: Record<string, unknown>, key: string) => {
  const value = record[key]

  return typeof value === 'string' ? value : null
}

const getDateStringValue = (record: Record<string, unknown>, key: string) => {
  const value = record[key]

  return typeof value === 'string'
    ? value
    : value instanceof Date && !Number.isNaN(value.getTime())
      ? value.toISOString()
      : null
}

const getNumberValue = (record: Record<string, unknown>, key: string) => {
  const value = record[key]

  return typeof value === 'number' ? value : null
}

const getRecordKeys = (value: unknown) => {
  return isRecord(value) ? Object.keys(value).sort().join(',') : null
}

const getInvalidProjectTransferExportSessionMessage = (value: unknown, errorMessage: string) => {
  const keys = getRecordKeys(value)
  const dataKeys = isRecord(value) && 'data' in value ? getRecordKeys(value.data) : null
  const status = isRecord(value) && 'status' in value ? String(value.status) : null

  return keys === null
    ? `${errorMessage}: ${typeof value}`
    : `${errorMessage}: keys=${keys || 'none'}${status === null ? '' : ` status=${status}`}${dataKeys === null ? '' : ` dataKeys=${dataKeys || 'none'}`}`
}

const isProjectTransferExportPendingStatus = (value: unknown): value is ProjectTransferExportPendingStatus => {
  return value === 'assembling' || value === 'packaging' || value === 'queued'
}

const getProjectTransferExportProgress = (value: unknown): ProjectTransferExportProgress | null => {
  return isRecord(value) ? (value as ProjectTransferExportProgress) : null
}

const getProjectTransferExportPendingSession = (
  value: Record<string, unknown>,
): ProjectTransferExportPendingSession | null => {
  const exportId = getStringValue(value, 'exportId')
  const expiresAt = getDateStringValue(value, 'expiresAt')
  const status = value.status

  return exportId !== null && expiresAt !== null && isProjectTransferExportPendingStatus(status)
    ? {
        downloadUrl: getStringValue(value, 'downloadUrl') ?? undefined,
        expiresAt,
        exportId,
        filename: getStringValue(value, 'filename') ?? undefined,
        progress: getProjectTransferExportProgress(value.progress),
        status,
      }
    : null
}

const getProjectTransferExportReadySession = (
  value: Record<string, unknown>,
): ProjectTransferExportReadySession | null => {
  const byteLength = getNumberValue(value, 'byteLength')
  const checksumSha256 = getStringValue(value, 'checksumSha256')
  const downloadUrl = getStringValue(value, 'downloadUrl')
  const expiresAt = getDateStringValue(value, 'expiresAt')
  const exportId = getStringValue(value, 'exportId')
  const filename = getStringValue(value, 'filename')
  const packageFingerprint = getStringValue(value, 'packageFingerprint')

  return value.status === 'ready'
    && byteLength !== null
    && checksumSha256 !== null
    && downloadUrl !== null
    && expiresAt !== null
    && exportId !== null
    && filename !== null
    && packageFingerprint !== null
    ? {
        byteLength,
        checksumSha256,
        downloadUrl,
        expiresAt,
        exportId,
        filename,
        packageFingerprint,
        progress: getProjectTransferExportProgress(value.progress),
        status: 'ready',
      }
    : null
}

const parseProjectTransferExportSession = (value: unknown, errorMessage: string): ProjectTransferExportSession => {
  if (!isRecord(value)) {
    throw new Error(getInvalidProjectTransferExportSessionMessage(value, errorMessage))
  }

  const pendingSession = getProjectTransferExportPendingSession(value)
  const readySession = getProjectTransferExportReadySession(value)

  return (
    pendingSession
    ?? readySession
    ?? (() => {
      throw new Error(getInvalidProjectTransferExportSessionMessage(value, errorMessage))
    })()
  )
}

const getEnvelopeError = (value: unknown) => {
  return isRecord(value) && typeof value.error === 'string' ? value.error : null
}

const getEnvelopeData = (value: unknown) => {
  return isRecord(value) && 'data' in value ? value.data : null
}

const getProjectTransferExportSessionPayload = (value: unknown): unknown => {
  return isRecord(value) && 'data' in value && !('exportId' in value) && (value.error === null || !('error' in value))
    ? getProjectTransferExportSessionPayload(value.data)
    : value
}

const readJsonResponseBody = async (response: Response): Promise<unknown> => {
  return response.json().catch(() => {
    return null
  }) as Promise<unknown>
}

const getErrorMessage = (error: unknown, fallback: string) => {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback
}

const getHeaderFilename = (contentDisposition: string | null) => {
  const filenameStarMatch = contentDisposition?.match(/filename\*=UTF-8''([^;]+)/i)
  const filenameMatch = contentDisposition?.match(/filename="?([^";]+)"?/i)
  const filename = filenameStarMatch?.[1] ?? filenameMatch?.[1] ?? null

  return filename && filename.trim().length > 0 ? decodeURIComponent(filename.trim()) : null
}

const getProjectTransferPackageFilename = (response: Response, fallbackFilename: string) => {
  return getHeaderFilename(response.headers.get('Content-Disposition')) ?? fallbackFilename
}

const isProjectTransferPackageResponse = (response: Response) => {
  return response.headers.get('content-type')?.toLowerCase().includes('application/zip') ?? false
}

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

const downloadProjectTransferPackageResponse = async (response: Response, fallbackFilename: string) => {
  const filename = getProjectTransferPackageFilename(response, fallbackFilename)
  const blob = await response.blob()
  downloadBlob(blob, filename)
}

export const getProjectTransferExportRequestPath = (projectId: string) => {
  return `/api/projects/${encodeURIComponent(projectId)}/export-project`
}

export const getProjectTransferExportRequestUrl = (
  projectId: string,
  locationOrigin?: string | null,
  desktopApiOrigin?: string | null,
) => {
  return getApiRequestUrl(getProjectTransferExportRequestPath(projectId), locationOrigin, desktopApiOrigin)
}

export const getProjectTransferDownloadRequestUrl = (
  downloadUrl: string,
  locationOrigin?: string | null,
  desktopApiOrigin?: string | null,
) => {
  return /^https?:\/\//i.test(downloadUrl)
    ? downloadUrl
    : getApiRequestUrl(downloadUrl, locationOrigin, desktopApiOrigin)
}

export const fetchProjectTransferExportSession = async (exportId: string): Promise<ProjectTransferExportSession> => {
  const response = await apiClient.api.projects.export({exportId}).get()
  const data = handleApiResponse<unknown>(response, 'Failed to fetch project transfer export status')

  return parseProjectTransferExportSession(
    getProjectTransferExportSessionPayload(data),
    'Invalid project transfer export status response',
  )
}

const readProjectTransferExportSessionResponse = async (
  response: Response,
  errorMessage: string,
): Promise<ProjectTransferExportSession> => {
  const body = await readJsonResponseBody(response)
  const error = getEnvelopeError(body)
  const data = getEnvelopeData(body)

  if (!response.ok || error !== null) {
    throw new Error(error ?? errorMessage)
  }

  return parseProjectTransferExportSession(data, errorMessage)
}

const startProjectTransferExport = async (
  input: ProjectTransferExportStartInput,
): Promise<ProjectTransferExportStartResult> => {
  const response = await fetch(getProjectTransferExportRequestUrl(input.projectId), {
    body: JSON.stringify({rawArticleProvenanceMode: input.rawArticleProvenanceMode}),
    credentials: 'include',
    headers: {'content-type': 'application/json'},
    method: 'POST',
  })

  if (response.ok && isProjectTransferPackageResponse(response)) {
    await downloadProjectTransferPackageResponse(response, `project-transfer-${input.projectId}.zip`)

    return {status: 'downloaded'}
  }

  return {
    session: await readProjectTransferExportSessionResponse(response, 'Failed to start project transfer export'),
    status: 'session',
  }
}

const downloadProjectTransferPackageFromSession = async (
  session: ProjectTransferExportReadySession,
): Promise<ProjectTransferExportSession | null> => {
  const response = await fetch(getProjectTransferDownloadRequestUrl(session.downloadUrl), {
    credentials: 'include',
    method: 'GET',
  })

  if (response.ok && isProjectTransferPackageResponse(response)) {
    await downloadProjectTransferPackageResponse(response, session.filename)

    return null
  }

  return readProjectTransferExportSessionResponse(response, 'Failed to download project transfer export')
}

const getSessionMessagePrefix = (status: ProjectTransferExportSession['status']) => {
  return status === 'assembling'
    ? 'Assembling package'
    : status === 'packaging'
      ? 'Packaging download'
      : 'Preparing download'
}

const getSessionStatusMessage = (session: ProjectTransferExportSession | null) => {
  const percent = typeof session?.progress?.percent === 'number' ? Math.round(session.progress.percent) : null
  const prefix = session ? getSessionMessagePrefix(session.status) : null

  return prefix === null ? null : percent === null ? `${prefix}...` : `${prefix} (${percent}%)...`
}

const addExportId = (ids: Set<string>, exportId: string) => {
  return new Set([...ids, exportId])
}

const removeExportId = (ids: Set<string>, exportId: string) => {
  const next = new Set(ids)
  next.delete(exportId)
  return next
}

export const ProjectTransferExportAction = (props: ProjectTransferExportActionProps) => {
  const [session, setSession] = createSignal<ProjectTransferExportSession | null>(null)
  const [downloadInFlightIds, setDownloadInFlightIds] = createSignal<Set<string>>(new Set())
  const [downloadFailedIds, setDownloadFailedIds] = createSignal<Set<string>>(new Set())
  const [downloadedIds, setDownloadedIds] = createSignal<Set<string>>(new Set())
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null)
  const [rawArticleProvenanceMode, setRawArticleProvenanceMode] =
    createSignal<ProjectTransferRawArticleProvenanceMode>('auto')
  const sessionId = createMemo(() => {
    return session()?.exportId ?? null
  })
  const sessionQuery = useQuery(() => {
    const exportId = sessionId()

    return {
      enabled: exportId !== null,
      queryFn: () => {
        return fetchProjectTransferExportSession(exportId ?? '')
      },
      queryKey: ['project-transfer-export', exportId],
      refetchInterval: (query: {state: {data?: unknown}}) => {
        const data = query.state.data as ProjectTransferExportSession | undefined

        return data && data.status !== 'ready' ? 2_000 : false
      },
      retry: false,
      suspense: false,
    }
  })
  const currentSession = createMemo(() => {
    return sessionId() === null ? session() : (sessionQuery.data ?? session())
  })
  const hasActiveSession = createMemo(() => {
    return Boolean(currentSession() && currentSession()?.status !== 'ready')
  })
  const isDownloading = createMemo(() => {
    return downloadInFlightIds().size > 0
  })
  const startExportMutation = useMutation(() => {
    return {
      mutationFn: startProjectTransferExport,
      onError: (error: unknown) => {
        setErrorMessage(getErrorMessage(error, 'Failed to export project'))
      },
      onSuccess: (result: ProjectTransferExportStartResult) => {
        if (result.status === 'session') {
          setSession(result.session)
        }
      },
    }
  })
  const isBusy = createMemo(() => {
    return startExportMutation.isPending || hasActiveSession() || isDownloading()
  })
  const statusMessage = createMemo(() => {
    return isDownloading() ? 'Downloading package...' : getSessionStatusMessage(currentSession())
  })
  const buttonLabel = createMemo(() => {
    return startExportMutation.isPending
      ? 'Exporting...'
      : isDownloading()
        ? 'Downloading...'
        : hasActiveSession()
          ? 'Preparing...'
          : 'Export Project'
  })
  const wrapperClass = createMemo(() => {
    return props.align === 'end' ? 'flex flex-col items-end gap-1' : 'flex flex-col items-start gap-1'
  })
  const startReadySessionDownload = (readySession: ProjectTransferExportReadySession) => {
    setDownloadInFlightIds((ids) => {
      return addExportId(ids, readySession.exportId)
    })
    void downloadProjectTransferPackageFromSession(readySession)
      .then((nextSession) => {
        if (nextSession === null) {
          setDownloadedIds((ids) => {
            return addExportId(ids, readySession.exportId)
          })
          setSession(null)
        } else {
          setSession(nextSession)
        }
      })
      .catch((error) => {
        setDownloadFailedIds((ids) => {
          return addExportId(ids, readySession.exportId)
        })
        setErrorMessage(getErrorMessage(error, 'Failed to download project transfer export'))
      })
      .finally(() => {
        setDownloadInFlightIds((ids) => {
          return removeExportId(ids, readySession.exportId)
        })
      })
  }
  const handleExportProject = () => {
    setErrorMessage(null)
    setDownloadFailedIds(new Set())
    setDownloadedIds(new Set())
    setSession(null)
    startExportMutation.mutate({projectId: props.projectId, rawArticleProvenanceMode: rawArticleProvenanceMode()})
  }

  createEffect(() => {
    const data = sessionQuery.data
    const readySession = data?.status === 'ready' ? data : null
    const alreadyDownloaded = readySession !== null && downloadedIds().has(readySession.exportId)
    const downloadFailed = readySession !== null && downloadFailedIds().has(readySession.exportId)
    const shouldDownload =
      readySession !== null
      && !downloadInFlightIds().has(readySession.exportId)
      && !alreadyDownloaded
      && !downloadFailed

    if (readySession !== null && !alreadyDownloaded) {
      setSession(readySession)
    }

    if (shouldDownload) {
      startReadySessionDownload(readySession)
    }
  })

  createEffect(() => {
    if (sessionQuery.isError) {
      setErrorMessage(getErrorMessage(sessionQuery.error, 'Failed to fetch project transfer export status'))
      setSession(null)
    }
  })

  return (
    <div class={wrapperClass()}>
      <label class="flex items-center gap-2 text-xs text-muted-foreground">
        <span>Raw provenance</span>
        <select
          aria-label="Raw provenance mode"
          class="h-7 rounded-md border border-gray-300 bg-white px-2 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
          disabled={isBusy()}
          value={rawArticleProvenanceMode()}
          onChange={(event) => {
            return setRawArticleProvenanceMode(event.currentTarget.value as ProjectTransferRawArticleProvenanceMode)
          }}
        >
          <For each={rawArticleProvenanceModeOptions}>
            {(option) => {
              return <option value={option.value}>{option.label}</option>
            }}
          </For>
        </select>
      </label>
      <Button size="sm" variant="outline" class={props.class} disabled={isBusy()} onClick={handleExportProject}>
        {buttonLabel()}
      </Button>
      <Show when={statusMessage()}>
        {(message) => {
          return (
            <span role="status" class="max-w-40 text-xs text-muted-foreground">
              {message()}
            </span>
          )
        }}
      </Show>
      <Show when={errorMessage()}>
        {(message) => {
          return (
            <span role="alert" class="max-w-48 text-xs text-red-600">
              {message()}
            </span>
          )
        }}
      </Show>
    </div>
  )
}
