// @vitest-environment happy-dom

import type {Component, JSX, ParentProps} from 'solid-js'
import {splitProps} from 'solid-js'
import {Dynamic} from 'solid-js/web'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

type MockLinkProps = ParentProps<{class?: string; params?: {id?: string}; to: string}>
type MockButtonProps = ParentProps<
  {as?: keyof JSX.IntrinsicElements | Component<Record<string, unknown>>} & Record<string, unknown>
>

const mockState = vi.hoisted(() => {
  const transferArtifact = {
    exportedAt: '2026-06-10T12:00:00.000Z',
    format: 'forska.comparisonProject.conflictResolution.transfer',
    rows: [
      {
        externalArticleId: 'external-1',
        identifiers: [],
        resolution: {label: 'Yes', mode: 'summary', value: 'yes'},
        sourceArticleRowId: 'article-1',
        sourceResolutionId: 'resolution-1',
        title: 'Article 1',
      },
    ],
    source: {
      comparisonProjectDescription: null,
      comparisonProjectId: 'source-comparison-project-1',
      comparisonProjectName: 'Source comparison',
    },
    version: 1,
  } as const
  const analyzePreview = {
    importableRows: [],
    skippedRows: [],
    source: {
      comparisonProjectDescription: null,
      comparisonProjectId: 'source-comparison-project-1',
      comparisonProjectName: 'Source comparison',
      exportedAt: '2026-06-10T12:00:00.000Z',
      format: 'forska.comparisonProject.conflictResolution.transfer',
      rowCount: 1,
      version: 1,
    },
    summary: {
      deduped: 0,
      importable: 1,
      matched: 1,
      scanned: 1,
      skipped: 0,
      skippedAmbiguousTarget: 0,
      skippedConflicting: 0,
      skippedExisting: 0,
      skippedInvalidValue: 0,
      skippedNoTargetMatch: 0,
      skippedNoUsableKey: 0,
      skippedNotConflicting: 0,
      skippedUnsupportedMode: 0,
      sameValue: 0,
      overwriteCandidates: 0,
    },
    warnings: [],
  }

  return {
    analyzePreview,
    analyzeComparisonProjectConflictResolutionImport: vi.fn(
      async (_comparisonProjectId: string, _artifact: unknown) => {
        return analyzePreview
      },
    ),
    analyzeComparisonProjectConflictResolutionPdfImport: vi.fn(
      async (_comparisonProjectId: string, request: {pdfUndecidedMode?: 'clear' | 'ignore'}) => {
        return {
          ...analyzePreview,
          source: {
            ...analyzePreview.source,
            importKind: 'pdf' as const,
            pdfUndecidedMode: request.pdfUndecidedMode ?? 'ignore',
            pdfUndecidedRowCount: 2,
          },
        }
      },
    ),
    commitComparisonProjectConflictResolutionImport: vi.fn(),
    commitComparisonProjectConflictResolutionPdfImport: vi.fn(),
    fetchComparisonProjectJudgmentsMetadata: vi.fn(async () => {
      return {allowConflictResolution: true, name: 'Target comparison'}
    }),
    queryClient: {invalidateQueries: vi.fn()},
    transferArtifact,
  }
})

vi.mock('@tanstack/solid-query', () => {
  return {
    useMutation: (
      factory: () => {
        mutationFn?: (input: unknown) => unknown
        onError?: (error: unknown, input: unknown) => void
        onSuccess?: (value: unknown, input: unknown) => void
      },
    ) => {
      const options = factory()

      return {
        isPending: false,
        mutate: vi.fn((input: unknown) => {
          const result = options.mutationFn?.(input)

          void Promise.resolve(result).then(
            (value) => {
              options.onSuccess?.(value, input)
            },
            (error: unknown) => {
              options.onError?.(error, input)
            },
          )

          return result
        }),
      }
    },
    useQuery: () => {
      return {data: {allowConflictResolution: true, name: 'Target comparison'}, isError: false, isPending: false}
    },
    useQueryClient: () => {
      return mockState.queryClient
    },
  }
})

vi.mock('@tanstack/solid-router', () => {
  return {
    Link: (props: MockLinkProps) => {
      return (
        <a class={props.class} href={props.params?.id ? props.to.replace('$id', props.params.id) : props.to}>
          {props.children}
        </a>
      )
    },
    createFileRoute: () => {
      return (config: Record<string, unknown>) => {
        return {
          ...config,
          useParams: () => {
            return () => {
              return {id: 'comparison-project-1'}
            }
          },
        }
      }
    },
  }
})

