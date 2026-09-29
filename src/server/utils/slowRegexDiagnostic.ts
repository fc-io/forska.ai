import {writeRuntimeOperatorLogEvent} from './runtimeLogger.ts'

declare global {
  var __forskaSlowRegexDiagnosticInstalled: boolean | undefined
}

// On 2026-09-26 the DuckDB owner's main thread spent 2-8 minutes at a time inside RegExp.prototype.test (regex
// backtracking) while an import ran, and nothing else ran until it returned. The regex was never identified. Any
// such call that blocks the thread this long is logged with its regex, its input and its caller, so the next
// occurrence names its source.
export const slowRegexThresholdMs = 1_000

const slowRegexInputHeadLength = 400
const slowRegexInputTailLength = 200
const slowRegexSourceLength = 500

type RegexTest = (this: RegExp, input: string) => boolean

type SlowRegexDiagnosticOptions = {
  nowMs?: () => number
  thresholdMs?: number
  writeLogEvent?: typeof writeRuntimeOperatorLogEvent
}

const getSlowRegexAttrs = (input: {durationMs: number; regex: unknown; result: boolean; text: string}) => {
  const regex = input.regex instanceof RegExp ? input.regex : null

  return {
    durationMs: Math.round(input.durationMs),
    flags: regex?.flags ?? null,
    inputHead: input.text.slice(0, slowRegexInputHeadLength),
    inputLength: input.text.length,
    inputTail: input.text.slice(-slowRegexInputTailLength),
    result: input.result,
    source: regex?.source.slice(0, slowRegexSourceLength) ?? null,
    stack: new Error('slow regex').stack,
  }
}

export const getInstalledRegexTest = () => {
  return Object.getOwnPropertyDescriptor(RegExp.prototype, 'test')?.value as RegexTest
}

const setInstalledRegexTest = (test: RegexTest) => {
  Object.defineProperty(RegExp.prototype, 'test', {configurable: true, enumerable: false, value: test, writable: true})
}

// Returns the function that removes the wrapper again, or null when it was already installed.
export const installSlowRegexDiagnostic = (options: SlowRegexDiagnosticOptions = {}) => {
  if (globalThis.__forskaSlowRegexDiagnosticInstalled) {
    return null
  }

  const nowMs =
    options.nowMs
    ?? (() => {
      return performance.now()
    })
  const thresholdMs = options.thresholdMs ?? slowRegexThresholdMs
  const writeLogEvent = options.writeLogEvent ?? writeRuntimeOperatorLogEvent
  const originalTest = getInstalledRegexTest()

  globalThis.__forskaSlowRegexDiagnosticInstalled = true

  setInstalledRegexTest(function slowRegexDiagnosticTest(this: RegExp, input: string) {
    const startedAtMs = nowMs()
    const result = originalTest.call(this, input)
    const durationMs = nowMs() - startedAtMs

    if (durationMs >= thresholdMs) {
      try {
        writeLogEvent({
          attrs: getSlowRegexAttrs({durationMs, regex: this, result, text: String(input)}),
          event: 'diagnostic.slow-regex',
          message: `[slowRegexDiagnostic] RegExp.test took ${Math.round(durationMs)} ms`,
          severity: 'WARN',
        })
      } catch {
        // Reporting a slow call must never change what the call returns.
      }
    }

    return result
  })

  return () => {
    setInstalledRegexTest(originalTest)
    globalThis.__forskaSlowRegexDiagnosticInstalled = false
  }
}
