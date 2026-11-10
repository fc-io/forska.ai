import {getApiRequestUrl} from './getApiRequestUrl.ts'

type FileDownloadPostRequest = {body: unknown; errorMessage: string; fallbackFilename: string; path: string}

export const getCsvFilenameFromResponse = (response: Response, fallbackFilename: string): string => {
  const contentDisposition = response.headers.get('Content-Disposition')
  const filenameMatch = contentDisposition ? contentDisposition.match(/filename="([^"]+)"/) : null
  const filenameFromHeader = filenameMatch && filenameMatch[1] ? filenameMatch[1] : null

  return filenameFromHeader ?? fallbackFilename
}

const saveBlobAsFile = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

export const downloadResponseAsCsv = async (response: Response, fallbackFilename: string): Promise<void> => {
  const filename = getCsvFilenameFromResponse(response, fallbackFilename)
  const blob = await response.blob()

  saveBlobAsFile(blob, filename)
}

export const downloadCsvFromPost = async (request: CsvDownloadPostRequest): Promise<void> => {
  return downloadFileFromPost(request)
}

/** The server's `{error}` message for a failed download, or the caller's generic message when there is none. */
export const getDownloadErrorMessage = async (response: Response, fallbackMessage: string): Promise<string> => {
  const body: unknown = await response.json().catch(() => {
    return null
  })
  const error = typeof body === 'object' && body !== null && 'error' in body ? body.error : null

  return typeof error === 'string' && error.trim() !== '' ? error : fallbackMessage
}

const getErrorReason = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

export const downloadFileFromPost = async (request: FileDownloadPostRequest): Promise<void> => {
  const response = await fetch(getApiRequestUrl(request.path), {
    body: JSON.stringify(request.body),
    credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(await getDownloadErrorMessage(response, request.errorMessage))
  }

  const filename = getCsvFilenameFromResponse(response, request.fallbackFilename)
  const blob = await response.blob().catch((error: unknown) => {
    throw new Error(
      `${request.errorMessage}: the download was interrupted before it finished (${getErrorReason(error)})`,
      {cause: error},
    )
  })

  saveBlobAsFile(blob, filename)
}

type CsvDownloadPostRequest = FileDownloadPostRequest
