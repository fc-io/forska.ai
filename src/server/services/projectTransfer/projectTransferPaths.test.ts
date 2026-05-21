import {expect, test} from 'bun:test'

import {
  type ProjectTransferPathErrorCode,
  projectTransferPathLimits,
  type ProjectTransferPathValidationResult,
  resolveProjectTransferArchiveMemberWritablePath,
  resolveProjectTransferPersistedRuntimeAssetPath,
  resolveProjectTransferPromotionWritablePath,
  resolveProjectTransferTempWritablePath,
  validateProjectTransferArchiveMemberPath,
  validateProjectTransferArchiveMemberPaths,
  validateProjectTransferRuntimeAssetPath,
  validateProjectTransferRuntimeAssetPaths,
} from './projectTransferPaths.ts'

const expectInvalidPath = <TValue>(
  result: ProjectTransferPathValidationResult<TValue>,
  code: ProjectTransferPathErrorCode,
) => {
  expect(result.ok).toBe(false)

  if (!result.ok) {
    expect(result.error.code).toBe(code)
  }
}

const getValidatedPaths = <TValue extends {path: string}>(result: ProjectTransferPathValidationResult<TValue[]>) => {
  return result.ok
    ? result.value.map((pathValue) => {
        return pathValue.path
      })
    : []
}

test('accepts allowlisted project transfer archive roots and asset members', () => {
  const paths = [
    'manifest.json',
    'project.json',
    'articles.ndjson',
    'assetManifest.json',
    'assets/article-pdfs/article-1.pdf',
    'assets/project-transfer/session-1/image-1.png',
  ]
  const result = validateProjectTransferArchiveMemberPaths({paths})

  expect(result.ok).toBe(true)
  expect(getValidatedPaths(result)).toEqual(paths)
})

test('rejects unsafe project transfer archive member paths', () => {
  const oversizedPath = `assets/${'a'.repeat(projectTransferPathLimits.maxPathLength)}`
  const oversizedSegmentPath = `assets/${'a'.repeat(projectTransferPathLimits.maxPathSegmentLength + 1)}`
  const cases: Array<[ProjectTransferPathErrorCode, string]> = [
    ['empty_path', ''],
    ['nul_byte', 'assets/file\u0000.pdf'],
    ['raw_backslash', 'assets\\file.pdf'],
    ['absolute_path', '/manifest.json'],
    ['absolute_path', 'C:/manifest.json'],
    ['traversal', '../manifest.json'],
    ['traversal', 'assets/../manifest.json'],
    ['path_too_long', oversizedPath],
    ['segment_too_long', oversizedSegmentPath],
    ['normalization_changed', 'assets//file.pdf'],
    ['normalization_changed', 'assets/./file.pdf'],
    ['normalization_changed', 'assets/file.pdf/'],
    ['disallowed_root', 'tmp/project-transfer/upload.zip'],
  ]

  expect(
    cases.map(([code, pathValue]) => {
      const result = validateProjectTransferArchiveMemberPath({pathValue})

      return result.ok ? null : result.error.code === code
    }),
  ).toEqual(
    cases.map(() => {
      return true
    }),
  )
})

test('rejects duplicate and colliding project transfer archive paths', () => {
  const exactDuplicate = validateProjectTransferArchiveMemberPaths({paths: ['assets/report.pdf', 'assets/report.pdf']})
  const caseCollision = validateProjectTransferArchiveMemberPaths({paths: ['assets/Report.pdf', 'assets/report.pdf']})
  const unicodeCollision = validateProjectTransferArchiveMemberPaths({
    paths: ['assets/e\u0301.txt', 'assets/\u00e9.txt'],
  })

  expectInvalidPath(exactDuplicate, 'duplicate_path')
  expectInvalidPath(caseCollision, 'duplicate_path')
  expectInvalidPath(unicodeCollision, 'duplicate_path')
})

test('accepts valid runtime asset paths and rejects unsafe persisted asset paths', () => {
  const validResult = validateProjectTransferRuntimeAssetPaths({
    paths: ['assets/article_pdfs/test.pdf', 'assets/project-transfer/session-1/file.pdf'],
  })

  expect(validResult.ok).toBe(true)
  expect(getValidatedPaths(validResult)).toEqual([
    'assets/article_pdfs/test.pdf',
    'assets/project-transfer/session-1/file.pdf',
  ])

  expectInvalidPath(validateProjectTransferRuntimeAssetPath('manifest.json'), 'runtime_asset_outside_assets')
  expectInvalidPath(validateProjectTransferRuntimeAssetPath('assets\\article_pdfs\\test.pdf'), 'raw_backslash')
  expectInvalidPath(validateProjectTransferRuntimeAssetPath('/tmp/test.pdf'), 'absolute_path')
  expectInvalidPath(validateProjectTransferRuntimeAssetPath('assets/../secret.pdf'), 'traversal')
  expectInvalidPath(validateProjectTransferRuntimeAssetPath('assets//test.pdf'), 'normalization_changed')
})

test('resolves temp, extraction, promotion, and persisted paths through the correct runtime helper contract', () => {
  const runtimeOptions = {cwd: '/runtime/root', envValues: {}}

  expect(
    resolveProjectTransferTempWritablePath({
      ...runtimeOptions,
      pathValue: 'tmp/project-transfer/import/session-1/upload.zip',
    }),
  ).toBe('/runtime/root/tmp/project-transfer/import/session-1/upload.zip')
  expect(
    resolveProjectTransferArchiveMemberWritablePath({
      ...runtimeOptions,
      archiveMemberPath: 'assets/article-pdfs/article-1.pdf',
      extractionRootPath: 'tmp/project-transfer/import/session-1/extracted',
    }),
  ).toBe('/runtime/root/tmp/project-transfer/import/session-1/extracted/assets/article-pdfs/article-1.pdf')
  expect(
    resolveProjectTransferPromotionWritablePath({
      ...runtimeOptions,
      pathValue: 'assets/project-transfer/session-1/article-1.pdf',
    }),
  ).toBe('/runtime/root/assets/project-transfer/session-1/article-1.pdf')
  expect(
    resolveProjectTransferPersistedRuntimeAssetPath({...runtimeOptions, pathValue: 'assets/article_pdfs/test.pdf'}),
  ).toBe('/runtime/root/assets/article_pdfs/test.pdf')
})

test('rejects unsafe runtime writable and persisted file resolutions', () => {
  const runtimeOptions = {cwd: '/runtime/root', envValues: {}}

  expect(() => {
    return resolveProjectTransferTempWritablePath({...runtimeOptions, pathValue: 'assets/project-transfer/upload.zip'})
  }).toThrow('Project transfer writable path root is not allowlisted')
  expect(() => {
    return resolveProjectTransferArchiveMemberWritablePath({
      ...runtimeOptions,
      archiveMemberPath: '../manifest.json',
      extractionRootPath: 'tmp/project-transfer/import/session-1/extracted',
    })
  }).toThrow('Project transfer path contains traversal')
  expect(() => {
    return resolveProjectTransferPromotionWritablePath({...runtimeOptions, pathValue: 'assets/article_pdfs/test.pdf'})
  }).toThrow('Project transfer writable path root is not allowlisted')
  expect(() => {
    return resolveProjectTransferPersistedRuntimeAssetPath({...runtimeOptions, pathValue: '/tmp/test.pdf'})
  }).toThrow('Project transfer path must be relative')
})
