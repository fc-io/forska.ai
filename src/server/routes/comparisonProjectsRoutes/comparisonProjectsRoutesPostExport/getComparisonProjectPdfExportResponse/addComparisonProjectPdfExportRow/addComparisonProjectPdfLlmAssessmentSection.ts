import {getJsonValue} from '../../../../../services/appQueryHelpers.ts'
import {SimplePdfDocument} from '../../../../../utils/simplePdf.ts'
import {getComparisonProjectColumnId, getComparisonProjectContentKey} from '../../../comparisonProjectJudgmentRows.ts'
import {summaryPromptId} from '../../../comparisonProjectRouteConstants.ts'
import type {ComparisonProjectLlmRow} from '../../../comparisonProjectRouteTypes.ts'
import type {
  ComparisonProjectJudgmentsColumn,
  ComparisonProjectScope,
  ComparisonProjectSourceSummaryPromptConfig,
} from '../../../comparisonProjectScopeTypes.ts'
import {getIsSummaryMode} from '../../../getIsSummaryMode.ts'
import {type ComparisonProjectExportRow, getComparisonProjectExportCellValue} from '../../comparisonProjectExportRow.ts'

type ComparisonProjectPdfAssessmentDetail = {answer: string; explanation: string; label: string; quotes: string}
type ComparisonProjectPdfSummaryJudgment = {
  answer: string
  contentLabel: string | null
  details: ComparisonProjectPdfAssessmentDetail[]
  sourceLabel: string
}

const getComparisonProjectPdfQuotesValue = (value: unknown) => {
  const quotesValue = getJsonValue(value)

  return Array.isArray(quotesValue)
    ? quotesValue
        .map((quote) => {
          return typeof quote === 'string' ? quote : JSON.stringify(quote)
        })
        .join('; ')
    : typeof quotesValue === 'string'
      ? quotesValue
      : quotesValue === null || quotesValue === undefined
        ? ''
        : JSON.stringify(quotesValue)
}

const addComparisonProjectPdfLabeledValue = (
  pdf: SimplePdfDocument,
  label: string,
  value: string | null | undefined,
  indent: number,
) => {
  const normalizedValue = getComparisonProjectExportCellValue(value)

  if (normalizedValue) {
    pdf.addText(`${label}: ${normalizedValue}`, {fontSize: 10, indent})
  }
}

const getComparisonProjectPdfAssessmentDetail = (
  prompt: ComparisonProjectSourceSummaryPromptConfig,
  row: ComparisonProjectLlmRow,
): ComparisonProjectPdfAssessmentDetail => {
  return {
    answer: getComparisonProjectExportCellValue(row.answeredOriginal) || 'Not answered',
    explanation: getComparisonProjectExportCellValue(row.explanation),
    label: prompt.promptLabel,
    quotes: getComparisonProjectPdfQuotesValue(row.quotes),
  }
}

const addComparisonProjectPdfAssessmentDetail = (
  pdf: SimplePdfDocument,
  detail: ComparisonProjectPdfAssessmentDetail,
) => {
  pdf.ensureSpace(38)
  pdf.addText(detail.label, {font: 'bold', fontSize: 10, indent: 24})
  pdf.addText(`Answer: ${detail.answer}`, {fontSize: 10, indent: 36})
  addComparisonProjectPdfLabeledValue(pdf, 'Explanation', detail.explanation, 36)
  addComparisonProjectPdfLabeledValue(pdf, 'Quotes', detail.quotes, 36)
}

const getComparisonProjectPdfAssessmentDetails = (params: {
  column: ComparisonProjectJudgmentsColumn
  componentRows: readonly ComparisonProjectLlmRow[]
  scope: ComparisonProjectScope
}) => {
  if (params.column.kind !== 'llm' || params.column.promptId !== summaryPromptId || !getIsSummaryMode(params.scope)) {
    return []
  }

  return params.scope.sourceProjectSummaryPrompts
    .filter((prompt) => {
      return params.column.sourceProjectId === null || prompt.sourceProjectId === params.column.sourceProjectId
    })
    .flatMap<ComparisonProjectPdfAssessmentDetail>((prompt) => {
      return params.componentRows
        .filter((row) => {
          return (
            row.promptId === prompt.id
            && getComparisonProjectColumnId(
              'llm',
              summaryPromptId,
              row.modelId,
              getComparisonProjectContentKey(row),
              params.column.sourceProjectId,
            ) === params.column.id
          )
        })
        .map((row) => {
          return getComparisonProjectPdfAssessmentDetail(prompt, row)
        })
    })
}

const getComparisonProjectPdfSummaryJudgments = (params: {
  columns: readonly ComparisonProjectJudgmentsColumn[]
  componentRows: readonly ComparisonProjectLlmRow[]
  row: ComparisonProjectExportRow
  scope: ComparisonProjectScope
}) => {
  return params.columns.flatMap<ComparisonProjectPdfSummaryJudgment>((column) => {
    const details = getComparisonProjectPdfAssessmentDetails({
      column,
      componentRows: params.componentRows,
      scope: params.scope,
    })

    if (details.length === 0) {
      return []
    }

    return [
      {
        answer: getComparisonProjectExportCellValue(params.row.cells[column.id]) || 'Not answered',
        contentLabel: column.kind === 'llm' ? column.contentLabel : null,
        details,
        sourceLabel: column.kind === 'human' ? 'Human judgment' : `LLM judgment: ${column.modelLabel}`,
      },
    ]
  })
}

export const addComparisonProjectPdfLlmAssessmentSection = (
  pdf: SimplePdfDocument,
  row: ComparisonProjectExportRow,
  columns: readonly ComparisonProjectJudgmentsColumn[],
  scope: ComparisonProjectScope,
  componentRows: readonly ComparisonProjectLlmRow[],
) => {
  const summaryJudgments = getComparisonProjectPdfSummaryJudgments({columns, componentRows, row, scope})

  if (summaryJudgments.length === 0) {
    return
  }

  pdf.addPanel({title: 'LLM assessment'}, () => {
    summaryJudgments.forEach((summaryJudgment) => {
      pdf.ensureSpace(30)
      pdf.addText(summaryJudgment.sourceLabel, {font: 'bold', fontSize: 10})

      summaryJudgment.details.forEach((detail) => {
        addComparisonProjectPdfAssessmentDetail(pdf, detail)
      })
      pdf.addGap(5)
    })
  })
}
