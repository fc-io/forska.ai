import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'

import {Glob} from 'bun'

export const readNativeCompiler = async (buildDirectory: string) => {
  const matches = await Array.fromAsync(new Glob('*/CMakeCXXCompiler.cmake').scan(join(buildDirectory, 'CMakeFiles')))
  assert.equal(matches.length, 1, 'Expected one configured native C++ compiler')
  const match = matches[0]
  assert.ok(match)
  const contents = await readFile(join(buildDirectory, 'CMakeFiles', match), 'utf8')
  const variables = [...contents.matchAll(/set\((CMAKE_CXX_COMPILER(?:_ID|_VERSION|_TARGET)?) "([^"]*)"\)/g)]
  const compiler = Object.fromEntries(
    variables.map((match) => {
      return [match[1], match[2]]
    }),
  ) as Record<string, string>
  assert.ok(compiler.CMAKE_CXX_COMPILER_ID && compiler.CMAKE_CXX_COMPILER_VERSION, 'Missing native compiler identity')
  return compiler
}
