export type PromptFilterOption = {label: string; value: string}

export type PromptFilterControl = {
  debugDisplayState?: 'mart/fast' | 'mart/slow' | 'project/fast' | 'project/slow'
  kind: 'numeric' | 'openString' | 'schemaEnum'
  label: string
  optionSourceState?: 'fast' | 'schema' | 'slow' | 'unavailable'
  options: PromptFilterOption[]
  promptId: string
  readiness?: 'fast' | 'slow'
  source?: 'mart' | 'project'
}

export type PromptFilterControlsResponse = {controls: PromptFilterControl[]; humanJudgmentMode?: 'prompt' | 'summary'}

type UnknownRecord = Record<string, unknown>

const isRecord = (value: unknown): value is UnknownRecord => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getString = (record: UnknownRecord, key: string): string | undefined => {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

const getStringArray = (value: unknown): string[] => {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => {
        return typeof entry === 'string'
      })
    : []
}

const getOptions = (value: unknown): PromptFilterOption[] => {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((entry) => {
    if (typeof entry === 'string') {
      return [{label: entry, value: entry}]
    }
    if (!isRecord(entry)) {
      return []
    }

    const optionValue = getString(entry, 'value') ?? getString(entry, 'canonicalValue')
    if (!optionValue) {
      return []
    }

    return [{label: getString(entry, 'label') ?? getString(entry, 'displayLabel') ?? optionValue, value: optionValue}]
  })
}

const getLegacyNumericOptions = (filter: UnknownRecord): PromptFilterOption[] => {
  const bins = Array.isArray(filter.bins) ? filter.bins : []
  const binOptions = bins.flatMap((bin) => {
    if (!isRecord(bin) || typeof bin.min !== 'number' || typeof bin.max !== 'number') {
      return []
    }

    const value = `bin:${bin.min}:${bin.max}`
    return [{label: getString(bin, 'label') ?? value, value}]
  })
  const specialOptions = getStringArray(filter.specialValues).map((value) => {
    return {label: value, value}
  })

  return [...binOptions, ...specialOptions]
}

const getDefinitionControl = (value: unknown): PromptFilterControl | null => {
  if (!isRecord(value)) {
    return null
  }

  const promptId = getString(value, 'promptId')
  const kind = getString(value, 'kind')
  if (!promptId || (kind !== 'schemaEnum' && kind !== 'openString' && kind !== 'numeric')) {
    return null
  }

  const source = getString(value, 'source')
  const readiness = getString(value, 'articleReadinessState') ?? getString(value, 'readiness')
  const debugDisplayState = getString(value, 'debugDisplayState')
  const optionSourceState = getString(value, 'optionSourceState')

  return {
    debugDisplayState:
      debugDisplayState === 'mart/fast'
      || debugDisplayState === 'mart/slow'
      || debugDisplayState === 'project/fast'
      || debugDisplayState === 'project/slow'
        ? debugDisplayState
        : undefined,
    kind,
    label: getString(value, 'label') ?? getString(value, 'promptName') ?? `Prompt ${promptId}`,
    options:
      kind === 'numeric' && !Array.isArray(value.options)
        ? getLegacyNumericOptions(value)
        : getOptions(value.options ?? value.answeredOriginalValues),
    optionSourceState:
      optionSourceState === 'fast'
      || optionSourceState === 'schema'
      || optionSourceState === 'slow'
      || optionSourceState === 'unavailable'
        ? optionSourceState
        : undefined,
    promptId,
    readiness: readiness === 'fast' || readiness === 'slow' ? readiness : undefined,
    source: source === 'mart' || source === 'project' ? source : undefined,
  }
}

const getLegacyControl = (value: unknown): PromptFilterControl | null => {
  if (!isRecord(value)) {
    return null
  }

  const promptId = getString(value, 'promptId')
  if (!promptId) {
    return null
  }

  const isNumeric = value.filterType === 'numeric'
  const answeredOriginalValues = getStringArray(value.answeredOriginalValues)

  return {
    kind: isNumeric ? 'numeric' : 'openString',
    label: getString(value, 'promptName') ?? getString(value, 'label') ?? `Prompt ${promptId}`,
    options: isNumeric
      ? getLegacyNumericOptions(value)
      : answeredOriginalValues.map((optionValue) => {
          return {label: optionValue, value: optionValue}
        }),
    promptId,
  }
}

const getControls = (
  values: unknown,
  adapter: (value: unknown) => PromptFilterControl | null,
): PromptFilterControl[] => {
  return Array.isArray(values)
    ? values.flatMap((value) => {
        const control = adapter(value)
        return control ? [control] : []
      })
    : []
}

export const getPromptFilterControls = (response: unknown): PromptFilterControlsResponse => {
  if (Array.isArray(response)) {
    return {controls: getControls(response, getLegacyControl)}
  }
  if (!isRecord(response)) {
    return {controls: []}
  }

  const humanJudgmentMode =
    response.humanJudgmentMode === 'prompt' || response.humanJudgmentMode === 'summary'
      ? response.humanJudgmentMode
      : undefined

  return {
    controls: Object.hasOwn(response, 'promptFilterDefinitions')
      ? getControls(response.promptFilterDefinitions, getDefinitionControl)
      : getControls(response.filters, getLegacyControl),
    humanJudgmentMode,
  }
}

const getPromptFilterSourceLabel = (control: PromptFilterControl): string | null => {
  if (control.source === 'project') {
    return 'project prompt'
  }
  if (control.source === 'mart') {
    return 'review index'
  }

  return null
}

const getPromptFilterStatusLabel = (control: PromptFilterControl): string | null => {
  if (control.optionSourceState === 'schema') {
    return 'Project schema options'
  }
  if (control.optionSourceState === 'fast' || control.optionSourceState === 'slow') {
    return 'Indexed answer options'
  }
  if (control.optionSourceState === 'unavailable') {
    return 'No indexed answer options yet'
  }

  return null
}

export const getPromptFilterLabel = (control: PromptFilterControl): string => {
  const sourceLabel = getPromptFilterSourceLabel(control)

  return sourceLabel ? `${control.label} (${sourceLabel})` : control.label
}

export const getPromptFilterTitle = (control: PromptFilterControl): string => {
  const sourceLabel = getPromptFilterSourceLabel(control)
  const statusLabel = getPromptFilterStatusLabel(control)
  const details = [sourceLabel, statusLabel].filter((detail): detail is string => {
    return typeof detail === 'string'
  })

  return details.length > 0 ? `${control.label} (${details.join('; ')})` : control.label
}

export const reconcileSchemaEnumSelections = (
  previous: Record<string, string[] | null>,
  controls: readonly PromptFilterControl[],
): Record<string, string[] | null> => {
  const allowedByPrompt = new Map(
    controls
      .filter((control) => {
        return control.kind === 'schemaEnum' && control.optionSourceState === 'schema'
      })
      .map((control) => {
        return [
          control.promptId,
          new Set(
            control.options.map((option) => {
              return option.value
            }),
          ),
        ] as const
      }),
  )
  let changed = false
  const next = Object.fromEntries(
    Object.entries(previous).map(([promptId, values]) => {
      const allowed = allowedByPrompt.get(promptId)
      if (!allowed || !Array.isArray(values)) {
        return [promptId, values]
      }

      const validValues = values.filter((value) => {
        return allowed.has(value)
      })
      if (validValues.length === values.length) {
        return [promptId, values]
      }

      changed = true
      return [promptId, validValues.length > 0 ? validValues : null]
    }),
  )

  return changed ? next : previous
}
