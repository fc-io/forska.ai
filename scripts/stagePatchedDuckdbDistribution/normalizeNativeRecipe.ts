import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'

type NativeRecipe = {inputs: {filename: string; sha256: string}[]; sha256: string}

const digest = (inputs: NativeRecipe['inputs']) => {
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex')
}

export const normalizeNativeRecipe = (recipe: NativeRecipe): NativeRecipe => {
  assert.match(recipe.sha256, /^[a-f0-9]{64}$/, 'Invalid original native recipe digest')
  assert.equal(recipe.sha256, digest(recipe.inputs), 'Original native recipe digest does not match its inputs')
  const inputs = recipe.inputs.map((input) => {
    assert.equal(typeof input.filename, 'string', 'Native recipe filename must be a string')
    const filename = input.filename.replaceAll('\\', '/')
    assert.ok(
      filename.length > 0
        && !filename.startsWith('/')
        && !/^[a-z]:/i.test(filename)
        && filename.split('/').every((part) => {
          return part !== '' && part !== '.' && part !== '..'
        }),
      `Native recipe requires a safe relative path: ${input.filename}`,
    )
    assert.match(input.sha256, /^[a-f0-9]{64}$/, `Invalid native recipe content hash: ${filename}`)
    return {filename, sha256: input.sha256}
  })
  inputs.sort((left, right) => {
    return left.filename < right.filename ? -1 : left.filename > right.filename ? 1 : 0
  })
  assert.equal(
    new Set(
      inputs.map(({filename}) => {
        return filename
      }),
    ).size,
    inputs.length,
    'Native recipe contains duplicate canonical paths',
  )
  return {inputs, sha256: digest(inputs)}
}

export const assertNativeRecipeMatches = (actual: NativeRecipe, expected: NativeRecipe) => {
  const canonical = normalizeNativeRecipe(actual)
  assert.deepEqual(canonical, normalizeNativeRecipe(expected), 'Native targets used different build recipes')
  return canonical
}
