import {describe, expect, it} from 'vitest'

import {judgeStoreJudgmentGetStringAsArrayOfStrings} from './judgeStoreJudgmentGetStringAsArrayOfStrings.ts'

describe('judgeStoreJudgmentGetStringAsArrayOfStrings', () => {
  it('returns array of strings for valid JSON array of strings', () => {
    const input = '["alpha","beta","gamma"]'
    const result = judgeStoreJudgmentGetStringAsArrayOfStrings(input)
    expect(result).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('returns null for string', () => {
    const input = 'string'
    const result = judgeStoreJudgmentGetStringAsArrayOfStrings(input)
    expect(result).toEqual(null)
  })

  it('returns null for empty object', () => {
    const input = '{}'
    const result = judgeStoreJudgmentGetStringAsArrayOfStrings(input)
    expect(result).toEqual(null)
  })

  it('returns null for object', () => {
    const input = '{"Accident and emergency medicine","Cardiology","Internal medicine"}'
    const result = judgeStoreJudgmentGetStringAsArrayOfStrings(input)
    expect(result).toEqual(null)
  })

  it('tolerates whitespace around JSON', () => {
    const input = `\n  [  "x" ,  "y" ]  `
    const result = judgeStoreJudgmentGetStringAsArrayOfStrings(input)
    expect(result).toEqual(['x', 'y'])
  })
})
