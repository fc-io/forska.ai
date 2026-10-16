import {expect, test} from 'bun:test'

import {isBunCrashOutput, summarizeDuckdbStartupChildStderr} from './duckdbStartupChildStderr.ts'

const windowsBunPanicStderr = [
  '[duckdb:preflight] replaying WAL for C:\\Users\\sample\\AppData\\Local\\Forska\\runtime\\primary\\forska.duckdb',
  '============================================================',
  'Bun v1.3.13 (bf2e2cec) Windows x64',
  'Windows v.win11_ge',
  'CPU: sse42 avx avx2',
  'Args: "C:\\Users\\sample\\.bun\\bin\\bun.exe" "run" "-"',
  'Features: jsc spawn',
  'Elapsed: 559ms | User: 203ms | Sys: 125ms',
  'RSS: 0.16GB | Peak: 0.16GB | Commit: 0.25GB | Faults: 43211',
  '',
  'panic(thread 23712): Segmentation fault at address 0x4D',
  'oh no: Bun has crashed. This indicates a bug in Bun, not your code.',
  '',
  "To send a redacted crash report to Bun's team,",
  'please file a GitHub issue using the link below:',
  '',
  ' https://bun.report/1.3.13/wa1bf2e2ceAgggIs4ylqB+0hxP',
  '',
  '    duckdb.dll  0x7ffd1a2b3c4d',
  '    duckdb.node 0x7ffd1a2b3c4e',
].join('\r\n')

test('a Bun panic in a startup child keeps the context, the first panic line and the bun.report URL only', () => {
  expect(isBunCrashOutput(windowsBunPanicStderr)).toBe(true)
  expect(summarizeDuckdbStartupChildStderr(windowsBunPanicStderr)).toBe(
    '[duckdb:preflight] replaying WAL for C:\\Users\\sample\\AppData\\Local\\Forska\\runtime\\primary\\forska.duckdb'
      + ' -- Bun crashed: panic(thread 23712): Segmentation fault at address 0x4D'
      + ' -- crash report: https://bun.report/1.3.13/wa1bf2e2ceAgggIs4ylqB+0hxP',
  )
})

test('a Bun crash without context, panic line or report URL still collapses to one line', () => {
  expect(summarizeDuckdbStartupChildStderr('panic: A C++ exception occurred\noh no: Bun has crashed.')).toBe(
    'Bun crashed: panic: A C++ exception occurred',
  )
  expect(summarizeDuckdbStartupChildStderr('Bun has crashed\nRSS: 1GB')).toBe('Bun crashed: Bun has crashed')
})

test('ordinary startup child errors are left untouched', () => {
  const stderr = 'error: Catalog Error: Table with name sample does not exist!\n    at <anonymous> (preflight:12:5)'

  expect(isBunCrashOutput(stderr)).toBe(false)
  expect(summarizeDuckdbStartupChildStderr(stderr)).toBe(stderr)
})
