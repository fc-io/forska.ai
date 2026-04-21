import {getApiRequestUrl} from './getApiRequestUrl.ts'

type CsvDownloadPostRequest = {body: unknown; errorMessage: string; fallbackFilename: string; path: string}

export const getCsvFilenameFromResponse = (response: Response, fallbackFilename: string): string => {
  const contentDisposition = response.headers.get('Content-Disposition')
  const filenameMatch = contentDisposition ? contentDisposition.match(/filename="([^"]+)"/) : null
  const filenameFromHeader = filenameMatch && filenameMatch[1] ? filenameMatch[1] : null

  return filenameFromHeader ?? fallbackFilename
}

export const downloadResponseAsCsv = async (response: Response, fallbackFilename: string): Promise<void> => {
  const filename = getCsvFilenameFromResponse(response, fallbackFilename)
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

export const downloadCsvFromPost = async (request: CsvDownloadPostRequest): Promise<void> => {
  const response = await fetch(getApiRequestUrl(request.path), {
    body: JSON.stringify(request.body),
    credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(request.errorMessage)
  }

  await downloadResponseAsCsv(response, request.fallbackFilename)
}
