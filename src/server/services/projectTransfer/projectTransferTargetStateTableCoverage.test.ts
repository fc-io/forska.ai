import {existsSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import {dirname, join, relative} from 'node:path'

import {expect, test} from 'bun:test'

import {
  projectTransferTargetStateSafetySurfaces,
  projectTransferTargetStateTablesBySurface,
  projectTransferTargetStateTrackedTables,
} from './projectTransferTargetStateDirtyTokenService.ts'

const repositoryRoot = join(import.meta.dir, '../../../..')

const targetStateReaderFiles = [
  'src/server/services/projectTransfer/projectTransferAnalyze.ts',
  'src/server/services/projectTransfer/projectTransferAnalyzeTarget.ts',
  'src/server/services/projectTransfer/projectTransferCommit.ts',
  'src/server/services/projectTransfer/projectTransferDependencyResolution.ts',
  'src/server/services/projectTransfer/projectTransferDuplicateDetection.ts',
  'src/server/services/projectTransfer/projectTransferFidelityValidation.ts',
  'src/server/services/projectTransfer/projectTransferHistoryRepository.ts',
  'src/server/services/projectTransfer/projectTransferIdentifierNormalization.ts',
  'src/server/services/projectTransfer/projectTransferImportedSnapshotReuse.ts',
  'src/server/services/projectTransfer/projectTransferOperationTables.ts',
  'src/server/services/projectTransfer/projectTransferSnapshotFingerprint.ts',
  'src/server/providers/providerConnectionHelpers.ts',
  'src/server/providers/providerConnectionRepository.ts',
  'src/server/providers/providerDbUtils.ts',
  'src/server/providers/providerModelMetadata.ts',
  'src/server/providers/providerModelRepository.ts',
  'src/server/providers/ensureCodexProviderModel.ts',
  'src/server/services/appQueryHelpers.ts',
] as const

const targetStateReaderEntryFiles = [
  'src/server/services/projectTransfer/projectTransferAnalyzeTarget.ts',
  'src/server/services/projectTransfer/projectTransferDependencyResolution.ts',
  'src/server/services/projectTransfer/projectTransferDuplicateDetection.ts',
  'src/server/services/projectTransfer/projectTransferFidelityValidation.ts',
  'src/server/services/projectTransfer/projectTransferHistoryRepository.ts',
  'src/server/services/projectTransfer/projectTransferIdentifierNormalization.ts',
  'src/server/services/projectTransfer/projectTransferImportedSnapshotReuse.ts',
  'src/server/services/projectTransfer/projectTransferOperationTables.ts',
  'src/server/services/projectTransfer/projectTransferSnapshotFingerprint.ts',
] as const

const targetStateReaderWalkDirectories = ['src/server/services/projectTransfer/', 'src/server/providers/'] as const

const targetStateReaderImportExclusions: Record<string, {allowedImports: readonly string[] | null; reason: string}> = {
  'src/server/services/appDatabaseService.ts': {
    allowedImports: ['getAppDatabaseService'],
    reason: 'the SQL executor; its only app table reference is the appendJudgments writer',
  },
  'src/server/reviewServing/reviewConfigReviewServingDeltaService.ts': {
    allowedImports: [
      'appendProviderConnectionExecutionIdentityReviewServingDeltas',
      'appendProviderModelExecutionIdentityReviewServingDeltas',
    ],
    reason: 'provider and model writers append review-serving deltas through it; no revalidation read calls it',
  },
  'src/server/services/projectTransfer/projectTransferExport.ts': {
    allowedImports: [
      'getProjectTransferExportHumanReviewInputSignature',
      'getProjectTransferExportJudgmentInputSignature',
    ],
    reason: 'fidelity uses only the pure input-signature helpers; the module SQL serves export',
  },
  'src/server/services/projectTransfer/projectTransferTargetStateDirtyTokenService.ts': {
    allowedImports: null,
    reason: 'reads the target-state token tables, which the revalidation decision compares itself',
  },
}

const valueImportPattern = /^import\s+(?!type\s)([^;']*?)\s+from\s+'(\.[^']+)'/gm

const targetStateDataModulePattern = /\bapp\s*\.\s*"?[A-Za-z_]|getAppDatabaseService\(/

const appTableReferencePattern = /\bapp\s*\.\s*"?([A-Za-z_][A-Za-z0-9_]*)"?/g

const dynamicAppTableReferencePattern = /\bapp\s*\.\s*\$\{/

const getAppTableReferences = (source: string) => {
  return Array.from(source.matchAll(appTableReferencePattern), (match) => {
    return `app.${String(match[1]).toLowerCase()}`
  })
}

const getTargetStateReaderSources = async () => {
  return Promise.all(
    targetStateReaderFiles.map(async (file) => {
      return {file, source: await readFile(join(repositoryRoot, file), 'utf8')}
    }),
  )
}

test('every app table read by import analysis and commit revalidation maps to a target-state surface', async () => {
  const trackedTables = new Set<string>(projectTransferTargetStateTrackedTables)
  const sources = await getTargetStateReaderSources()
  const untrackedReferences = sources.flatMap(({file, source}) => {
    return Array.from(new Set(getAppTableReferences(source)))
      .filter((table) => {
        return !trackedTables.has(table)
      })
      .map((table) => {
        return `${file}: ${table}`
      })
  })
  const dynamicReferences = sources.flatMap(({file, source}) => {
    return dynamicAppTableReferencePattern.test(source) ? [file] : []
  })
  const referencedTables = new Set(
    sources.flatMap(({source}) => {
      return getAppTableReferences(source)
    }),
  )

  expect(untrackedReferences).toEqual([])
  expect(dynamicReferences).toEqual([])
  expect(referencedTables.has('app.article')).toBe(true)
  expect(referencedTables.has('app.judgment')).toBe(true)
  expect(referencedTables.has('app.provider_connection')).toBe(true)
})

test('every target-state safety surface maps to at least one tracked app table', () => {
  const surfacesWithoutTables = projectTransferTargetStateSafetySurfaces.filter((surface) => {
    const tables: readonly string[] = projectTransferTargetStateTablesBySurface[surface]

    return tables.length === 0
  })
  const tablesOutsideAppSchema = projectTransferTargetStateTrackedTables.filter((table) => {
    return !/^app\.[a-z_]+$/.test(table)
  })

  expect(surfacesWithoutTables).toEqual([])
  expect(tablesOutsideAppSchema).toEqual([])
  expect(Object.keys(projectTransferTargetStateTablesBySurface).sort()).toEqual(
    [...projectTransferTargetStateSafetySurfaces].sort(),
  )
})

const getImportedNames = (clause: string) => {
  return clause
    .replace(/[{}]/g, '')
    .split(',')
    .map((name) => {
      return name.trim()
    })
    .filter((name) => {
      return name !== '' && !name.startsWith('type ')
    })
    .map((name) => {
      return name.split(/\s+as\s+/)[0] ?? name
    })
}

const getTargetStateReaderImports = (file: string, source: string) => {
  return Array.from(source.matchAll(valueImportPattern), (match) => {
    return {
      file: relative(repositoryRoot, join(repositoryRoot, dirname(file), String(match[2]))),
      names: getImportedNames(String(match[1])),
    }
  }).filter((entry) => {
    return entry.names.length > 0 && existsSync(join(repositoryRoot, entry.file))
  })
}

const getTargetStateReaderImportViolations = (
  importingFile: string,
  imported: {file: string; names: string[]},
  isDataModule: boolean,
) => {
  const exclusion = targetStateReaderImportExclusions[imported.file]
  const scanned = (targetStateReaderFiles as readonly string[]).includes(imported.file)
  const disallowedNames =
    exclusion?.allowedImports === undefined || exclusion.allowedImports === null
      ? []
      : imported.names.filter((name) => {
          return !exclusion.allowedImports?.includes(name)
        })

  return !isDataModule || scanned
    ? []
    : exclusion === undefined
      ? [`${importingFile} imports unscanned data module ${imported.file}`]
      : disallowedNames.map((name) => {
          return `${importingFile} imports ${name} from excluded ${imported.file}`
        })
}

const shouldWalkTargetStateReaderImport = (file: string, isDataModule: boolean) => {
  return (
    (targetStateReaderFiles as readonly string[]).includes(file)
    || (!isDataModule
      && targetStateReaderWalkDirectories.some((directory) => {
        return file.startsWith(directory)
      }))
  )
}

const walkTargetStateReaderImports = async (
  pending: readonly string[],
  visited: ReadonlySet<string>,
  violations: readonly string[],
): Promise<string[]> => {
  const [file, ...rest] = pending

  if (file === undefined) {
    return [...violations]
  }

  if (visited.has(file)) {
    return walkTargetStateReaderImports(rest, visited, violations)
  }

  const imports = getTargetStateReaderImports(file, await readFile(join(repositoryRoot, file), 'utf8'))
  const importedSources = await Promise.all(
    imports.map(async (imported) => {
      return {imported, source: await readFile(join(repositoryRoot, imported.file), 'utf8')}
    }),
  )
  const nextViolations = importedSources.flatMap(({imported, source}) => {
    return getTargetStateReaderImportViolations(file, imported, targetStateDataModulePattern.test(source))
  })
  const nextPending = importedSources
    .filter(({imported, source}) => {
      return shouldWalkTargetStateReaderImport(imported.file, targetStateDataModulePattern.test(source))
    })
    .map(({imported}) => {
      return imported.file
    })

  return walkTargetStateReaderImports([...rest, ...nextPending], new Set([...visited, file]), [
    ...violations,
    ...nextViolations,
  ])
}

test('every data module that analysis and dependency revalidation import is scanned or explicitly excluded', async () => {
  const violations = await walkTargetStateReaderImports(targetStateReaderEntryFiles, new Set(), [])

  expect(violations).toEqual([])
  expect(
    targetStateReaderEntryFiles.every((file) => {
      return (targetStateReaderFiles as readonly string[]).includes(file)
    }),
  ).toBe(true)
})
