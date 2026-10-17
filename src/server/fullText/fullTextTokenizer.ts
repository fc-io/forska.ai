export type FullTextTokenCounter = (text: string) => number

const ordinaryTextEncodeOptions = {disallowedSpecial: new Set<string>()}

let fullTextTokenCounterPromise: Promise<FullTextTokenCounter> | null = null

const importFullTextTokenCounter = async (): Promise<FullTextTokenCounter> => {
  const o200kBase = await import('gpt-tokenizer/encoding/o200k_base')

  return (text: string) => {
    return text === '' ? 0 : o200kBase.countTokens(text, ordinaryTextEncodeOptions)
  }
}

export const loadFullTextTokenCounter = async (): Promise<FullTextTokenCounter> => {
  fullTextTokenCounterPromise = fullTextTokenCounterPromise ?? importFullTextTokenCounter()

  return fullTextTokenCounterPromise
}

export const countFullTextTokens = async (text: string): Promise<number> => {
  return (await loadFullTextTokenCounter())(text)
}
