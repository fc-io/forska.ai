import assert from 'node:assert/strict'
import {readFile, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {file} from 'bun'

import {hashDistributionInput} from '../buildDuckdbDistribution/hashDistributionInput'

export const copyVerifiedReleaseInput = async (source: string, filename: string, expected: string, output: string) => {
  assert.match(filename, /^[a-zA-Z0-9_.-]+$/)
  const bytes = await readFile(source)
  assert.equal(hashDistributionInput(bytes), expected, `Release input checksum mismatch: ${filename}`)
  const destination = join(output, filename)
  if (await file(destination).exists()) {
    assert.deepEqual(await readFile(destination), bytes, 'Different inputs must not share a release filename')
  } else {
    await writeFile(destination, bytes, {flag: 'wx'})
  }
  return bytes
}
