import {expect, test} from 'bun:test'

import {getRuntimeAssetUrl} from './getRuntimeAssetUrl.ts'

test('uses the direct local API in the primary vite profile', () => {
  expect(getRuntimeAssetUrl('assets/article_pdfs/test.pdf', 'http://localhost:3000')).toBe(
    'http://127.0.0.1:3001/api/runtime-asset?path=assets%2Farticle_pdfs%2Ftest.pdf',
  )
})

test('keeps a relative runtime asset URL outside the local vite dev profiles', () => {
  expect(getRuntimeAssetUrl('assets/article_pdfs/test.pdf', 'http://localhost:8080')).toBe(
    '/api/runtime-asset?path=assets%2Farticle_pdfs%2Ftest.pdf',
  )
})
