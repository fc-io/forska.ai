// @vitest-environment happy-dom

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

import {downloadFileFromPost, getDownloadErrorMessage} from './downloadCsv.ts'

const request = {
  body: {invertSelection: false},
  errorMessage: 'Covidence export failed',
  fallbackFilename: 'covidence-export-cov9.ris',
  path: '/api/comparison-projects/cov9/covidence-export',
}

const fetchMock = vi.fn<typeof fetch>()
const createObjectUrlMock = vi.fn(() => {
  return 'blob:download'
})
const revokeObjectUrlMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  createObjectUrlMock.mockClear()
  revokeObjectUrlMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  URL.createObjectURL = createObjectUrlMock
  URL.revokeObjectURL = revokeObjectUrlMock
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getDownloadErrorMessage', () => {
  test('uses a non-empty {error} string from a JSON body', async () => {
    const response = Response.json(
      {data: null, error: 'DuckDB owner proxy target timed out after 60000 ms'},
      {status: 504},
    )

    expect(await getDownloadErrorMessage(response, 'Covidence export failed')).toBe(
      'DuckDB owner proxy target timed out after 60000 ms',
    )
  })

  test('falls back to the generic message for non-JSON, empty, or non-string errors', async () => {
    const responses = [
      new Response('<html>Bad gateway</html>', {headers: {'content-type': 'text/html'}, status: 502}),
      new Response(null, {status: 500}),
      Response.json({data: null, error: '  '}, {status: 500}),
      Response.json({data: null, error: {message: 'nested'}}, {status: 500}),
      Response.json(['not', 'an', 'object'], {status: 500}),
      Response.json(null, {status: 500}),
    ]

    for (const response of responses) {
      expect(await getDownloadErrorMessage(response, 'Covidence export failed')).toBe('Covidence export failed')
    }
  })
})

describe('downloadFileFromPost', () => {
  test('throws the server error message on a non-ok response', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({data: null, error: 'DuckDB owner proxy target timed out after 60000 ms'}, {status: 504}),
    )

    await expect(downloadFileFromPost(request)).rejects.toThrow('DuckDB owner proxy target timed out after 60000 ms')
  })

  test('throws the generic message when the error body has no usable error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('upstream connect error', {status: 502}))

    await expect(downloadFileFromPost(request)).rejects.toThrow(/^Covidence export failed$/)
  })

  test('says the download was interrupted when the body stream fails', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError('network error'))
      },
    })
    fetchMock.mockResolvedValueOnce(new Response(body, {status: 200}))

    await expect(downloadFileFromPost(request)).rejects.toThrow(
      /^Covidence export failed: the download was interrupted before it finished \(.*network error.*\)$/,
    )
    expect(createObjectUrlMock).not.toHaveBeenCalled()
  })

  test('saves the file under the Content-Disposition filename on success', async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    fetchMock.mockResolvedValueOnce(
      new Response('TY  - JOUR\nER  - \n', {
        headers: {'Content-Disposition': 'attachment; filename="cov9-covidence.ris"'},
        status: 200,
      }),
    )

    await downloadFileFromPost(request)

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/comparison-projects/cov9/covidence-export'),
      expect.objectContaining({body: JSON.stringify(request.body), method: 'POST'}),
    )
    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect((clickSpy.mock.contexts[0] as HTMLAnchorElement).download).toBe('cov9-covidence.ris')
    expect(revokeObjectUrlMock).toHaveBeenCalledWith('blob:download')
    clickSpy.mockRestore()
  })
})
