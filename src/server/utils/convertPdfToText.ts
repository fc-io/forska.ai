import path from 'path'

import {env} from './env.ts'

/**
 * Custom error class for PDF conversion failures
 */
export class ConversionError extends Error {
  constructor(
    message: string,
    public status?: number,
    public isPermanent: boolean = false,
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
export const convertPdfToText = async (localPath: string, timeoutMs: number = 60_000): Promise<string> => {
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
        sources: [{kind: 'base64', data: base64}],
        options: {to_formats: ['md']},
      }),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (!res.ok) {
      // Permanent errors: client-side issues that won't be fixed by retrying
      const isPermanent = [400, 401, 403, 404, 422].includes(res.status)
      throw new ConversionError(`Docling conversion failed: ${res.status} ${res.statusText}`, res.status, isPermanent)
    }

    const json = (await res.json()) as {documents?: {md_content?: string}[]}

    const mdContent = json.documents?.[0]?.md_content
    if (!mdContent) {
      throw new ConversionError('Docling returned empty content', undefined, true)
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
        msg.includes('econnrefused') ||
        msg.includes('etimedout') ||
        msg.includes('enotfound') ||
        msg.includes('network') ||
        msg.includes('socket')
      throw new ConversionError(`Docling conversion failed: ${error.message}`, undefined, !isConnectionError)
    }

    throw new ConversionError(`Docling conversion failed: ${String(error)}`, undefined, false)
  }
}