vi.mock('../../../../components/ui/button', () => {
  return {
    Button: (props: MockButtonProps) => {
      const [local, otherProps] = splitProps(props, ['as', 'children'])

      return (
        <Dynamic component={local.as ?? 'button'} {...otherProps}>
          {local.children}
        </Dynamic>
      )
    },
  }
})

vi.mock('../../../../services/comparisonProjectsService.ts', () => {
  return {
    analyzeComparisonProjectConflictResolutionImport: mockState.analyzeComparisonProjectConflictResolutionImport,
    analyzeComparisonProjectConflictResolutionPdfImport: mockState.analyzeComparisonProjectConflictResolutionPdfImport,
    commitComparisonProjectConflictResolutionImport: mockState.commitComparisonProjectConflictResolutionImport,
    commitComparisonProjectConflictResolutionPdfImport: mockState.commitComparisonProjectConflictResolutionPdfImport,
    fetchComparisonProjectJudgmentsMetadata: mockState.fetchComparisonProjectJudgmentsMetadata,
  }
})

const tick = () => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

const waitForCondition = async (assertion: () => void, remaining = 30): Promise<void> => {
  try {
    assertion()
  } catch (error) {
    if (remaining <= 0) {
      throw error
    }

    await tick()
    return waitForCondition(assertion, remaining - 1)
  }
}

const getFileList = (file: File) => {
  return {
    0: file,
    item: (index: number) => {
      return index === 0 ? file : null
    },
    length: 1,
  } as unknown as FileList
}

