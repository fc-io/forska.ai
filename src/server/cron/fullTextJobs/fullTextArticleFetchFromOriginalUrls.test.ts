import {afterEach, expect, spyOn, test} from 'bun:test'

import {emptyArticleSourceMetadata} from '../../../utils/articleSourceMetadata.ts'
import {fullTextArticleFetchFromOriginalUrls} from './fullTextArticleFetchFromOriginalUrls.ts'

const getPdfLink = (url: string, site: string) => {
  return {availability: 'Open access', availabilityCode: 'OA', documentStyle: 'pdf', site, url}
}

const stubFetch = (responses: Record<string, () => Response>) => {
  const requestedUrls: string[] = []

  spyOn(globalThis, 'fetch').mockImplementation((async (input: Request | URL | string) => {
    const url = input instanceof Request ? input.url : input.toString()
    const getResponse = responses[url]

    requestedUrls.push(url)

    return getResponse ? getResponse() : new Response('not found', {status: 404})
  }) as typeof fetch)

  return requestedUrls
}

const fetchFromLinks = (links: ReturnType<typeof getPdfLink>[]) => {
  return fullTextArticleFetchFromOriginalUrls({
    arxivId: null,
    doi: '10.3389/fpubh.2026.1755070',
    sourceMetadata: {...emptyArticleSourceMetadata, fullTextLinks: links},
  })
}

afterEach(() => {
  ;(globalThis.fetch as unknown as {mockRestore?: () => void}).mockRestore?.()
})

test('a Cloudflare 403 from Europe PMC is a named "not available from this source" result and skips its other links', async () => {
  const requestedUrls = stubFetch({
    'https://europepmc.org/articles/PMC1/pdf/render': () => {
      return new Response('challenge', {headers: {'cf-mitigated': 'challenge'}, status: 403})
    },
  })

  const attempt = await fetchFromLinks([
    getPdfLink('https://europepmc.org/articles/PMC1/pdf/render', 'Europe_PMC'),
    getPdfLink('https://www.europepmc.org/articles/PMC1?pdf=render', 'Europe_PMC'),
  ])

  expect(attempt).toEqual({
    details:
      'Europe_PMC: HTTP 403 (Cloudflare challenge); europepmc.org is not available from this source; Skipped Europe_PMC: europepmc.org is not available from this source',
    reason: 'Not available from this source',
    source: 'OriginalUrls',
    success: false,
    tried: true,
  })
  expect(requestedUrls).toEqual(['https://europepmc.org/articles/PMC1/pdf/render'])
})

test('a 429 from Europe PMC next to another failing publisher link keeps the generic reason and lists both', async () => {
  stubFetch({
    'https://europepmc.org/articles/PMC2/pdf/render': () => {
      return new Response('slow down', {status: 429})
    },
    'https://publisher.example/paper.pdf': () => {
      return new Response('boom', {status: 500})
    },
  })

  const attempt = await fetchFromLinks([
    getPdfLink('https://europepmc.org/articles/PMC2/pdf/render', 'Europe_PMC'),
    getPdfLink('https://publisher.example/paper.pdf', 'Publisher'),
  ])

  expect(attempt.reason).toBe('All PDF URLs failed')
  expect(attempt.details).toBe(
    'Europe_PMC: HTTP 429; europepmc.org is not available from this source; Publisher: HTTP 500',
  )
})

test('a 403 from another host stays an ordinary HTTP failure', async () => {
  stubFetch({
    'https://www.mdpi.com/paper.pdf': () => {
      return new Response('forbidden', {status: 403})
    },
  })

  const attempt = await fetchFromLinks([getPdfLink('https://www.mdpi.com/paper.pdf', 'MDPI')])

  expect(attempt).toMatchObject({details: 'MDPI: HTTP 403', reason: 'All PDF URLs failed'})
})
