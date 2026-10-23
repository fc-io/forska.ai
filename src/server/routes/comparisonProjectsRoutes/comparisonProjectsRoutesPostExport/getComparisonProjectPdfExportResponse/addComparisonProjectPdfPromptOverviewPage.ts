import {SimplePdfDocument} from '../../../../utils/simplePdf.ts'
import type {ComparisonProjectScope} from '../../comparisonProjectScopeTypes.ts'
import {getIsSummaryMode} from '../../getIsSummaryMode.ts'
import {comparisonProjectPdfFrontPageFontSizes} from './addComparisonProjectPdfFrontPage.ts'

const getComparisonProjectPdfPromptOverviewPrompts = (scope: ComparisonProjectScope) => {
  return getIsSummaryMode(scope) && scope.sourceProjectSummaryPrompts.length > 0
    ? scope.sourceProjectSummaryPrompts
    : scope.prompts
}

export const addComparisonProjectPdfPromptOverviewPage = (pdf: SimplePdfDocument, scope: ComparisonProjectScope) => {
  const prompts = getComparisonProjectPdfPromptOverviewPrompts(scope)

  if (prompts.length === 0) {
    return
  }

  const frontPageFontSizes = comparisonProjectPdfFrontPageFontSizes

  pdf.addPage()
  pdf.addText('Prompts in this review', {font: 'bold', fontSize: frontPageFontSizes.title, gapAfter: 10})

  prompts.forEach((prompt) => {
    const heading = prompt.promptHeading?.trim()
    const title = heading ? `${prompt.order + 1}. ${heading}` : `${prompt.order + 1}. ${prompt.promptLabel}`
    const validOptions = prompt.type ? `Valid options: ${prompt.type}` : null

    pdf.ensureSpace(80)
    pdf.addText(title, {font: 'bold', fontSize: frontPageFontSizes.heading, gapAfter: 3})

    if (validOptions) {
      pdf.addText(validOptions, {fontSize: frontPageFontSizes.body, gapAfter: 4})
    }

    pdf.addText('Prompt:', {font: 'bold', fontSize: frontPageFontSizes.body, gapAfter: 2})
    pdf.addText(prompt.originalText, {fontSize: frontPageFontSizes.body, gapAfter: prompt.transformedText ? 5 : 12})

    if (prompt.transformedText) {
      pdf.addText('Transformed Text', {font: 'bold', fontSize: frontPageFontSizes.body, gapAfter: 2})
      pdf.addText(prompt.transformedText, {fontSize: frontPageFontSizes.body, gapAfter: 12})
    }
  })
}