const getInputFromLabel = (container: HTMLElement, labelText: string): HTMLInputElement => {
  const label = Array.from(container.querySelectorAll('label')).find((candidateLabel) => {
    return candidateLabel.textContent?.trim().startsWith(labelText)
  })
  const input = label?.querySelector('input')

  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Input not found for label ${labelText}`)
  }

  return input
}

const renderImportResolutionsPage = async () => {
  const {render} = await import('solid-js/web')
  const {CompareProjectImportResolutionsPage} = await import('./+import-resolutions.tsx')

  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return <CompareProjectImportResolutionsPage />
  }, container)

  await Promise.resolve()

  return {container, dispose}
}

beforeEach(() => {
  document.body.innerHTML = ''
  mockState.analyzeComparisonProjectConflictResolutionImport.mockClear()
  mockState.analyzeComparisonProjectConflictResolutionPdfImport.mockClear()
  mockState.commitComparisonProjectConflictResolutionImport.mockClear()
  mockState.commitComparisonProjectConflictResolutionPdfImport.mockClear()
  mockState.fetchComparisonProjectJudgmentsMetadata.mockClear()
  mockState.queryClient.invalidateQueries.mockClear()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('CompareProjectImportResolutionsPage', () => {
  test('analyzes a selected conflict-resolution export automatically', async () => {
    const {container, dispose} = await renderImportResolutionsPage()

    try {
      const input = container.querySelector('[data-testid="conflict-resolution-import-file"]')
      const file = new File([JSON.stringify(mockState.transferArtifact)], 'conflict-resolutions.json', {
        type: 'application/json',
      })

      if (!(input instanceof HTMLInputElement)) {
        throw new Error('Import file input not found')
      }

      Object.defineProperty(input, 'files', {configurable: true, value: getFileList(file)})
      input.dispatchEvent(new Event('change', {bubbles: true}))

      await waitForCondition(() => {
        expect(mockState.analyzeComparisonProjectConflictResolutionImport).toHaveBeenCalledWith(
          'comparison-project-1',
          {artifact: mockState.transferArtifact, importMode: 'conflicting-only', overwriteMode: 'skip-existing'},
        )
        expect(container.textContent).toContain('Analyze result')
      })
    } finally {
      dispose()
      container.remove()
    }
  })

  test('reanalyzes a selected file when import scope changes', async () => {
    const {container, dispose} = await renderImportResolutionsPage()

    try {
      const input = container.querySelector('[data-testid="conflict-resolution-import-file"]')
      const file = new File([JSON.stringify(mockState.transferArtifact)], 'conflict-resolutions.json', {
        type: 'application/json',
      })

      if (!(input instanceof HTMLInputElement)) {
        throw new Error('Import file input not found')
      }

      Object.defineProperty(input, 'files', {configurable: true, value: getFileList(file)})
      input.dispatchEvent(new Event('change', {bubbles: true}))

      await waitForCondition(() => {
        expect(mockState.analyzeComparisonProjectConflictResolutionImport).toHaveBeenCalledTimes(1)
      })

      getInputFromLabel(container, 'All matched articles').click()

      await waitForCondition(() => {
        expect(mockState.analyzeComparisonProjectConflictResolutionImport).toHaveBeenCalledWith(
          'comparison-project-1',
          {artifact: mockState.transferArtifact, importMode: 'all-matched', overwriteMode: 'skip-existing'},
        )
      })
    } finally {
      dispose()
      container.remove()
    }
  })

  test('offers overwrite mode when rows are skipped by existing target resolutions', async () => {
    mockState.analyzeComparisonProjectConflictResolutionImport.mockResolvedValueOnce({
      ...mockState.analyzePreview,
      summary: {...mockState.analyzePreview.summary, importable: 0, skipped: 1, skippedExisting: 1},
    })

    const {container, dispose} = await renderImportResolutionsPage()

    try {
      const input = container.querySelector('[data-testid="conflict-resolution-import-file"]')
      const file = new File([JSON.stringify(mockState.transferArtifact)], 'conflict-resolutions.json', {
        type: 'application/json',
      })

      if (!(input instanceof HTMLInputElement)) {
        throw new Error('Import file input not found')
      }

      Object.defineProperty(input, 'files', {configurable: true, value: getFileList(file)})
      input.dispatchEvent(new Event('change', {bubbles: true}))

      await waitForCondition(() => {
        expect(container.textContent).toContain('Existing target decisions')
        expect(container.textContent).toContain('Skip existing target resolutions')
        expect(container.textContent).toContain('Overwrite existing target resolutions')
      })

      getInputFromLabel(container, 'Overwrite existing target resolutions').click()

      expect(container.textContent).toContain('Analyze result')
      expect(container.textContent).toContain('Existing target decisions')

      await waitForCondition(() => {
        expect(mockState.analyzeComparisonProjectConflictResolutionImport).toHaveBeenCalledWith(
          'comparison-project-1',
          {artifact: mockState.transferArtifact, importMode: 'conflicting-only', overwriteMode: 'overwrite-different'},
        )
      })
    } finally {
      dispose()
      container.remove()
    }
  })

  test('sends PDF exports to the server-side PDF analyzer', async () => {
    const {container, dispose} = await renderImportResolutionsPage()

    try {
      const input = container.querySelector('[data-testid="conflict-resolution-import-file"]')
      const file = new File(['%PDF-1.7'], 'conflict-resolutions.pdf', {type: 'application/pdf'})

      if (!(input instanceof HTMLInputElement)) {
        throw new Error('Import file input not found')
      }

      Object.defineProperty(input, 'files', {configurable: true, value: getFileList(file)})
      input.dispatchEvent(new Event('change', {bubbles: true}))

      await waitForCondition(() => {
        expect(mockState.analyzeComparisonProjectConflictResolutionPdfImport).toHaveBeenCalledWith(
          'comparison-project-1',
          {file, importMode: 'conflicting-only', overwriteMode: 'skip-existing', pdfUndecidedMode: 'ignore'},
        )
        expect(mockState.analyzeComparisonProjectConflictResolutionImport).not.toHaveBeenCalled()
      })
    } finally {
      dispose()
      container.remove()
    }
  })

  test('reanalyzes PDF imports when undecided handling changes', async () => {
    const {container, dispose} = await renderImportResolutionsPage()

    try {
      const input = container.querySelector('[data-testid="conflict-resolution-import-file"]')
      const file = new File(['%PDF-1.7'], 'conflict-resolutions.pdf', {type: 'application/pdf'})

      if (!(input instanceof HTMLInputElement)) {
        throw new Error('Import file input not found')
      }

      Object.defineProperty(input, 'files', {configurable: true, value: getFileList(file)})
      input.dispatchEvent(new Event('change', {bubbles: true}))

      await waitForCondition(() => {
        expect(container.textContent).toContain('Undecided PDF selections')
        expect(container.textContent).toContain('Ignore undecided')
        expect(container.textContent).toContain('Set to not set')
      })

      getInputFromLabel(container, 'Set to not set').click()

      await waitForCondition(() => {
        expect(mockState.analyzeComparisonProjectConflictResolutionPdfImport).toHaveBeenCalledWith(
          'comparison-project-1',
          {file, importMode: 'conflicting-only', overwriteMode: 'skip-existing', pdfUndecidedMode: 'clear'},
        )
      })
    } finally {
      dispose()
      container.remove()
    }
  })
})
