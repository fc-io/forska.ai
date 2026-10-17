import {createHash} from 'node:crypto'

import {expect, test} from 'bun:test'

import {getProjectTransferLegacyFullTextSignature} from './projectTransferLegacyFullTextSignature.ts'

const fullText = [
  'Intro ![figure](data:image/png;base64,iVBORw0KGgo=) after',
  '![remote](https://example.test/figure.png) kept',
  '![](data:image/jpeg;base64,/9j/4AAQ) end',
].join('\n')

const getSha256 = (value: string) => {
  return createHash('sha256').update(value).digest('hex')
}

test('legacy full-text signature strips only base64 markdown images and keeps the frozen 4 chars per token budget', () => {
  const stripped = getProjectTransferLegacyFullTextSignature(fullText, {promptTokenLimit: 2030, stripImages: true})
  const kept = getProjectTransferLegacyFullTextSignature(fullText, {promptTokenLimit: 2030, stripImages: false})

  expect(stripped).toEqual({
    maxTokens: 30,
    processedText: 'Intro  after\n![remote](https://example.test/figure.png) kept\n end',
    tokenCount: 17,
    withinBudget: true,
  })
  expect(kept).toEqual({maxTokens: 30, processedText: fullText, tokenCount: 37, withinBudget: false})
  expect(getSha256(kept.processedText)).toBe('68856c9b5bc03447b81fa2a456c09d594173d4cba8bf5d6e8ade486dde16b592')
})

test('legacy full-text signature budget boundaries match the frozen reserved 2000 tokens', () => {
  const text = 'abcd'.repeat(10)

  expect(getProjectTransferLegacyFullTextSignature(text, {promptTokenLimit: 2010, stripImages: false})).toEqual({
    maxTokens: 10,
    processedText: text,
    tokenCount: 10,
    withinBudget: true,
  })
  expect(getProjectTransferLegacyFullTextSignature(`${text}a`, {promptTokenLimit: 2010, stripImages: false})).toEqual({
    maxTokens: 10,
    processedText: `${text}a`,
    tokenCount: 11,
    withinBudget: false,
  })
  expect(getProjectTransferLegacyFullTextSignature('', {promptTokenLimit: 0, stripImages: true})).toEqual({
    maxTokens: -2000,
    processedText: '',
    tokenCount: 0,
    withinBudget: false,
  })
})
