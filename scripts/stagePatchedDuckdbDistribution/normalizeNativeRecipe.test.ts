import {createHash} from 'node:crypto'

import {expect, test} from 'bun:test'

import {assertNativeRecipeMatches, normalizeNativeRecipe} from './normalizeNativeRecipe'

const recipe = (inputs: {filename: string; sha256: string}[]) => {
  return {inputs, sha256: createHash('sha256').update(JSON.stringify(inputs)).digest('hex')}
}
const firstHash = 'a'.repeat(64)
const secondHash = 'b'.repeat(64)

test('Windows and Unix native input representations match only the same canonical byte inventory', () => {
  const unix = recipe([
    {filename: 'scripts/compile.ts', sha256: firstHash},
    {filename: 'vendor/recipe.json', sha256: secondHash},
  ])
  const windows = recipe([
    {filename: 'vendor\\recipe.json', sha256: secondHash},
    {filename: 'scripts\\compile.ts', sha256: firstHash},
  ])
  const original = JSON.stringify(windows)
  expect(windows.sha256).not.toBe(unix.sha256)
  expect(assertNativeRecipeMatches(windows, unix)).toEqual(normalizeNativeRecipe(unix))
  expect(JSON.stringify(windows)).toBe(original)
  expect(() => {
    return assertNativeRecipeMatches(recipe([{filename: 'scripts/compile.ts', sha256: secondHash}]), unix)
  }).toThrow('different build recipes')
  expect(() => {
    return assertNativeRecipeMatches(recipe([{filename: 'scripts/other.ts', sha256: firstHash}]), unix)
  }).toThrow('different build recipes')
})

test('native recipe validation verifies the original digest before canonical comparison', () => {
  const original = recipe([{filename: 'scripts\\compile.ts', sha256: firstHash}])
  expect(() => {
    return normalizeNativeRecipe({...original, sha256: secondHash})
  }).toThrow('Original native recipe digest')
  expect(() => {
    return normalizeNativeRecipe({...original, inputs: [{filename: 'scripts/compile.ts', sha256: firstHash}]})
  }).toThrow('Original native recipe digest')
  expect(() => {
    return normalizeNativeRecipe(recipe([{filename: 'scripts/compile.ts', sha256: 'invalid'}]))
  }).toThrow('Invalid native recipe content hash')
})

test('native recipe canonicalization rejects unsafe and duplicate paths', () => {
  for (const filename of [
    '',
    '/absolute',
    '\\absolute',
    'C:/absolute',
    'C:relative',
    '\\\\server\\share',
    '../up',
    'a/../up',
    'a\\..\\up',
    './relative',
    'a//b',
  ]) {
    expect(() => {
      return normalizeNativeRecipe(recipe([{filename, sha256: firstHash}]))
    }).toThrow('safe relative path')
  }
  expect(() => {
    return normalizeNativeRecipe(
      recipe([
        {filename: 'scripts/compile.ts', sha256: firstHash},
        {filename: 'scripts\\compile.ts', sha256: firstHash},
      ]),
    )
  }).toThrow('duplicate canonical paths')
})
