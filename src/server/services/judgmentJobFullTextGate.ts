import {MAX_COMPLETION_TOKENS} from '../../agent/judge.ts'
import {
  type FullTextChunkPolicy,
  type FullTextFigureMode,
  type FullTextStrategy,
  type FullTextStrategyInputs,
  getEffectiveFullTextStrategyId,
  getFullTextChunkPolicy,
  getFullTextStrategyDisplayLabel,
  getFullTextStrategyInputDifferences,
  isFullTextFigureMode,
} from '../fullText/fullTextStrategy.ts'
import {getFullTextStrategyEnvironment} from '../fullText/fullTextStrategyEnvironment.ts'
import {type FullTextStrategyEnvironment, resolveFullTextStrategy} from '../fullText/fullTextStrategyResolver.ts'
import {getNativeImagesModelErrorMessage, nativeImagesModelAcceptsImages} from '../fullText/nativeImagesModelCheck.ts'
import {providerTransportSupportsImageInput} from '../providers/providerImageInput.ts'
import {
  getModelContextWindowMissingMessage,
  getProviderModelContextLimits,
  type ProviderModelCapabilityModel,
  resolveProviderModelCapabilities,
} from '../providers/providerModelCapabilities.ts'
import {getProviderRegistryEntry} from '../providers/providerRegistry.ts'
import {HttpError} from '../utils/httpError.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getJsonValue, getQuotedStringList, getSqlLiteral} from './appQueryHelpers.ts'
import {type FullTextModelStatus, getConfiguredFullTextModelIds, getFullTextModelStatus} from './fullTextModelStatus.ts'

type FullTextGateRunner = {queryJson: <T>(statement: string) => Promise<T[]>}

export type ProjectFullTextGate = {errors: string[]; warnings: string[]}

export type ProjectFullTextGateEvaluation = ProjectFullTextGate & {strategy: FullTextStrategy | null}

export type ProjectFullTextGateSelection = {
  fullTextChunkPolicy: FullTextChunkPolicy | null
  fullTextFigureMode: FullTextFigureMode | null
  useFulltext: boolean
}

export type ProjectFullTextGateModel = ProviderModelCapabilityModel & {modelName: string}

export type ProjectFullTextGateStoredStrategy = {id: string; inputs: FullTextStrategyInputs | null; label: string}

export type ProjectFullTextGateContext = {
  conversionModelStatus: FullTextModelStatus | null
  environment: FullTextStrategyEnvironment
}

export type ProjectFullTextGateProjectRow = {
  fullTextChunkPolicy: unknown
  fullTextFigureMode: string | null
  fullTextStrategyId: string | null
  fullTextStrategyInputs: unknown
  fullTextStrategyStoredLabel: string | null
  useFulltext: boolean | null
  useFulltextNoImages: boolean | null
}

type ProjectFullTextGateModelRow = {
  displayName: string | null
  metadataJson: unknown
  providerKind: string | null
  remoteModelId: string | null
}

type ProjectFullTextGateRow = ProjectFullTextGateProjectRow & ProjectFullTextGateModelRow & {projectId: string}

const emptyProjectFullTextGateEvaluation: ProjectFullTextGateEvaluation = {errors: [], strategy: null, warnings: []}

const formatTokenCount = (value: number): string => {
  return value.toLocaleString('en-US')
}

const getModelReference = (model: ProjectFullTextGateModel): string => {
  return `${model.modelName} (${model.providerKind ?? 'unknown provider'})`
}

export const getModelPromptLimitTooSmallMessage = ({
  maxPromptTokens,
  model,
  promptTokenLimit,
}: {
  maxPromptTokens: number
  model: ProjectFullTextGateModel
  promptTokenLimit: number
}): string => {
  return `Model ${getModelReference(model)} accepts ${formatTokenCount(promptTokenLimit)} prompt tokens, fewer than the chunk policy's ${formatTokenCount(maxPromptTokens)}-token prompt size. Choose a smaller prompt size or another model, or correct its context window on the Models page.`
}

export const getModelImageInputUnsupportedMessage = (model: ProjectFullTextGateModel): string => {
  return getNativeImagesModelErrorMessage(getModelReference(model))
}

export const getModelImageInputUnverifiedMessage = (model: ProjectFullTextGateModel): string => {
  return `Model ${getModelReference(model)} has no verified image input. Set it on the Models page, or choose Text only (figures reduced to their captions), or another model.`
}

const getStrategyReference = (strategy: {id: string; label: string}): string => {
  return `${strategy.label} (${strategy.id})`
}

