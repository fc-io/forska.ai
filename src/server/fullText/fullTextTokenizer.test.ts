import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {FULL_TEXT_TOKENIZER_ID} from './fullTextStrategy.ts'
import {countFullTextTokens, loadFullTextTokenCounter} from './fullTextTokenizer.ts'

const fixtureDirectory = join(import.meta.dir, 'fixtures', 'canonical')

test('the tokenizer is o200k_base and its counts are frozen', async () => {
  const vectors: Array<[string, number]> = [
    ['', 0],
    ['hello world', 2],
    ['Patients (n = 1,203) were randomised 2:1.', 17],
    ['Hôpital Necker – Enfants malades, Paris 🙂', 12],
    ['## Methods > 2.1 Search strategy', 9],
  ]
  const counts = await Promise.all(
    vectors.map(([text]) => {
      return countFullTextTokens(text)
    }),
  )

  expect(FULL_TEXT_TOKENIZER_ID).toBe('o200k_base')
  expect(counts).toEqual(
    vectors.map(([, count]) => {
      return count
    }),
  )
})

test('special-token strings in article text count as ordinary text', async () => {
  expect(await countFullTextTokens('Models emit <|endoftext|> here.')).toBe(11)
})

test('canonical fixture texts have frozen token counts', async () => {
  const countTokens = await loadFullTextTokenCounter()
  const counts = ['arxiv-2111.06377.mineru.none.md', 'frontiers-fmed-2023-1283512.docling.none.md'].map((name) => {
    return countTokens(readFileSync(join(fixtureDirectory, name), 'utf8'))
  })

  expect(counts).toEqual([12_069, 3_787])
})

test('the counter loads once and is reused', async () => {
  expect(await loadFullTextTokenCounter()).toBe(await loadFullTextTokenCounter())
})
