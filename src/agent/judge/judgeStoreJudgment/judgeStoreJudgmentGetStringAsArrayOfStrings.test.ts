import {describe, expect, it} from 'vitest'

import {judgeStoreJudgmentGetStringAsArrayOfStrings} from './judgeStoreJudgmentGetStringAsArrayOfStrings.ts'

describe('judgeStoreJudgmentGetStringAsArrayOfStrings', () => {
  it('returns array of strings for valid JSON array of strings', () => {
    const input = ['alpha', 'beta', 'gamma']
    const result = judgeStoreJudgmentGetStringAsArrayOfStrings(input)
    expect(result).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('returns null for string', () => {
    const input = 'string'
    const result = judgeStoreJudgmentGetStringAsArrayOfStrings(input)
    expect(result).toEqual(null)
  })

  it('returns null for empty object', () => {
    const input = {}
    const result = judgeStoreJudgmentGetStringAsArrayOfStrings(input)
    expect(result).toEqual(null)
  })

  it('returns null for object', () => {
    const input = {'Accident and emergency medicine': 'test'}
    const result = judgeStoreJudgmentGetStringAsArrayOfStrings(input)
    expect(result).toEqual(null)
  })
})