const getStrategyInputDifferenceText = (
  storedStrategy: ProjectFullTextGateStoredStrategy,
  strategy: FullTextStrategy,
): string => {
  const differences = storedStrategy.inputs
    ? getFullTextStrategyInputDifferences(storedStrategy.inputs, strategy.inputs)
    : []

  return differences.length > 0 ? `; differing inputs: ${differences.join(', ')}` : ''
}

export const fullTextStrategyChangedRemedies = {
  editPageJobRunning: 'Pause the judgment job, then save this page to record the new strategy.',
  editPageJobStopped: 'Saving this page records the new strategy; then start the judgment job clean.',
  jobStart: 'Save the project on its edit page to record the new strategy.',
} as const

export const getFullTextStrategyChangedSinceSaveMessage = ({
  remedy = fullTextStrategyChangedRemedies.jobStart,
  storedStrategy,
  strategy,
}: {
  remedy?: string
  storedStrategy: ProjectFullTextGateStoredStrategy
  strategy: FullTextStrategy
}): string => {
  return `Full-text settings changed since the project was saved: it records ${getStrategyReference(storedStrategy)}, current settings resolve to ${getStrategyReference(strategy)}${getStrategyInputDifferenceText(storedStrategy, strategy)}. ${remedy}`
}

const getHealthWarning = ({
  consequence,
  roleLabel,
  status,
}: {
  consequence: string
  roleLabel: string
  status: FullTextModelStatus | null
}): string | null => {
  return status?.health.state === 'failed'
    ? `${roleLabel} ${status.modelLabel}: ${status.health.detail} ${consequence}`
    : null
}

const getContextWindowError = ({
  model,
  selection,
}: {
  model: ProjectFullTextGateModel
  selection: ProjectFullTextGateSelection
}): string | null => {
  const {promptTokenLimit} = getProviderModelContextLimits({model, reservedCompletionTokens: MAX_COMPLETION_TOKENS})
  const maxPromptTokens = selection.fullTextChunkPolicy?.maxPromptTokens ?? null

  return promptTokenLimit === null
    ? getModelContextWindowMissingMessage({modelName: model.modelName, providerKind: model.providerKind})
    : maxPromptTokens !== null && promptTokenLimit < maxPromptTokens
      ? getModelPromptLimitTooSmallMessage({maxPromptTokens, model, promptTokenLimit})
      : null
}

const isImageInputTransport = (providerKind: string | null): boolean => {
  const transportFamily = getProviderRegistryEntry(providerKind)?.transportFamily ?? null

  return transportFamily !== null && providerTransportSupportsImageInput(transportFamily)
}

const getImageInputError = ({
  model,
  selection,
}: {
  model: ProjectFullTextGateModel
  selection: ProjectFullTextGateSelection
}): string | null => {
  const imageInput = resolveProviderModelCapabilities(model).supportsImageInput

  return selection.fullTextFigureMode !== 'native_images'
    || nativeImagesModelAcceptsImages({...model, label: model.modelName})
    ? null
    : imageInput === null && isImageInputTransport(model.providerKind)
      ? getModelImageInputUnverifiedMessage(model)
      : getModelImageInputUnsupportedMessage(model)
}

const isPresent = (value: string | null): value is string => {
  return value !== null
}

const getModelErrors = (model: ProjectFullTextGateModel | null, selection: ProjectFullTextGateSelection): string[] => {
  return model
    ? [getContextWindowError({model, selection}), getImageInputError({model, selection})].filter(isPresent)
    : []
}

const getStoredStrategyErrors = ({
  storedStrategy,
  strategy,
}: {
  storedStrategy: ProjectFullTextGateStoredStrategy | undefined
  strategy: FullTextStrategy | null
}): string[] => {
  return storedStrategy && strategy && storedStrategy.id !== strategy.id
    ? [getFullTextStrategyChangedSinceSaveMessage({storedStrategy, strategy})]
    : []
}

const getHealthWarnings = (context: ProjectFullTextGateContext): string[] => {
  return [
    context.environment.conversionModel
      ? getHealthWarning({
          consequence: 'Conversion will not run until the server is reachable.',
          roleLabel: 'PDF-to-text model',
          status: context.conversionModelStatus,
        })
      : null,
  ].filter(isPresent)
}

