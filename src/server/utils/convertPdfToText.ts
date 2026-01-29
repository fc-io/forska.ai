import path from 'path'

import {env} from './env.ts'

// Bun global type declaration for environments where Bun types aren't available
declare const Bun: {file: (path: string) => {exists: () => Promise<boolean>; arrayBuffer: () => Promise<ArrayBuffer>}}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const toNonEmptyStringOrNull = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? value : null
}

const markdownKeySet = new Set(['md_content', 'md', 'markdown', 'markdown_content', 'mdcontent', 'markdowncontent'])
const htmlKeySet = new Set(['html_content', 'html', 'htmlcontent', 'html_text'])

const findContentInValue = (value: unknown, keySet: Set<string>, depth: number): string | null => {
  if (depth > 10) return null
  return Array.isArray(value)
    ? findContentInArray(value, keySet, 0, depth + 1)
    : isRecord(value)
      ? findContentInRecord(value, keySet, depth + 1)
      : null
}

const findContentInArray = (values: unknown[], keySet: Set<string>, index: number, depth: number): string | null => {
  if (index >= values.length) return null
  const found = findContentInValue(values[index], keySet, depth)
  return found ?? findContentInArray(values, keySet, index + 1, depth)
}

const findContentInRecord = (value: Record<string, unknown>, keySet: Set<string>, depth: number): string | null => {
  const entries = Object.entries(value)
  const direct = findContentFromCandidateEntries(entries, keySet, 0, depth)
  return direct ?? findContentFromAllEntries(entries, keySet, 0, depth)
}

const findContentFromCandidateEntries = (
  entries: [string, unknown][],
  keySet: Set<string>,
  index: number,
  depth: number,
): string | null => {
  if (index >= entries.length) return null
  const entry = entries[index] as [string, unknown]
  const [key, value] = entry
  const found = keySet.has(key.toLowerCase())
    ? (toNonEmptyStringOrNull(value) ?? findContentInValue(value, keySet, depth))
    : null
  return found ?? findContentFromCandidateEntries(entries, keySet, index + 1, depth)
}

const findContentFromAllEntries = (
  entries: [string, unknown][],
  keySet: Set<string>,
  index: number,
  depth: number,
): string | null => {
  if (index >= entries.length) return null
  const entry = entries[index]
  if (!entry) return findContentFromAllEntries(entries, keySet, index + 1, depth)
  const found = findContentInValue(entry[1], keySet, depth)
  return found ?? findContentFromAllEntries(entries, keySet, index + 1, depth)
}

const summarizeDoclingResponse = (json: unknown): string => {
  if (!isRecord(json)) return `type=${typeof json}`
  const topKeys = Object.keys(json).slice(0, 20).join(',')
  const documents = Array.isArray(json.documents) ? json.documents : null
  const doc0 = documents && documents[0] && isRecord(documents[0]) ? documents[0] : null
  const doc0Keys = doc0 ? Object.keys(doc0).slice(0, 20).join(',') : ''
  const documentsInfo = documents ? ` documents=${documents.length}` : ''
  const doc0Info = doc0Keys ? ` doc0Keys=${doc0Keys}` : ''
  return `topKeys=${topKeys}${documentsInfo}${doc0Info}`
}

/**
 * Custom error class for PDF conversion failures
 */
export class ConversionError extends Error {
  constructor(
    message: string,
    public status?: number,
    public isPermanent = false,
  ) {
    super(message)
    this.name = 'ConversionError'
  }
}

/**
 * Convert a local PDF file to Markdown text using Docling Serve
 *
 * @param localPath - Path to the PDF file (can be relative to cwd or absolute)
 * @param timeoutMs - Timeout in milliseconds (default: 60000)
 * @returns The converted Markdown text
 * @throws ConversionError if conversion fails
 */
export const convertPdfToText = async (
  localPath: string,
  timeoutMs = 60_000,
): Promise<{md: string; html: string | null}> => {
  const startTime = Date.now()

  // Use absolute path for safety
  const absPath = path.resolve(process.cwd(), localPath)

  // Check if file exists
  const file = Bun.file(absPath)
  const exists = await file.exists()
  if (!exists) {
    throw new ConversionError(`File not found: ${absPath}`, undefined, true)
  }

  // Read PDF and convert to base64
  const pdfBytes = await file.arrayBuffer()
  const fileSizeMB = (pdfBytes.byteLength / (1024 * 1024)).toFixed(2)
  const base64 = Buffer.from(pdfBytes).toString('base64')

  // Create AbortController for timeout
  const controller = new AbortController()
  const timeoutId = setTimeout(() => {
    controller.abort()
  }, timeoutMs)

  try {
    const res = await fetch(`${env.DOCLING_SERVE_URL}/v1/convert/source`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        sources: [{kind: 'file', base64_string: base64, filename: path.basename(absPath)}],
        options: {to_formats: ['md', 'html']},
      }),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (!res.ok) {
      // Try to get error details from response body
      let errorDetails = ''
      try {
        const errorBody = await res.text()
        errorDetails = errorBody ? ` - ${errorBody.slice(0, 500)}` : ''
        console.error(`[convertPdfToText] Error response from Docling: ${errorBody}`)
      } catch {
        // Ignore if we can't read the body
      }
      // Permanent errors: client-side issues that won't be fixed by retrying
      // 504 = Docling timeout, PDF is too complex to convert within the server's configured limit
      // Also check for "taking too long" message which indicates timeout
      const isPermanent =
        [400, 401, 403, 404, 422, 504].includes(res.status) || errorDetails.toLowerCase().includes('taking too long')
      throw new ConversionError(
        `Docling conversion failed: ${res.status} ${res.statusText}${errorDetails} (file: ${fileSizeMB}MB)`,
        res.status,
        isPermanent,
      )
    }

    const json = (await res.json()) as unknown

    const mdContent = findContentInValue(json, markdownKeySet, 0)
    const htmlContent = findContentInValue(json, htmlKeySet, 0)

    if (!mdContent) {
      const summary = summarizeDoclingResponse(json)
      console.error(`[convertPdfToText] Docling returned no Markdown content: ${summary} (file: ${fileSizeMB}MB)`)
      throw new ConversionError(
        `Docling returned no Markdown content (${summary}) (file: ${fileSizeMB}MB)`,
        undefined,
        false,
      )
    }

    const duration = Date.now() - startTime
    console.log(
      `[convertPdfToText] Success: ${absPath} (${duration}ms, ${mdContent.length} chars MD, ${htmlContent?.length ?? 0} chars HTML)`,
    )

    return {md: mdContent, html: htmlContent}
  } catch (error) {
    clearTimeout(timeoutId)

    // Handle abort (timeout)
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ConversionError(
        `Docling conversion timed out after ${timeoutMs}ms (file: ${fileSizeMB}MB)`,
        undefined,
        false,
      )
    }

    // Re-throw ConversionError as-is
    if (error instanceof ConversionError) {
      throw error
    }

    // Handle network errors as transient
    if (error instanceof Error) {
      const msg = error.message.toLowerCase()
      const isConnectionError =
        msg.includes('econnrefused')
        || msg.includes('etimedout')
        || msg.includes('timed out')
        || msg.includes('enotfound')
        || msg.includes('network')
        || msg.includes('socket')
      throw new ConversionError(
        `Docling conversion failed: ${error.message} (file: ${fileSizeMB}MB)`,
        undefined,
        !isConnectionError,
      )
    }

    throw new ConversionError(`Docling conversion failed: ${String(error)} (file: ${fileSizeMB}MB)`, undefined, false)
  }
}
