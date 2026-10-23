import {SimplePdfDocument} from '../../../../../utils/simplePdf.ts'
import type {ComparisonProjectJudgmentsColumn} from '../../../comparisonProjectScopeTypes.ts'
import {type ComparisonProjectExportRow, getComparisonProjectExportCellValue} from '../../comparisonProjectExportRow.ts'

export const addComparisonProjectPdfSummaryJudgmentSection = (
  pdf: SimplePdfDocument,
  row: ComparisonProjectExportRow,
  columns: readonly ComparisonProjectJudgmentsColumn[],
) => {
  pdf.addPanel({title: 'Summary judgment'}, () => {
    const columnsByPrompt = columns.reduce<Map<string, ComparisonProjectJudgmentsColumn[]>>((columnMap, column) => {
      const promptColumns = columnMap.get(column.promptId) ?? []
      promptColumns.push(column)
      columnMap.set(column.promptId, promptColumns)
      return columnMap
    }, new Map<string, ComparisonProjectJudgmentsColumn[]>())

    Array.from(columnsByPrompt.entries()).forEach(([, promptColumns]) => {
      pdf.addText('Include this study?', {font: 'bold', fontSize: 10, gapAfter: 4})

      promptColumns.forEach((column) => {
        const answer = getComparisonProjectExportCellValue(row.cells[column.id]) || 'Not answered'
        const sourceLabel = column.kind === 'human' ? 'Human judgment' : `LLM judgment: ${column.modelLabel}`

        pdf.ensureSpace(30)
        pdf.addText(sourceLabel, {font: 'bold', fontSize: 10})
        pdf.addText(`Answer: ${answer}`, {fontSize: 10, indent: 12})

        pdf.addGap(5)
      })
      pdf.addGap(8)
    })
  })
}
