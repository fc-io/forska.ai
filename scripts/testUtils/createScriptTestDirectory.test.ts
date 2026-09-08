import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {createScriptTestDirectory} from './createScriptTestDirectory.ts'

test('script fixture cleanup removes only its unique root and preserves a running sibling', () => {
  const parent = createScriptTestDirectory('fixture-parent')

  try {
    const first = createScriptTestDirectory('same-suite', parent.path)
    const sibling = createScriptTestDirectory('same-suite', parent.path)
    const siblingEvidence = join(sibling.path, 'running-topology.log')
    const parentEvidence = join(parent.path, 'unowned.duckdb')
    const spill = join(first.path, 'duckdb-temp')
    mkdirSync(spill)
    writeFileSync(join(spill, 'block.tmp'), 'spill')
    writeFileSync(join(first.path, 'fixture.duckdb.wal'), 'wal')
    writeFileSync(siblingEvidence, 'still running')
    writeFileSync(parentEvidence, 'unowned database')

    expect(first.path).not.toBe(sibling.path)
    first.cleanup()
    first.cleanup()

    expect(existsSync(first.path)).toBe(false)
    expect(readFileSync(siblingEvidence, 'utf8')).toBe('still running')
    expect(readFileSync(parentEvidence, 'utf8')).toBe('unowned database')
    sibling.cleanup()
    expect(readFileSync(parentEvidence, 'utf8')).toBe('unowned database')
  } finally {
    parent.cleanup()
  }
})
