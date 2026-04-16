import {createMutation, useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {createEffect, createMemo, createSignal, For, Show} from 'solid-js'
import {createStore} from 'solid-js/store'

import {Button} from '../../../../components/ui/button'
import {apiClient} from '../../../../services/apiClient.ts'
import {handleApiResponse} from '../../../../services/utils/handleApiResponse.ts'
import {postFormDataToApi} from '../../../utils/postFormDataToApi.ts'

type CovidenceImportMode = 'title_abstract' | 'full_text'
type CovidenceFileRole = 'all' | 'irrelevant' | 'full_text' | 'excluded' | 'included'
type CovidencePromptAnswerSet = 'yes|no' | 'yes|no|maybe'
type CovidencePromptGrouping = 'per_field' | 'per_section' | 'single_prompt'
type CovidenceEligibilityDisposition = 'include' | 'exclude'
type CovidenceEligibilitySectionKey =
  | 'population'
  | 'interventionExposure'
  | 'comparatorContext'
  | 'outcome'
  | 'studyCharacteristics'
  | 'other'
type ModelOption = {
  id: string
  label: string
  modelName: string | null
  name: string
  provider: string | null
  version: string | null
}

const covidenceEligibilitySections: Array<{description: string; key: CovidenceEligibilitySectionKey; label: string}> = [
  {
    description: 'Participants, disease state, demographics, setting, or eligibility population details.',
    key: 'population',
    label: 'Population',
  },
  {
    description: 'Treatments, exposures, programs, or index interventions under review.',
    key: 'interventionExposure',
    label: 'Intervention / Exposure',
  },
  {
    description: 'Comparators, controls, background care, or study context requirements.',
    key: 'comparatorContext',
    label: 'Comparator / Context',
  },
  {
    description: 'Outcomes, endpoints, follow-up thresholds, or outcome reporting needs.',
    key: 'outcome',
    label: 'Outcome',
  },
  {
    description: 'Design, publication status, language, time frame, sample size, or other study features.',
    key: 'studyCharacteristics',
    label: 'Study Characteristics',
  },
  {
    description: 'Anything else the prompt should screen for that does not fit the PICOS buckets above.',
    key: 'other',
    label: 'Other',
  },
]
const createEmptyEligibilitySectionValues = (): Record<
  CovidenceEligibilitySectionKey,
  Record<CovidenceEligibilityDisposition, string>
> => {
  return {
    comparatorContext: {exclude: '', include: ''},
    interventionExposure: {exclude: '', include: ''},
    other: {exclude: '', include: ''},
    outcome: {exclude: '', include: ''},
    population: {exclude: '', include: ''},
    studyCharacteristics: {exclude: '', include: ''},
  }
}

const normalizeCovidenceClipboardHeading = (value: string) => {
  return value
    .toLowerCase()
    .replace(/\s*\/\s*/g, ' / ')
    .replace(/\s+/g, ' ')
    .trim()
}

const covidenceEligibilitySectionKeyByLabel = covidenceEligibilitySections.reduce(
  (lookup, section) => {
    lookup[normalizeCovidenceClipboardHeading(section.label)] = section.key
    return lookup
  },
  {} as Record<string, CovidenceEligibilitySectionKey>,
)

const appendEligibilityClipboardLine = (currentValue: string, nextLine: string) => {
  return currentValue ? `${currentValue}\n${nextLine}` : nextLine
}

const parseCovidenceEligibilityClipboardText = (text: string) => {
  const parsed = text
    .split(/\r?\n/)
    .map((line) => {
      return line.trim()
    })
    .reduce(
      (state, line) => {
        if (line === '') {
          return state
        }

        const nextSectionKey = covidenceEligibilitySectionKeyByLabel[normalizeCovidenceClipboardHeading(line)]

        if (nextSectionKey) {
          return {...state, currentDisposition: null, currentSection: nextSectionKey, sawSection: true}
        }

        const loweredLine = line.toLowerCase()

        if (state.currentSection && (loweredLine === 'include' || loweredLine === 'exclude')) {
          return {...state, currentDisposition: loweredLine as CovidenceEligibilityDisposition}
        }

        if (!state.currentSection || !state.currentDisposition) {
          return state
        }

        state.values[state.currentSection][state.currentDisposition] = appendEligibilityClipboardLine(
          state.values[state.currentSection][state.currentDisposition],
          line,
        )

        return state
      },
      {
        currentDisposition: null as CovidenceEligibilityDisposition | null,
        currentSection: null as CovidenceEligibilitySectionKey | null,
        sawSection: false,
        values: createEmptyEligibilitySectionValues(),
      },
    )

  return parsed.sawSection ? parsed.values : null
}

const getCovidenceEligibilityPromptFields = (
  sectionValues: Record<CovidenceEligibilitySectionKey, Record<CovidenceEligibilityDisposition, string>>,
) => {
  return covidenceEligibilitySections.flatMap((section) => {
    return (['include', 'exclude'] as const).flatMap((disposition) => {
      const text = sectionValues[section.key][disposition].trim()

      return text.length > 0 ? [{disposition, sectionKey: section.key, sectionLabel: section.label, text}] : []
    })
  })
}
type ModelsResponse = {data: ModelOption[]}
type EnsureModelResponse = {data: {modelId: string}; error: null}
type CovidenceAnalyzeResponse = {
  data: {
    counts: {
      conflictingStageMembershipCount: number
      duplicateStudyGroupCount: number
      fileCount: number
      filesByRole: Record<CovidenceFileRole, number>
      mergedRowCount: number
      missingMatchCount: number
      rowCount: number
      rowsByRole: Record<CovidenceFileRole, number>
      studyDecisionConflictCount: number
      studyGroupCount: number
    }
    detectedFiles: Array<{fileRole: CovidenceFileRole; format: 'csv' | 'ris'; rowCount: number; sourceFileName: string}>
    mode: CovidenceImportMode
    sampleMergedRows: Array<{
      articleKey: string
      articleKeySource: 'covidence' | 'doi' | 'pmid' | 'reference_id' | 'title_year_first_author' | 'unkeyed'
      citation: Record<string, string | null>
      duplicateStudyRecordCount: number
      exclusionReasons: string[]
      hasDuplicateStudyRecords: boolean
      hasStudyDecisionConflict: boolean
      notes: string[]
      stageMembership: Record<CovidenceFileRole, boolean>
      studyKey: string | null
      studyKeySource: 'doi' | 'pmid' | 'reference_id' | 'title_year_first_author' | null
      tags: string[]
    }>
    warnings: {
      conflictingStageMemberships: Array<{
        articleKey: string
        conflictingFileRoles: CovidenceFileRole[]
        sourceRows: Array<{fileRole: CovidenceFileRole; rowNumber: number; sourceFileName: string}>
      }>
      duplicateStudyGroups: Array<{
        articleCount: number
        studyKey: string
        studyKeySource: 'doi' | 'pmid' | 'reference_id' | 'title_year_first_author'
        records: Array<{
          articleKey: string
          articleKeySource: 'covidence' | 'doi' | 'pmid' | 'reference_id' | 'title_year_first_author' | 'unkeyed'
          covidenceIds: string[]
          referenceIds: string[]
          seededHumanJudgmentAnswer: 'yes' | 'no' | null
          stageMembership: Record<CovidenceFileRole, boolean>
          title: string | null
        }>
      }>
      missingMatches: Array<{
        articleKey: string | null
        articleKeySource: 'covidence' | 'doi' | 'pmid' | 'reference_id' | 'title_year_first_author' | null
        fileRole: Exclude<CovidenceFileRole, 'all'>
        rowNumber: number
        sourceFileName: string
      }>
      studyDecisionConflicts: Array<{
        articleCount: number
        studyKey: string
        studyKeySource: 'doi' | 'pmid' | 'reference_id' | 'title_year_first_author'
        records: Array<{
          articleKey: string
          articleKeySource: 'covidence' | 'doi' | 'pmid' | 'reference_id' | 'title_year_first_author' | 'unkeyed'
          covidenceIds: string[]
          referenceIds: string[]
          seededHumanJudgmentAnswer: 'yes' | 'no' | null
          stageMembership: Record<CovidenceFileRole, boolean>
          title: string | null
        }>
      }>
    }
  }
}
type CovidenceCreateResponse = {
  success: boolean
  data: {
    covidenceProject: {created: boolean; id: string; modelId: string; name: string} | null
    covidencePrompts: Array<{created: boolean; id: string; promptHeading: string; type: string}>
    dataSource: {id: string; importRoute: string | null; title: string}
    stats: {importedCount: number; itemCount: number}
  }
}

const covidenceModeOptions: Array<{description: string; title: string; value: CovidenceImportMode}> = [
  {
    description:
      'Title and abstract screening, irrelevant, and full-text review CSV exports. Seeds title/abstract no/yes decisions and leaves title and abstract screening rows unanswered.',
    title: 'Title / abstract screening',
    value: 'title_abstract',
  },
  {
    description:
      'All + irrelevant + full text + excluded + included packages. Seeds full-text review decisions and scope.',
    title: 'Full-text screening',
    value: 'full_text',
  },
]
const covidenceRoleLabels: Record<CovidenceFileRole, string> = {
  all: 'All references',
  excluded: 'Excluded',
  full_text: 'Full text',
  included: 'Included',
  irrelevant: 'Irrelevant',
}
const covidenceRoleHintsByMode: Record<CovidenceImportMode, Record<CovidenceFileRole, string>> = {
  full_text: {
    all: 'Required. Canonical master export used for merge keys and article metadata.',
    excluded: 'Required for full-text imports. Marks excluded full-text decisions.',
    full_text: 'Required. Marks studies advanced to full-text review.',
    included: 'Required for full-text imports. Marks included full-text decisions.',
    irrelevant: 'Required. Marks studies excluded at title/abstract stage.',
  },
  title_abstract: {
    all: 'Required CSV for studies still in title/abstract screening.',
    excluded: 'Not used in title/abstract mode.',
    full_text: 'Required CSV for studies approved for full-text review.',
    included: 'Not used in title/abstract mode.',
    irrelevant: 'Required CSV for human-excluded title/abstract decisions.',
  },
}
const covidenceStageOrder: CovidenceFileRole[] = ['irrelevant', 'full_text', 'excluded', 'included']
const covidenceAllRoles: CovidenceFileRole[] = ['all', 'irrelevant', 'full_text', 'excluded', 'included']
const covidenceWarningPreviewLimit = 25
const covidenceAnswerSetOptions: Array<{description: string; label: string; value: CovidencePromptAnswerSet}> = [
  {description: 'Use yes and no only.', label: 'Yes / No', value: 'yes|no'},
  {description: 'Allow a maybe answer for borderline studies.', label: 'Yes / No / Maybe', value: 'yes|no|maybe'},
]
const covidencePromptGroupingOptions: Array<{
  description: string
  helperCopy: string
  label: string
  value: CovidencePromptGrouping
}> = [
  {
    description: 'One project prompt for each non-empty include or exclude field.',
    helperCopy: 'Most specific. More prompts to answer, but each criterion stays isolated.',
    label: 'One prompt per field',
    value: 'per_field',
  },
  {
    description: 'One project prompt per section, combining include and exclude text inside that section.',
    helperCopy: 'Middle ground. Fewer prompts, while keeping Population, Outcome, and other sections separate.',
    label: 'One prompt per section',
    value: 'per_section',
  },
  {
    description: 'One combined project prompt across every populated section.',
    helperCopy:
      'Fewest prompts. Reviewers answer everything at once, which lowers prompt volume but reduces specificity.',
    label: 'One prompt for all sections',
    value: 'single_prompt',
  },
]

const getRequiredCovidenceRoles = (mode: CovidenceImportMode): CovidenceFileRole[] => {
  return mode === 'full_text' ? covidenceAllRoles : ['all', 'irrelevant', 'full_text']
}

const getModelLabel = (model: ModelOption): string => {
  return model.label
}

const getSelectedUploadFiles = (filesByRole: Record<CovidenceFileRole, File | null>, mode: CovidenceImportMode) => {
  return getRequiredCovidenceRoles(mode).flatMap((fileRole) => {
    const file = filesByRole[fileRole]
    return file ? [{file, fileRole}] : []
  })
}

const getMissingCovidenceRoles = (filesByRole: Record<CovidenceFileRole, File | null>, mode: CovidenceImportMode) => {
  return getRequiredCovidenceRoles(mode).filter((fileRole) => {
    return filesByRole[fileRole] === null
  })
}

const getCovidenceRoleLabel = (mode: CovidenceImportMode, fileRole: CovidenceFileRole) => {
  return mode === 'title_abstract' && fileRole === 'all'
    ? 'Title and abstract screening'
    : mode === 'title_abstract' && fileRole === 'full_text'
      ? 'Full text review'
      : covidenceRoleLabels[fileRole]
}

const getCovidenceRoleHint = (mode: CovidenceImportMode, fileRole: CovidenceFileRole) => {
  return covidenceRoleHintsByMode[mode][fileRole]
}

const getStageMembershipLabels = (mode: CovidenceImportMode, stageMembership: Record<CovidenceFileRole, boolean>) => {
  return covidenceStageOrder.flatMap((fileRole) => {
    return stageMembership[fileRole] ? [getCovidenceRoleLabel(mode, fileRole)] : []
  })
}

const getCovidenceSeedLabel = (answer: 'yes' | 'no' | null) => {
  return answer === 'yes' ? 'Seeded yes' : answer === 'no' ? 'Seeded no' : 'Unanswered'
}

const getCovidencePromptCount = (
  eligibilityFields: Array<{
    disposition: CovidenceEligibilityDisposition
    sectionKey: CovidenceEligibilitySectionKey
    sectionLabel: string
    text: string
  }>,
  promptGrouping: CovidencePromptGrouping,
) => {
  return promptGrouping === 'per_field'
    ? eligibilityFields.length
    : promptGrouping === 'per_section'
      ? new Set(
          eligibilityFields.map((eligibilityField) => {
            return eligibilityField.sectionKey
          }),
        ).size
      : eligibilityFields.length > 0
        ? 1
        : 0
}

const fetchModels = async (): Promise<ModelOption[]> => {
  const response = await apiClient.api.models.get()
  const result = handleApiResponse<ModelsResponse>(
    response as unknown as {data?: ModelsResponse; error?: unknown; status?: number},
    'Failed to load models',
  )
  const models = result.data ?? []
  const normalizeProvider = (provider: string | null): string => {
    const value = String(provider ?? '')
      .trim()
      .toLowerCase()
    return value.length > 0 ? value : 'unknown'
  }
  const isCodex = (model: ModelOption): boolean => {
    return normalizeProvider(model.provider) === 'codex'
  }
  const hpcSorted = models
    .filter((model) => {
      return !isCodex(model)
    })
    .sort((left, right) => {
      return left.name.localeCompare(right.name)
    })
  const codexInApiOrder = models.filter(isCodex)

  return [...hpcSorted, ...codexInApiOrder]
}

const appendCovidenceFilesToFormData = (
  formData: FormData,
  files: Array<{file: File; fileRole: CovidenceFileRole}>,
) => {
  return files.reduce((nextFormData, entry, index) => {
    nextFormData.append(`files[${index}].file`, entry.file)
    nextFormData.append(`files[${index}].fileRole`, entry.fileRole)

    return nextFormData
  }, formData)
}

const appendCovidenceEligibilityFieldsToFormData = (
  formData: FormData,
  eligibilityFields: Array<{
    disposition: CovidenceEligibilityDisposition
    sectionKey: CovidenceEligibilitySectionKey
    sectionLabel: string
    text: string
  }>,
) => {
  return eligibilityFields.reduce((nextFormData, field, index) => {
    nextFormData.append(`eligibilityFields[${index}].disposition`, field.disposition)
    nextFormData.append(`eligibilityFields[${index}].sectionKey`, field.sectionKey)
    nextFormData.append(`eligibilityFields[${index}].sectionLabel`, field.sectionLabel)
    nextFormData.append(`eligibilityFields[${index}].text`, field.text)

    return nextFormData
  }, formData)
}

const analyzeCovidencePackage = async (params: {
  files: Array<{file: File; fileRole: CovidenceFileRole}>
  mode: CovidenceImportMode
}) => {
  const formData = appendCovidenceFilesToFormData(new FormData(), params.files)
  formData.append('mode', params.mode)
  const result = await postFormDataToApi<CovidenceAnalyzeResponse>({
    errorMessage: 'Failed to analyze Covidence package',
    formData,
    path: '/api/datasources/import/covidence-analyze',
  })

  return result.data
}

const ensureSelectedModelId = async (selectedModel: ModelOption): Promise<string> => {
  if (selectedModel.provider?.toLowerCase() !== 'codex') {
    return selectedModel.id
  }

  const modelName = selectedModel.modelName?.trim() ?? ''

  if (!modelName) {
    throw new Error('Selected Codex model is missing modelName')
  }

  const response = await apiClient.api.models.ensure.post({
    modelName,
    name: selectedModel.name,
    provider: 'codex',
    version: selectedModel.version ?? undefined,
  })
  const result = handleApiResponse<EnsureModelResponse>(
    response as unknown as {data?: EnsureModelResponse; error?: unknown; status?: number},
    'Failed to ensure Codex model',
  )

  return result.data.modelId
}

const createCovidenceImport = async (params: {
  answerSet: CovidencePromptAnswerSet
  description: string
  eligibilityFields: Array<{
    disposition: CovidenceEligibilityDisposition
    sectionKey: CovidenceEligibilitySectionKey
    sectionLabel: string
    text: string
  }>
  files: Array<{file: File; fileRole: CovidenceFileRole}>
  mode: CovidenceImportMode
  modelId: string
  promptGrouping: CovidencePromptGrouping
  title: string
}) => {
  const formData = appendCovidenceEligibilityFieldsToFormData(
    appendCovidenceFilesToFormData(new FormData(), params.files),
    params.eligibilityFields,
  )
  formData.append('answerSet', params.answerSet)
  formData.append('mode', params.mode)
  formData.append('modelId', params.modelId)
  formData.append('promptGrouping', params.promptGrouping)
  formData.append('title', params.title.trim())

  if (params.description.trim()) {
    formData.append('description', params.description.trim())
  }

  return postFormDataToApi<CovidenceCreateResponse>({
    errorMessage: 'Failed to import Covidence package',
    formData,
    path: '/api/datasources/import/covidence-create',
  })
}

const AdminCovidenceImport = () => {
  const [mode, setMode] = createSignal<CovidenceImportMode>('title_abstract')
  const [projectName, setProjectName] = createSignal('')
  const [description, setDescription] = createSignal('')
  const [selectedModelId, setSelectedModelId] = createSignal('')
  const [answerSet, setAnswerSet] = createSignal<CovidencePromptAnswerSet>('yes|no|maybe')
  const [promptGrouping, setPromptGrouping] = createSignal<CovidencePromptGrouping>('per_field')
  const [isLoadingClipboard, setIsLoadingClipboard] = createSignal(false)
  const [pageError, setPageError] = createSignal('')
  const [eligibilitySectionValues, setEligibilitySectionValues] = createStore(createEmptyEligibilitySectionValues())
  const [filesByRole, setFilesByRole] = createStore<Record<CovidenceFileRole, File | null>>({
    all: null,
    excluded: null,
    full_text: null,
    included: null,
    irrelevant: null,
  })
  const [analysis, setAnalysis] = createSignal<CovidenceAnalyzeResponse['data'] | null>(null)

  const modelsQuery = useQuery(() => {
    return {
      queryKey: ['models', 'covidence-import'],
      queryFn: fetchModels,
      refetchOnMount: 'always',
      staleTime: 1000 * 60 * 5,
    }
  })

  createEffect(() => {
    const firstModel = modelsQuery.data?.[0]

    if (firstModel && !selectedModelId()) {
      setSelectedModelId(firstModel.id)
    }
  })

  const requiredRoles = createMemo(() => {
    return getRequiredCovidenceRoles(mode())
  })

  const missingRoles = createMemo(() => {
    return getMissingCovidenceRoles(filesByRole, mode())
  })

  const selectedModel = createMemo(() => {
    return (
      (modelsQuery.data ?? []).find((model) => {
        return model.id === selectedModelId()
      }) ?? null
    )
  })
  const eligibilityFields = createMemo(() => {
    return getCovidenceEligibilityPromptFields(eligibilitySectionValues)
  })
  const selectedPromptGroupingOption = createMemo(() => {
    return covidencePromptGroupingOptions.find((option) => {
      return option.value === promptGrouping()
    })
  })
  const promptCountPreview = createMemo(() => {
    return getCovidencePromptCount(eligibilityFields(), promptGrouping())
  })

  const analyzeMutation = createMutation(() => {
    return {
      mutationFn: analyzeCovidencePackage,
      onSuccess: (data) => {
        setAnalysis(data)
      },
    }
  })

  const createMutationState = createMutation(() => {
    return {
      mutationFn: createCovidenceImport,
      onSuccess: () => {
        globalThis.location.assign('/projects')
      },
    }
  })

  const handleModeChange = (nextMode: CovidenceImportMode) => {
    setMode(nextMode)
    setAnalysis(null)
    setPageError('')
    setFilesByRole({all: null, excluded: null, full_text: null, included: null, irrelevant: null})
  }

  const handleFileChange = (fileRole: CovidenceFileRole, event: Event) => {
    const nextFile = event.currentTarget instanceof HTMLInputElement ? (event.currentTarget.files?.[0] ?? null) : null
    setFilesByRole(fileRole, nextFile)
    setAnalysis(null)
    setPageError('')
  }

  const handleLoadEligibilityFromClipboard = () => {
    if (!globalThis.navigator?.clipboard?.readText) {
      setPageError('Clipboard read is not available in this browser')
      return
    }

    setIsLoadingClipboard(true)
    setPageError('')

    void globalThis.navigator.clipboard
      .readText()
      .then((text) => {
        const parsed = parseCovidenceEligibilityClipboardText(text)

        if (!parsed) {
          setPageError('Clipboard does not look like Covidence eligibility criteria')
          return
        }

        setEligibilitySectionValues(parsed)
      })
      .catch((error: unknown) => {
        setPageError(error instanceof Error ? error.message : 'Failed to read clipboard')
      })
      .finally(() => {
        setIsLoadingClipboard(false)
      })
  }

  const handleAnalyze = () => {
    const nextMissingRoles = getMissingCovidenceRoles(filesByRole, mode())

    if (nextMissingRoles.length > 0) {
      setPageError(
        `Add the required files first: ${nextMissingRoles
          .map((fileRole) => {
            return getCovidenceRoleLabel(mode(), fileRole)
          })
          .join(', ')}`,
      )
      return
    }

    setPageError('')
    analyzeMutation.mutate({files: getSelectedUploadFiles(filesByRole, mode()), mode: mode()})
  }

  const handleSubmit = () => {
    const trimmedProjectName = projectName().trim()
    const nextEligibilityFields = eligibilityFields()
    const nextMode = mode()
    const nextAnswerSet = answerSet()
    const nextDescription = description()
    const nextMissingRoles = getMissingCovidenceRoles(filesByRole, mode())
    const nextSelectedModel = selectedModel()
    const nextFiles = getSelectedUploadFiles(filesByRole, nextMode)
    const nextPromptGrouping = promptGrouping()

    if (!trimmedProjectName) {
      setPageError('Project name is required')
      return
    }

    if (!nextSelectedModel) {
      setPageError('Choose a model before importing')
      return
    }

    if (nextMissingRoles.length > 0) {
      setPageError(
        `Add the required files first: ${nextMissingRoles
          .map((fileRole) => {
            return getCovidenceRoleLabel(nextMode, fileRole)
          })
          .join(', ')}`,
      )
      return
    }

    if (!analysis()) {
      setPageError('Analyze the Covidence package before importing')
      return
    }

    setPageError('')
    void ensureSelectedModelId(nextSelectedModel)
      .then((modelId) => {
        createMutationState.mutate({
          answerSet: nextAnswerSet,
          description: nextDescription,
          eligibilityFields: nextEligibilityFields,
          files: nextFiles,
          mode: nextMode,
          modelId,
          promptGrouping: nextPromptGrouping,
          title: trimmedProjectName,
        })
      })
      .catch((error: unknown) => {
        setPageError(error instanceof Error ? error.message : 'Failed to prepare selected model')
      })
  }

  const mutationError = () => {
    const analyzeError = analyzeMutation.error instanceof Error ? analyzeMutation.error.message : ''
    const createError = createMutationState.error instanceof Error ? createMutationState.error.message : ''

    return pageError() || analyzeError || createError
  }

  return (
    <div class="min-h-screen bg-stone-50 p-6">
      <div class="mx-auto max-w-7xl space-y-6">
        <div class="overflow-hidden rounded-3xl border border-stone-200 bg-[radial-gradient(circle_at_top_left,_rgba(245,158,11,0.18),_transparent_40%),linear-gradient(135deg,_#fff7ed,_#fffbeb_55%,_#ffffff)] shadow-sm">
          <div class="flex flex-wrap items-start justify-between gap-4 p-6 md:p-8">
            <div class="max-w-3xl space-y-3">
              <p class="text-xs font-semibold uppercase tracking-[0.28em] text-amber-700">Admin import flow</p>
              <h1 class="text-3xl font-semibold tracking-tight text-stone-900">Covidence multi-file import</h1>
              <p class="max-w-2xl text-sm leading-6 text-stone-600">
                Upload the required Covidence CSV exports, inspect the merged rows, then create the datasource, prompt,
                linked project, and seeded judgments in one pass.
              </p>
            </div>
            <Button as={Link} to="/admin/datasources" variant="outline" size="sm">
              Back to Data Sources
            </Button>
          </div>
        </div>

        <div class="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
          <div class="space-y-6">
            <section class="rounded-3xl border border-stone-200 bg-white p-6 shadow-sm">
              <div class="mb-4 flex items-center justify-between gap-4">
                <div>
                  <h2 class="text-lg font-semibold text-stone-900">1. Mode and project setup</h2>
                  <p class="mt-1 text-sm text-stone-500">
                    Choose the Covidence workflow and the linked project settings.
                  </p>
                </div>
                <span class="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800">
                  {requiredRoles().length} files required
                </span>
              </div>

              <div class="grid gap-4 md:grid-cols-2">
                <For each={covidenceModeOptions}>
                  {(option) => {
                    const isSelected = () => {
                      return mode() === option.value
                    }

                    return (
                      <button
                        type="button"
                        class={`rounded-2xl border p-4 text-left transition ${
                          isSelected()
                            ? 'border-amber-400 bg-amber-50 shadow-sm'
                            : 'border-stone-200 bg-stone-50 hover:border-stone-300 hover:bg-white'
                        }`}
                        onClick={() => {
                          handleModeChange(option.value)
                        }}
                      >
                        <div class="flex items-start justify-between gap-4">
                          <div class="space-y-2">
                            <p class="text-sm font-semibold text-stone-900">{option.title}</p>
                            <p class="text-sm leading-6 text-stone-600">{option.description}</p>
                          </div>
                          <div class={`mt-1 h-3 w-3 rounded-full ${isSelected() ? 'bg-amber-500' : 'bg-stone-300'}`} />
                        </div>
                      </button>
                    )
                  }}
                </For>
              </div>

              <div class="mt-6 grid gap-5 md:grid-cols-2">
                <label class="space-y-2 text-sm font-medium text-stone-700">
                  <span>Project name</span>
                  <input
                    type="text"
                    value={projectName()}
                    onInput={(event) => {
                      setProjectName(event.currentTarget.value)
                    }}
                    placeholder="COVID screening import March 2026"
                    class="w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm shadow-sm outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-200"
                  />
                  <p class="text-xs font-normal text-stone-500">
                    Used for both the datasource title and linked project name.
                  </p>
                </label>

                <label class="space-y-2 text-sm font-medium text-stone-700">
                  <span>Answer set</span>
                  <select
                    value={answerSet()}
                    onChange={(event) => {
                      setAnswerSet(event.currentTarget.value as CovidencePromptAnswerSet)
                    }}
                    class="w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm shadow-sm outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-200"
                  >
                    <For each={covidenceAnswerSetOptions}>
                      {(option) => {
                        return <option value={option.value}>{option.label}</option>
                      }}
                    </For>
                  </select>
                  <p class="text-xs font-normal text-stone-500">
                    {covidenceAnswerSetOptions.find((option) => {
                      return option.value === answerSet()
                    })?.description ?? ''}
                  </p>
                </label>

                <div class="space-y-2 md:col-span-2">
                  <span class="block text-sm font-medium text-stone-700">Model</span>
                  <Show when={modelsQuery.isLoading}>
                    <p class="rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-500">
                      Loading models...
                    </p>
                  </Show>
                  <Show when={modelsQuery.isError}>
                    <p class="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                      {modelsQuery.error instanceof Error ? modelsQuery.error.message : 'Failed to load models'}
                    </p>
                  </Show>
                  <Show when={!modelsQuery.isLoading && !modelsQuery.isError && (modelsQuery.data?.length ?? 0) > 0}>
                    <select
                      value={selectedModelId()}
                      onChange={(event) => {
                        setSelectedModelId(event.currentTarget.value)
                      }}
                      class="w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm shadow-sm outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-200"
                    >
                      <For each={modelsQuery.data ?? []}>
                        {(model) => {
                          return <option value={model.id}>{getModelLabel(model)}</option>
                        }}
                      </For>
                    </select>
                  </Show>
                  <Show when={!modelsQuery.isLoading && !modelsQuery.isError && (modelsQuery.data?.length ?? 0) === 0}>
                    <div class="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-stone-200 bg-stone-50 p-4">
                      <p class="text-sm text-stone-600">No models are available yet.</p>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => {
                          return void apiClient.api.judgments.model.get().then(() => {
                            return modelsQuery.refetch()
                          })
                        }}
                      >
                        Create default model
                      </Button>
                    </div>
                  </Show>
                </div>

                <label class="space-y-2 text-sm font-medium text-stone-700 md:col-span-2">
                  <span>Description</span>
                  <textarea
                    value={description()}
                    onInput={(event) => {
                      setDescription(event.currentTarget.value)
                    }}
                    rows={3}
                    placeholder="Optional notes for the imported datasource"
                    class="w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm shadow-sm outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-200"
                  />
                </label>

                <div class="rounded-2xl border border-amber-200 bg-amber-50/70 p-4 md:col-span-2">
                  <p class="text-sm font-medium text-amber-950">Eligibility prompts</p>
                  <p class="mt-1 text-sm leading-6 text-amber-900/80">
                    {selectedPromptGroupingOption()?.helperCopy ?? ''}
                  </p>
                  <p class="mt-2 text-xs text-amber-900/70">
                    {promptCountPreview() === 0
                      ? 'No prompts will be created until at least one eligibility field has content.'
                      : `${promptCountPreview()} prompt${promptCountPreview() === 1 ? '' : 's'} will be created with the current grouping.`}
                  </p>
                </div>

                <div class="space-y-3 md:col-span-2">
                  <div>
                    <span class="block text-sm font-medium text-stone-700">Prompt grouping</span>
                    <p class="mt-1 text-sm text-stone-500">
                      Choose how the eligibility criteria roll up into review prompts before project creation.
                    </p>
                  </div>

                  <div class="grid gap-3 md:grid-cols-3">
                    <For each={covidencePromptGroupingOptions}>
                      {(option) => {
                        const isSelected = () => {
                          return promptGrouping() === option.value
                        }

                        return (
                          <button
                            type="button"
                            class={`rounded-2xl border p-4 text-left transition ${
                              isSelected()
                                ? 'border-amber-400 bg-amber-50 shadow-sm'
                                : 'border-stone-200 bg-stone-50 hover:border-stone-300 hover:bg-white'
                            }`}
                            onClick={() => {
                              setPromptGrouping(option.value)
                            }}
                          >
                            <div class="flex items-start justify-between gap-3">
                              <div class="space-y-2">
                                <p class="text-sm font-semibold text-stone-900">{option.label}</p>
                                <p class="text-xs leading-5 text-stone-600">{option.description}</p>
                              </div>
                              <div
                                class={`mt-1 h-3 w-3 rounded-full ${isSelected() ? 'bg-amber-500' : 'bg-stone-300'}`}
                              />
                            </div>
                          </button>
                        )
                      }}
                    </For>
                  </div>
                </div>

                <div class="rounded-2xl border border-stone-200 bg-stone-50 p-4 md:col-span-2">
                  <div class="flex flex-wrap items-center justify-between gap-3">
                    <p class="text-sm text-stone-600">
                      Paste a Covidence eligibility criteria block to fill the section fields automatically.
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleLoadEligibilityFromClipboard}
                      disabled={isLoadingClipboard()}
                    >
                      {isLoadingClipboard() ? 'Loading...' : 'Load from Clipboard'}
                    </Button>
                  </div>
                  <p class="mt-3 text-xs text-stone-500">Empty include or exclude sections stay blank after import.</p>
                </div>

                <div class="grid gap-4 md:col-span-2">
                  <For each={covidenceEligibilitySections}>
                    {(section) => {
                      return (
                        <div class="rounded-2xl border border-stone-200 bg-stone-50 p-4 shadow-sm">
                          <div class="mb-4 space-y-1">
                            <h3 class="text-sm font-semibold text-stone-900">{section.label}</h3>
                            <p class="text-xs leading-5 text-stone-500">{section.description}</p>
                          </div>

                          <div class="grid gap-4 md:grid-cols-2">
                            <label class="space-y-2 text-sm font-medium text-stone-700">
                              <span>Include</span>
                              <textarea
                                value={eligibilitySectionValues[section.key].include}
                                onInput={(event) => {
                                  setEligibilitySectionValues(section.key, 'include', event.currentTarget.value)
                                }}
                                rows={3}
                                placeholder={`Include ${section.label.toLowerCase()} criteria`}
                                class="w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm shadow-sm outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-200"
                              />
                            </label>

                            <label class="space-y-2 text-sm font-medium text-stone-700">
                              <span>Exclude</span>
                              <textarea
                                value={eligibilitySectionValues[section.key].exclude}
                                onInput={(event) => {
                                  setEligibilitySectionValues(section.key, 'exclude', event.currentTarget.value)
                                }}
                                rows={3}
                                placeholder={`Exclude ${section.label.toLowerCase()} criteria`}
                                class="w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm shadow-sm outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-200"
                              />
                            </label>
                          </div>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </div>
            </section>

            <section class="rounded-3xl border border-stone-200 bg-white p-6 shadow-sm">
              <div class="mb-4">
                <h2 class="text-lg font-semibold text-stone-900">2. Upload required Covidence files</h2>
                <p class="mt-1 text-sm text-stone-500">
                  Switching modes resets selected files. Upload CSV exports only.
                </p>
              </div>

              <div class="grid gap-4 md:grid-cols-2">
                <For each={requiredRoles()}>
                  {(fileRole) => {
                    return (
                      <label class="rounded-2xl border border-stone-200 bg-stone-50 p-4 text-sm text-stone-700 shadow-sm">
                        <div class="mb-2 flex items-center justify-between gap-3">
                          <span class="font-semibold text-stone-900">{getCovidenceRoleLabel(mode(), fileRole)}</span>
                          <span class="rounded-full bg-stone-200 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-stone-700">
                            {fileRole.replace('_', ' ')}
                          </span>
                        </div>
                        <p class="mb-3 text-xs leading-5 text-stone-500">{getCovidenceRoleHint(mode(), fileRole)}</p>
                        <input
                          type="file"
                          accept=".csv,text/csv"
                          onChange={(event) => {
                            handleFileChange(fileRole, event)
                          }}
                          class="w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-amber-100 file:px-3 file:py-2 file:text-amber-900"
                        />
                        <Show when={filesByRole[fileRole]}>
                          <p class="mt-3 text-xs text-stone-600">
                            {filesByRole[fileRole]?.name} · {(filesByRole[fileRole]?.size ?? 0).toLocaleString()} bytes
                          </p>
                        </Show>
                      </label>
                    )
                  }}
                </For>
              </div>

              <div class="mt-6 flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  onClick={handleAnalyze}
                  disabled={missingRoles().length > 0 || analyzeMutation.isPending}
                >
                  {analyzeMutation.isPending ? 'Analyzing...' : 'Analyze package'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleSubmit}
                  disabled={createMutationState.isPending || analyzeMutation.isPending}
                >
                  {createMutationState.isPending ? 'Importing...' : 'Create datasource and project'}
                </Button>
                <Show when={missingRoles().length > 0}>
                  <p class="text-sm text-stone-500">
                    Missing:{' '}
                    {missingRoles()
                      .map((fileRole) => {
                        return getCovidenceRoleLabel(mode(), fileRole)
                      })
                      .join(', ')}
                  </p>
                </Show>
              </div>

              <Show when={mutationError()}>
                <div class="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {mutationError()}
                </div>
              </Show>
            </section>
          </div>

          <div class="space-y-6">
            <section class="rounded-3xl border border-stone-200 bg-white p-6 shadow-sm">
              <div class="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h2 class="text-lg font-semibold text-stone-900">3. Analyze preview</h2>
                  <p class="mt-1 text-sm text-stone-500">
                    Review file detection, merge counts, and warnings before import.
                  </p>
                </div>
                <Show when={analysis()}>
                  <span class="rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-800">
                    Preview ready
                  </span>
                </Show>
              </div>

              <Show when={!analysis() && !analyzeMutation.isPending}>
                <div class="rounded-2xl border border-dashed border-stone-300 bg-stone-50 p-6 text-sm leading-6 text-stone-500">
                  Add the required files and run analysis to see merged article samples, detected formats, and package
                  warnings.
                </div>
              </Show>

              <Show when={analyzeMutation.isPending}>
                <div class="rounded-2xl border border-stone-200 bg-stone-50 p-6 text-sm text-stone-500">
                  Inspecting package files...
                </div>
              </Show>

              <Show when={analysis()}>
                <div class="space-y-6">
                  <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    <div class="rounded-2xl bg-stone-50 p-4">
                      <p class="text-xs font-medium uppercase tracking-wide text-stone-500">Imported records</p>
                      <p class="mt-2 text-2xl font-semibold text-stone-900">{analysis()?.counts.mergedRowCount ?? 0}</p>
                    </div>
                    <div class="rounded-2xl bg-stone-50 p-4">
                      <p class="text-xs font-medium uppercase tracking-wide text-stone-500">Study groups</p>
                      <p class="mt-2 text-2xl font-semibold text-stone-900">
                        {analysis()?.counts.studyGroupCount ?? 0}
                      </p>
                    </div>
                    <div class="rounded-2xl bg-stone-50 p-4">
                      <p class="text-xs font-medium uppercase tracking-wide text-stone-500">Duplicate groups</p>
                      <p class="mt-2 text-2xl font-semibold text-stone-900">
                        {analysis()?.counts.duplicateStudyGroupCount ?? 0}
                      </p>
                    </div>
                    <div class="rounded-2xl bg-stone-50 p-4">
                      <p class="text-xs font-medium uppercase tracking-wide text-stone-500">Conflict groups</p>
                      <p class="mt-2 text-2xl font-semibold text-stone-900">
                        {(analysis()?.counts.conflictingStageMembershipCount ?? 0)
                          + (analysis()?.counts.studyDecisionConflictCount ?? 0)}
                      </p>
                    </div>
                    <div class="rounded-2xl bg-stone-50 p-4">
                      <p class="text-xs font-medium uppercase tracking-wide text-stone-500">Detected files</p>
                      <p class="mt-2 text-2xl font-semibold text-stone-900">{analysis()?.counts.fileCount ?? 0}</p>
                    </div>
                    <div class="rounded-2xl bg-stone-50 p-4">
                      <p class="text-xs font-medium uppercase tracking-wide text-stone-500">Parsed rows</p>
                      <p class="mt-2 text-2xl font-semibold text-stone-900">{analysis()?.counts.rowCount ?? 0}</p>
                    </div>
                  </div>

                  <div class="space-y-3">
                    <h3 class="text-sm font-semibold uppercase tracking-wide text-stone-500">Detected package files</h3>
                    <div class="space-y-2">
                      <For each={analysis()?.detectedFiles ?? []}>
                        {(file) => {
                          return (
                            <div class="rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-700">
                              <div class="flex flex-wrap items-center justify-between gap-2">
                                <span class="font-medium text-stone-900">{file.sourceFileName}</span>
                                <span class="text-xs uppercase tracking-wide text-stone-500">
                                  {getCovidenceRoleLabel(mode(), file.fileRole)} · {file.format.toUpperCase()} ·{' '}
                                  {file.rowCount.toLocaleString()} rows
                                </span>
                              </div>
                            </div>
                          )
                        }}
                      </For>
                    </div>
                  </div>

                  <div class="space-y-3">
                    <div class="flex items-center justify-between gap-3">
                      <h3 class="text-sm font-semibold uppercase tracking-wide text-stone-500">Warnings</h3>
                      <Show
                        when={
                          (analysis()?.warnings.conflictingStageMemberships.length ?? 0) === 0
                          && (analysis()?.warnings.duplicateStudyGroups.length ?? 0) === 0
                          && (analysis()?.warnings.missingMatches.length ?? 0) === 0
                          && (analysis()?.warnings.studyDecisionConflicts.length ?? 0) === 0
                        }
                      >
                        <span class="rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-800">
                          No warnings
                        </span>
                      </Show>
                    </div>

                    <Show when={(analysis()?.warnings.conflictingStageMemberships.length ?? 0) > 0}>
                      <div class="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                        <p class="text-sm font-semibold text-amber-900">Same-record stage conflicts</p>
                        <div class="mt-3 space-y-2 text-sm text-amber-900">
                          <For
                            each={(analysis()?.warnings.conflictingStageMemberships ?? []).slice(
                              0,
                              covidenceWarningPreviewLimit,
                            )}
                          >
                            {(warning) => {
                              return (
                                <div class="rounded-xl bg-white/70 px-3 py-2">
                                  <p class="font-medium">{warning.articleKey}</p>
                                  <p class="text-xs text-amber-800">Roles: {warning.conflictingFileRoles.join(', ')}</p>
                                </div>
                              )
                            }}
                          </For>
                        </div>
                      </div>
                    </Show>

                    <Show when={(analysis()?.warnings.studyDecisionConflicts.length ?? 0) > 0}>
                      <div class="rounded-2xl border border-rose-200 bg-rose-50 p-4">
                        <p class="text-sm font-semibold text-rose-900">Duplicate study decision conflicts</p>
                        <div class="mt-3 space-y-3 text-sm text-rose-900">
                          <For
                            each={(analysis()?.warnings.studyDecisionConflicts ?? []).slice(
                              0,
                              covidenceWarningPreviewLimit,
                            )}
                          >
                            {(warning) => {
                              return (
                                <div class="rounded-xl bg-white/70 px-3 py-3">
                                  <p class="font-medium">{warning.studyKey}</p>
                                  <p class="text-xs text-rose-800">
                                    {warning.articleCount} records share this study key
                                  </p>
                                  <div class="mt-2 space-y-2">
                                    <For each={warning.records}>
                                      {(record) => {
                                        return (
                                          <div class="rounded-lg border border-rose-100 bg-white px-3 py-2">
                                            <p class="font-medium text-stone-900">
                                              {record.title ?? record.articleKey}
                                            </p>
                                            <p class="text-xs text-rose-800">
                                              {getCovidenceSeedLabel(record.seededHumanJudgmentAnswer)}
                                            </p>
                                            <p class="mt-1 text-xs text-stone-600">
                                              {getStageMembershipLabels(mode(), record.stageMembership).join(', ')}
                                            </p>
                                          </div>
                                        )
                                      }}
                                    </For>
                                  </div>
                                </div>
                              )
                            }}
                          </For>
                        </div>
                      </div>
                    </Show>

                    <Show when={(analysis()?.warnings.duplicateStudyGroups.length ?? 0) > 0}>
                      <div class="rounded-2xl border border-stone-200 bg-stone-50 p-4">
                        <p class="text-sm font-semibold text-stone-900">Duplicate study groups</p>
                        <div class="mt-3 space-y-3 text-sm text-stone-800">
                          <For
                            each={(analysis()?.warnings.duplicateStudyGroups ?? []).slice(
                              0,
                              covidenceWarningPreviewLimit,
                            )}
                          >
                            {(warning) => {
                              return (
                                <div class="rounded-xl bg-white px-3 py-3">
                                  <p class="font-medium">{warning.studyKey}</p>
                                  <p class="text-xs text-stone-500">
                                    {warning.articleCount} records share this study key
                                  </p>
                                </div>
                              )
                            }}
                          </For>
                        </div>
                      </div>
                    </Show>

                    <Show when={(analysis()?.warnings.missingMatches.length ?? 0) > 0}>
                      <div class="rounded-2xl border border-rose-200 bg-rose-50 p-4">
                        <p class="text-sm font-semibold text-rose-900">Rows missing a canonical match</p>
                        <div class="mt-3 space-y-2 text-sm text-rose-900">
                          <For
                            each={(analysis()?.warnings.missingMatches ?? []).slice(0, covidenceWarningPreviewLimit)}
                          >
                            {(warning) => {
                              return (
                                <div class="rounded-xl bg-white/70 px-3 py-2">
                                  <p class="font-medium">{warning.sourceFileName}</p>
                                  <p class="text-xs text-rose-800">
                                    {getCovidenceRoleLabel(mode(), warning.fileRole)} · row {warning.rowNumber}
                                    {warning.articleKey ? ` · key ${warning.articleKey}` : ''}
                                  </p>
                                </div>
                              )
                            }}
                          </For>
                        </div>
                      </div>
                    </Show>
                  </div>

                  <div class="space-y-3">
                    <h3 class="text-sm font-semibold uppercase tracking-wide text-stone-500">Merged row samples</h3>
                    <div class="space-y-3">
                      <For each={analysis()?.sampleMergedRows ?? []}>
                        {(row) => {
                          return (
                            <div class="rounded-2xl border border-stone-200 p-4">
                              <div class="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                  <p class="font-semibold text-stone-900">{row.citation.title ?? 'Untitled article'}</p>
                                  <p class="mt-1 text-xs uppercase tracking-wide text-stone-500">
                                    {row.articleKeySource.replaceAll('_', ' ')} · {row.articleKey}
                                  </p>
                                  <Show when={row.studyKey}>
                                    <p class="mt-1 text-xs text-stone-500">Study key: {row.studyKey}</p>
                                  </Show>
                                </div>
                                <div class="flex flex-wrap gap-2">
                                  <Show when={row.hasStudyDecisionConflict}>
                                    <span class="rounded-full bg-rose-100 px-2.5 py-1 text-xs font-medium text-rose-800">
                                      Conflict
                                    </span>
                                  </Show>
                                  <Show when={row.hasDuplicateStudyRecords}>
                                    <span class="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800">
                                      Duplicate x{row.duplicateStudyRecordCount}
                                    </span>
                                  </Show>
                                  <For each={getStageMembershipLabels(mode(), row.stageMembership)}>
                                    {(label) => {
                                      return (
                                        <span class="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-700">
                                          {label}
                                        </span>
                                      )
                                    }}
                                  </For>
                                </div>
                              </div>
                              <div class="mt-3 space-y-1 text-sm text-stone-600">
                                <Show when={row.citation.abstract}>
                                  <p class="line-clamp-3">{row.citation.abstract}</p>
                                </Show>
                                <Show when={row.tags.length > 0}>
                                  <p>Tags: {row.tags.join(', ')}</p>
                                </Show>
                                <Show when={row.exclusionReasons.length > 0}>
                                  <p>Exclusion reasons: {row.exclusionReasons.join(', ')}</p>
                                </Show>
                                <Show when={row.notes.length > 0}>
                                  <p>Notes: {row.notes.join(' | ')}</p>
                                </Show>
                              </div>
                            </div>
                          )
                        }}
                      </For>
                    </div>
                  </div>
                </div>
              </Show>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/admin/datasources/covidence-import')({component: AdminCovidenceImport})