const getEnabledProjectFullTextGateEvaluation = ({
  context,
  model,
  selection,
  storedStrategy,
}: {
  context: ProjectFullTextGateContext
  model: ProjectFullTextGateModel | null
  selection: ProjectFullTextGateSelection
  storedStrategy: ProjectFullTextGateStoredStrategy | undefined
}): ProjectFullTextGateEvaluation => {
  const resolution = resolveFullTextStrategy(
    {chunkPolicy: selection.fullTextChunkPolicy, figureMode: selection.fullTextFigureMode},
    context.environment,
  )

  return {
    errors: [
      ...resolution.errors,
      ...getModelErrors(model, selection),
      ...getStoredStrategyErrors({storedStrategy, strategy: resolution.strategy}),
    ],
    strategy: resolution.strategy,
    warnings: getHealthWarnings(context),
  }
}

export const evaluateProjectFullTextGate = ({
  context,
  model,
  selection,
  storedStrategy,
}: {
  context: ProjectFullTextGateContext
  model: ProjectFullTextGateModel | null
  selection: ProjectFullTextGateSelection
  storedStrategy?: ProjectFullTextGateStoredStrategy
}): ProjectFullTextGateEvaluation => {
  return selection.useFulltext
    ? getEnabledProjectFullTextGateEvaluation({context, model, selection, storedStrategy})
    : emptyProjectFullTextGateEvaluation
}

const getModelStatusOrNull = async ({
  modelId,
  role,
  runner,
}: {
  modelId: string | null
  role: FullTextModelStatus['role']
  runner: FullTextGateRunner
}) => {
  return modelId ? getFullTextModelStatus({modelId, role, runner}) : null
}

export const getProjectFullTextGateContext = async (
  runner: FullTextGateRunner = getAppDatabaseService(),
): Promise<ProjectFullTextGateContext> => {
  const configuredModelIds = await getConfiguredFullTextModelIds(runner)

  return {
    conversionModelStatus: await getModelStatusOrNull({
      modelId: configuredModelIds.fullTextConversionModelId,
      role: 'pdf_conversion',
      runner,
    }),
    environment: await getFullTextStrategyEnvironment(runner),
  }
}

const getProjectFullTextGateModelFromRow = (row: ProjectFullTextGateModelRow): ProjectFullTextGateModel | null => {
  return row.displayName === null && row.remoteModelId === null
    ? null
    : {
        metadataJson: getJsonValue(row.metadataJson),
        modelName: row.displayName ?? row.remoteModelId ?? 'unknown model',
        providerKind: row.providerKind,
        remoteModelId: row.remoteModelId,
      }
}

export const getProjectFullTextGateModel = async (
  modelId: string,
  runner: FullTextGateRunner = getAppDatabaseService(),
): Promise<ProjectFullTextGateModel | null> => {
  const [row] = await runner.queryJson<ProjectFullTextGateModelRow>(`
    SELECT
      COALESCE(m.display_name, m.name) AS displayName,
      TO_JSON(m.metadata_json) AS metadataJson,
      pc.provider_kind AS providerKind,
      m.remote_model_id AS remoteModelId
    FROM app.model m
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE m.id = ${getSqlLiteral(modelId)}
    LIMIT 1
  `)

  return row ? getProjectFullTextGateModelFromRow(row) : null
}

export const getProjectFullTextGateSelectSql = (projectAlias: string): string => {
  return `
    ${projectAlias}.use_fulltext AS useFulltext,
    ${projectAlias}.use_fulltext_no_images AS useFulltextNoImages,
    ${projectAlias}.full_text_figure_mode AS fullTextFigureMode,
    TO_JSON(${projectAlias}.full_text_chunk_policy) AS fullTextChunkPolicy,
    ${projectAlias}.full_text_strategy_id AS fullTextStrategyId,
    (
      SELECT full_text_strategy.label
      FROM app.full_text_strategy full_text_strategy
      WHERE full_text_strategy.id = ${projectAlias}.full_text_strategy_id
    ) AS fullTextStrategyStoredLabel,
    (
      SELECT TO_JSON(full_text_strategy.inputs)
      FROM app.full_text_strategy full_text_strategy
      WHERE full_text_strategy.id = ${projectAlias}.full_text_strategy_id
    ) AS fullTextStrategyInputs
  `
}

export const isProjectFullTextGateRowFullText = (row: ProjectFullTextGateProjectRow): boolean => {
  return Boolean(row.useFulltext) || Boolean(row.useFulltextNoImages)
}

const getStoredStrategyInputs = (value: unknown): FullTextStrategyInputs | null => {
  const parsed = getJsonValue(value)

  return typeof parsed === 'object' && parsed !== null ? (parsed as FullTextStrategyInputs) : null
}

