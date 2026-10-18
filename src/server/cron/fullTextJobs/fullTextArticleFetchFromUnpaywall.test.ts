import {expect, mock, test} from 'bun:test'

const userConfigQueryServiceModulePath = new URL('../../services/userConfigQueryService.ts', import.meta.url).href

void mock.module(userConfigQueryServiceModulePath, () => {
  return {
    getUserConfigQueryService: () => {
      return {
        getUnpaywallEmail: async () => {
          return null
        },
      }
    },
  }
})

test('without an Unpaywall email the source is not tried and names the setting', async () => {
  const {fullTextArticleFetchFromUnpaywall} = await import('./fullTextArticleFetchFromUnpaywall.ts')

  expect(await fullTextArticleFetchFromUnpaywall({arxivId: null, doi: '10.3390/jcm15072485'})).toEqual({
    details: 'Set an Unpaywall email in Settings before fetching PDFs from Unpaywall',
    reason: 'Unpaywall email missing',
    source: 'Unpaywall',
    success: false,
    tried: false,
  })
})
