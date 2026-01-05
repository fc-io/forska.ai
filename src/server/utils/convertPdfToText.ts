import path from 'path'

import {env} from './env.ts'

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const toNonEmptyStringOrNull = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? value : null
}

const markdownKeySet = new Set(['md_content', 'md', 'markdown', 'markdown_content', 'mdcontent', 'markdowncontent'])

const findMarkdownInValue = (value: unknown, depth: number): string | null => {
  if (depth > 10) return null
  return Array.isArray(value)
    ? findMarkdownInArray(value, 0, depth + 1)
    : isRecord(value)
      ? findMarkdownInRecord(value, depth + 1)
      : null
}

const findMarkdownInArray = (values: unknown[], index: number, depth: number): string | null => {
  if (index >= values.length) return null
  const found = findMarkdownInValue(values[index], depth)
  return found ?? findMarkdownInArray(values, index + 1, depth)
}

const findMarkdownInRecord = (value: Record<string, unknown>, depth: number): string | null => {
  const entries = Object.entries(value)
  const direct = findMarkdownFromCandidateEntries(entries, 0, depth)
  return direct ?? findMarkdownFromAllEntries(entries, 0, depth)
}

const findMarkdownFromCandidateEntries = (
  entries: [string, unknown][],
  index: number,
  depth: number,
): string | null => {
  if (index >= entries.length) return null
  const [key, value] = entries[index]
  const found = markdownKeySet.has(key.toLowerCase())
    ? (toNonEmptyStringOrNull(value) ?? findMarkdownInValue(value, depth))
    : null
  return found ?? findMarkdownFromCandidateEntries(entries, index + 1, depth)
}

const findMarkdownFromAllEntries = (entries: [string, unknown][], index: number, depth: number): string | null => {
  if (index >= entries.length) return null
  const found = findMarkdownInValue(entries[index][1], depth)
  return found ?? findMarkdownFromAllEntries(entries, index + 1, depth)
}

const summarizeDoclingResponse = (json: unknown): string => {
  if (!isRecord(json)) return `type=${typeof json}`
  const topKeys = Object.keys(json).slice(0, 20).join(',')
  const documents = Array.isArray(json.documents) ? json.documents : null
  const doc0 = documents && documents[0] && isRecord(documents[0]) ? (documents[0] as Record<string, unknown>) : null
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
export const convertPdfToText = async (localPath: string, timeoutMs = 60_000): Promise<string> => {
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
        options: {to_formats: ['md']},
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
      const isPermanent = [400, 401, 403, 404, 422].includes(res.status)
      throw new ConversionError(
        `Docling conversion failed: ${res.status} ${res.statusText}${errorDetails}`,
        res.status,
        isPermanent,
      )
    }

    const json = (await res.json()) as unknown

    const mdContent = findMarkdownInValue(json, 0)
    if (!mdContent) {
      const summary = summarizeDoclingResponse(json)
      console.error(`[convertPdfToText] Docling returned no Markdown content: ${summary}`)
      throw new ConversionError(`Docling returned no Markdown content (${summary})`, undefined, false)
    }

    const duration = Date.now() - startTime
    console.log(`[convertPdfToText] Success: ${absPath} (${duration}ms, ${mdContent.length} chars)`)

    return mdContent
  } catch (error) {
    clearTimeout(timeoutId)

    // Handle abort (timeout)
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ConversionError(`Docling conversion timed out after ${timeoutMs}ms`, undefined, false)
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
        || msg.includes('enotfound')
        || msg.includes('network')
        || msg.includes('socket')
      throw new ConversionError(`Docling conversion failed: ${error.message}`, undefined, !isConnectionError)
    }

    throw new ConversionError(`Docling conversion failed: ${String(error)}`, undefined, false)
  }
}