export const getStoredStrategyFromRow = (
  row: Pick<
    ProjectFullTextGateProjectRow,
    'fullTextStrategyId' | 'fullTextStrategyInputs' | 'fullTextStrategyStoredLabel'
  >,
): ProjectFullTextGateStoredStrategy => {
  const id = getEffectiveFullTextStrategyId(row.fullTextStrategyId)

  return {
    id,
    inputs: getStoredStrategyInputs(row.fullTextStrategyInputs),
    label: getFullTextStrategyDisplayLabel(id, row.fullTextStrategyStoredLabel),
  }
}

export const getProjectFullTextGateSelectionFromRow = (
  row: ProjectFullTextGateProjectRow,
): ProjectFullTextGateSelection => {
  return {
    fullTextChunkPolicy: getFullTextChunkPolicy(row.fullTextChunkPolicy),
    fullTextFigureMode: isFullTextFigureMode(row.fullTextFigureMode) ? row.fullTextFigureMode : null,
    useFulltext: isProjectFullTextGateRowFullText(row),
  }
}

export const evaluateStoredProjectFullTextGate = ({
  context,
  model,
  project,
}: {
  context: ProjectFullTextGateContext
  model: ProjectFullTextGateModel | null
  project: ProjectFullTextGateProjectRow
}): ProjectFullTextGateEvaluation => {
  return evaluateProjectFullTextGate({
    context,
    model,
    selection: getProjectFullTextGateSelectionFromRow(project),
    storedStrategy: getStoredStrategyFromRow(project),
  })
}

const getProjectFullTextGateRows = async (projectIds: readonly string[], runner: FullTextGateRunner) => {
  const uniqueProjectIds = [...new Set(projectIds)]

  return uniqueProjectIds.length === 0
    ? []
    : runner.queryJson<ProjectFullTextGateRow>(`
        SELECT
          p.id AS projectId,
          ${getProjectFullTextGateSelectSql('p')},
          COALESCE(m.display_name, m.name) AS displayName,
          TO_JSON(m.metadata_json) AS metadataJson,
          pc.provider_kind AS providerKind,
          m.remote_model_id AS remoteModelId
        FROM app.project p
        LEFT JOIN app.model m ON m.id = p.model_id
        LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
        WHERE p.id IN (${getQuotedStringList(uniqueProjectIds).join(', ')})
      `)
}

const getProjectFullTextGateRowEvaluation = (
  row: ProjectFullTextGateRow,
  context: ProjectFullTextGateContext | null,
): ProjectFullTextGateEvaluation => {
  return context && isProjectFullTextGateRowFullText(row)
    ? evaluateStoredProjectFullTextGate({context, model: getProjectFullTextGateModelFromRow(row), project: row})
    : emptyProjectFullTextGateEvaluation
}

export const getProjectFullTextGatesByProjectId = async (
  projectIds: readonly string[],
  runner: FullTextGateRunner = getAppDatabaseService(),
): Promise<Map<string, ProjectFullTextGateEvaluation>> => {
  const rows = await getProjectFullTextGateRows(projectIds, runner)
  const context = rows.some(isProjectFullTextGateRowFullText) ? await getProjectFullTextGateContext(runner) : null

  return new Map(
    rows.map((row) => {
      return [row.projectId, getProjectFullTextGateRowEvaluation(row, context)] as const
    }),
  )
}

export const getProjectFullTextGate = async (
  projectId: string,
  runner: FullTextGateRunner = getAppDatabaseService(),
): Promise<ProjectFullTextGateEvaluation> => {
  const gates = await getProjectFullTextGatesByProjectId([projectId], runner)

  return gates.get(projectId) ?? emptyProjectFullTextGateEvaluation
}

export const getProjectFullTextGateForSelection = async ({
  modelId,
  runner = getAppDatabaseService(),
  selection,
}: {
  modelId: string | null
  runner?: FullTextGateRunner
  selection: ProjectFullTextGateSelection
}): Promise<ProjectFullTextGateEvaluation> => {
  return selection.useFulltext
    ? evaluateProjectFullTextGate({
        context: await getProjectFullTextGateContext(runner),
        model: modelId ? await getProjectFullTextGateModel(modelId, runner) : null,
        selection,
      })
    : emptyProjectFullTextGateEvaluation
}

export const assertProjectFullTextJudgable = async (projectId: string): Promise<ProjectFullTextGateEvaluation> => {
  const gate = await getProjectFullTextGate(projectId)

  if (gate.errors.length > 0) {
    throw new HttpError(409, gate.errors.join(' '))
  }

  return gate
}
