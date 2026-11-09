import type {ComparisonProjectCovidenceExportSelection} from '../../../../utils/comparisonProjectCovidenceExportSelection.ts'
import type {ComparisonProjectScope} from '../comparisonProjectScopeTypes.ts'

const getComparisonProjectCovidenceExportPartNumber = (partNumber: number, partCount: number) => {
  return String(partNumber).padStart(Math.max(2, String(partCount).length), '0')
}

const getComparisonProjectCovidenceExportKind = (invertSelection: boolean) => {
  return invertSelection ? 'not_matching' : 'full_text'
}

export const getComparisonProjectCovidenceExportFilenameStem = (
  scope: Pick<ComparisonProjectScope, 'name'>,
  selection: Pick<ComparisonProjectCovidenceExportSelection, 'invertSelection'>,
) => {
  return `${scope.name.replace(/[^a-zA-Z0-9]/g, '_')}_covidence_${getComparisonProjectCovidenceExportKind(selection.invertSelection)}_export_${new Date().toISOString().slice(0, 10)}`
}

export const getComparisonProjectCovidenceExportPartFilename = (
  filenameStem: string,
  partIndex: number,
  partCount: number,
) => {
  return `${filenameStem}_part${getComparisonProjectCovidenceExportPartNumber(partIndex + 1, partCount)}_of_${getComparisonProjectCovidenceExportPartNumber(partCount, partCount)}.ris`
}
