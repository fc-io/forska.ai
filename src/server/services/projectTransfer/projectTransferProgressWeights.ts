import type {
  ProjectTransferOverallProgress,
  ProjectTransferOverallProgressOperation,
} from './projectTransferContracts.ts'

type ProjectTransferProgressWeight = {key: string; label: string; weight: number}
type ProjectTransferProgressShare = {key: string; label: string; share: number}

// Measured shares of the 507 MB f77c package imported with the speedups in place (first import, re-import, and a
// re-import whose commit took the full revalidation path), see
// forska-plans/2026-10-15-import-analyze-create-speed-implementation.md. Commit weights follow the full revalidation
// path; when revalidation is skipped the bar moves past that step at once. Recalibrate from performanceMetrics.phases.
export const projectTransferOverallProgressSteps = {
  analyze: [
    {key: 'upload', label: 'Uploading package', weight: 3},
    {key: 'zipScan', label: 'Scanning package archive', weight: 15},
    {key: 'payloadParse', label: 'Parsing package payloads', weight: 38},
    {key: 'targetAnalysis', label: 'Analyzing target project', weight: 22},
    {key: 'dependencies', label: 'Resolving dependencies', weight: 17},
    {key: 'finalize', label: 'Finalizing analysis', weight: 5},
  ],
  commit: [
    {key: 'waitForDuckdb', label: 'Waiting for the database', weight: 2},
    {key: 'revalidation', label: 'Revalidating the import plan', weight: 32},
    {key: 'loadPayloads', label: 'Loading package payloads', weight: 3},
    {key: 'prepare', label: 'Preparing project writes', weight: 3},
    {key: 'writeTables', label: 'Writing project data', weight: 57},
    {key: 'finish', label: 'Finishing import', weight: 3},
  ],
} as const satisfies Record<ProjectTransferOverallProgressOperation, readonly ProjectTransferProgressWeight[]>

export const projectTransferTargetAnalysisStepShares = [
  {key: 'setup', label: 'Loading target analysis tables', share: 0.15},
  {key: 'articleMatch', label: 'Matching package articles', share: 0.15},
  {key: 'articleUpdate', label: 'Planning article updates', share: 0.3},
  {key: 'routes', label: 'Planning prompts and import routes', share: 0.3},
  {key: 'assets', label: 'Planning asset promotion', share: 0.05},
  {key: 'fidelity', label: 'Validating judgment and review fidelity', share: 0.05},
] as const satisfies readonly ProjectTransferProgressShare[]

export const projectTransferRevalidationPartShares = [
  {key: 'payloads', label: 'Reading staged payloads', share: 0.07},
  {key: 'targetAnalysis', label: 'Analyzing target project', share: 0.61},
  {key: 'dependencies', label: 'Revalidating dependencies', share: 0.32},
] as const satisfies readonly ProjectTransferProgressShare[]

export type ProjectTransferOverallProgressStepKey<TOperation extends ProjectTransferOverallProgressOperation> =
  (typeof projectTransferOverallProgressSteps)[TOperation][number]['key']

export type ProjectTransferTargetAnalysisStepKey = (typeof projectTransferTargetAnalysisStepShares)[number]['key']

export type ProjectTransferTargetAnalysisProgress = {step: ProjectTransferTargetAnalysisStepKey; stepFraction: number}

export type ProjectTransferRevalidationPartKey = (typeof projectTransferRevalidationPartShares)[number]['key']

export type ProjectTransferRevalidationProgress = {
  message: string
  part: ProjectTransferRevalidationPartKey
  partFraction: number
}

export type ProjectTransferCommitWriterStepProgress = {
  completedRows: number
  count: number
  index: number
  key: string
  label: string
  rows: number
  totalRows: number
}

const getUnitFraction = (value: number) => {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

const getRoundedPercent = (value: number) => {
  return Math.min(100, Math.max(0, Math.round(value * 100) / 100))
}

const sumWeights = (weights: readonly number[]) => {
  return weights.reduce((total, weight) => {
    return total + weight
  }, 0)
}

const getShareFraction = ({
  key,
  keyFraction,
  shares,
}: {
  key: string
  keyFraction: number
  shares: readonly ProjectTransferProgressShare[]
}) => {
  const index = Math.max(
    0,
    shares.findIndex((share) => {
      return share.key === key
    }),
  )
  const completedShare = sumWeights(
    shares.slice(0, index).map((share) => {
      return share.share
    }),
  )

  return getUnitFraction(completedShare + (shares[index]?.share ?? 0) * getUnitFraction(keyFraction))
}

export const getProjectTransferOverallProgressStepLabel = (
  shares: readonly ProjectTransferProgressShare[],
  key: string,
) => {
  return (
    shares.find((share) => {
      return share.key === key
    })?.label ?? key
  )
}

export const getProjectTransferTargetAnalysisFraction = (progress: ProjectTransferTargetAnalysisProgress) => {
  return getShareFraction({
    key: progress.step,
    keyFraction: progress.stepFraction,
    shares: projectTransferTargetAnalysisStepShares,
  })
}

export const getProjectTransferRevalidationFraction = (progress: ProjectTransferRevalidationProgress) => {
  return getShareFraction({
    key: progress.part,
    keyFraction: progress.partFraction,
    shares: projectTransferRevalidationPartShares,
  })
}

export const getProjectTransferCommitWriterFraction = (step: ProjectTransferCommitWriterStepProgress) => {
  const indexFraction = step.count > 0 ? (step.index - 1) / step.count : 0
  const rowFraction = step.totalRows > 0 ? step.completedRows / step.totalRows : indexFraction

  return getUnitFraction(indexFraction / 2 + rowFraction / 2)
}

export const getProjectTransferOverallProgress = <TOperation extends ProjectTransferOverallProgressOperation>({
  operation,
  previousPercent = 0,
  step,
  stepFraction,
}: {
  operation: TOperation
  previousPercent?: number
  step: ProjectTransferOverallProgressStepKey<TOperation>
  stepFraction: number | null
}): ProjectTransferOverallProgress => {
  const steps: readonly ProjectTransferProgressWeight[] = projectTransferOverallProgressSteps[operation]
  const index = Math.max(
    0,
    steps.findIndex((entry) => {
      return entry.key === step
    }),
  )
  const stepWeight = steps[index] ?? {key: step, label: step, weight: 0}
  const startPercent = getRoundedPercent(
    sumWeights(
      steps.slice(0, index).map((entry) => {
        return entry.weight
      }),
    ),
  )
  const endPercent = getRoundedPercent(startPercent + stepWeight.weight)
  const fraction = stepFraction === null ? null : getUnitFraction(stepFraction)
  const percent = getRoundedPercent(startPercent + (endPercent - startPercent) * (fraction ?? 0))

  return {
    operation,
    percent: Math.max(getRoundedPercent(previousPercent), percent),
    step: {
      count: steps.length,
      endPercent,
      index: index + 1,
      key: stepWeight.key,
      label: stepWeight.label,
      startPercent,
    },
    stepFraction: fraction,
  }
}

export const getProjectTransferCompletedOverallProgress = (
  operation: ProjectTransferOverallProgressOperation,
): ProjectTransferOverallProgress => {
  return operation === 'analyze'
    ? getProjectTransferOverallProgress({operation, step: 'finalize', stepFraction: 1})
    : getProjectTransferOverallProgress({operation, step: 'finish', stepFraction: 1})
}
