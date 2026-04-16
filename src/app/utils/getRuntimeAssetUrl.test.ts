import {expect, test} from 'bun:test'

import {getRuntimeAssetUrl} from './getRuntimeAssetUrl.ts'

test('uses the direct local API in the primary vite profile', () => {
  expect(getRuntimeAssetUrl('assets/article_pdfs/test.pdf', 'http://localhost:3000')).toBe(
    'http://127.0.0.1:3001/api/runtime-asset?path=assets%2Farticle_pdfs%2Ftest.pdf',
  )
})

test('uses the desktop API origin when the renderer runs in the desktop shell', () => {
  expect(getRuntimeAssetUrl('assets/article_pdfs/test.pdf', 'views://mainview', 'http://127.0.0.1:32101')).toBe(
    'http://127.0.0.1:32101/api/runtime-asset?path=assets%2Farticle_pdfs%2Ftest.pdf',
  )
})
