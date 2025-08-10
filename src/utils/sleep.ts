declare const setTimeout: typeof globalThis.setTimeout

export const sleep = (ms: number): Promise<void> => {
  return new Promise((r) => {
    return setTimeout(r, ms)
  })
}
