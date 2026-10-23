import {SimplePdfDocument} from '../../../../utils/simplePdf.ts'
import type {ComparisonProjectScope} from '../../comparisonProjectScopeTypes.ts'
import {addComparisonProjectPdfHiddenMetadata} from './addComparisonProjectPdfHiddenMetadata.ts'

export const comparisonProjectPdfFrontPageFontSizes = {body: 10, heading: 11, title: 18} as const
const comparisonProjectPdfReviewerNameHelperText =
  'Enter the name that should be attached to imported conflict resolutions and comments.\nOptional, but helps distinguish different reviewers.'

export const addComparisonProjectPdfFrontPage = (params: {
  exportFilters: string
  exportedAt: string
  pdf: SimplePdfDocument
  scope: ComparisonProjectScope
  totalCount: number
}) => {
  const {exportFilters, exportedAt, pdf, scope, totalCount} = params
  const documentId = crypto.randomUUID()

  addComparisonProjectPdfHiddenMetadata(pdf, 'forska.import.format', {
    documentId,
    format: 'forska.comparisonProject.pdfConflictResolutionImport',
    github: 'https://github.com/fc-io/forska.ai',
    version: 1,
  })
  addComparisonProjectPdfHiddenMetadata(pdf, 'forska.import.comparisonProject', {
    allowConflictResolution: scope.allowConflictResolution,
    comparisonProjectId: scope.id,
    comparisonProjectName: scope.name,
    exportedAt,
    filters: exportFilters,
    humanJudgmentMode: scope.humanJudgmentMode,
    judgmentContextId: scope.judgmentContextId,
    totalCount,
  })

  const frontPageFontSizes = comparisonProjectPdfFrontPageFontSizes

  pdf.addText('forska.ai conflict resolutions review', {font: 'bold', fontSize: frontPageFontSizes.title, gapAfter: 10})
  pdf.addText('Project', {font: 'bold', fontSize: frontPageFontSizes.heading, gapAfter: 4})
  pdf.addText(scope.name, {fontSize: frontPageFontSizes.body})
  pdf.addText(`Comparison project ID: ${scope.id}`, {fontSize: frontPageFontSizes.body})
  pdf.addText(`Exported: ${exportedAt}`, {fontSize: frontPageFontSizes.body})
  pdf.addText(`Export number of articles: ${totalCount}`, {fontSize: frontPageFontSizes.body})
  pdf.addText(`Filters: ${exportFilters}`, {fontSize: frontPageFontSizes.body, gapAfter: 12})
  pdf.addText('Offline review', {font: 'bold', fontSize: frontPageFontSizes.heading, gapAfter: 4})
  pdf.addText(
    "Use this PDF to assess review conflicts offline. Fill in or change the conflict resolution radio buttons and comments for the articles you've reviewed. This PDF can then be imported into a forska.ai project to compare results.",
    {fontSize: frontPageFontSizes.body, gapAfter: 12},
  )
  pdf.addTextField({
    fieldName: 'forska.reviewer.displayName',
    fontSize: frontPageFontSizes.body,
    label: 'Your name:',
    value: '',
    width: 320,
    gapAfter: 18,
  })
  pdf.addText(comparisonProjectPdfReviewerNameHelperText, {fontSize: frontPageFontSizes.body, gapAfter: 26})
  pdf.addText('Terminology', {font: 'bold', fontSize: frontPageFontSizes.heading, gapAfter: 4})
  pdf.addDefinitionRow(
    'Review conflict',
    'An article where AIs, or an AI and human reviewers, do not agree whether a study should be included.',
    {fontSize: frontPageFontSizes.body, gapAfter: 8},
  )
  pdf.addDefinitionRow(
    'Conflict resolution',
    'Your final choice for the inclusion of an article after reviewing the disagreement.',
    {fontSize: frontPageFontSizes.body, gapAfter: 8},
  )
  pdf.addDefinitionRow(
    'Summary judgment',
    'The overall include/exclude choice for the study after considering the individual criteria.',
    {fontSize: frontPageFontSizes.body, gapAfter: 8},
  )
  pdf.addDefinitionRow(
    'LLM assessment',
    'The model-generated answer and reasoning that can be compared with the human judgment.',
    {fontSize: frontPageFontSizes.body, gapAfter: 12},
  )
  pdf.addText('For more information about forska.ai, visit https://github.com/fc-io/forska.ai.', {
    fontSize: frontPageFontSizes.body,
  })
}
