import {getCovidencePackageConfig} from '../../services/covidenceImportService.ts'
import {getStructuredFileImportConfig} from '../../services/structuredFileImportService.ts'

export const getSafeStructuredFileImportConfig = (cursorValue: unknown) => {
  if (typeof cursorValue !== 'string') {
    return null
  }

  try {
    return getStructuredFileImportConfig(cursorValue)
  } catch {
    return null
  }
}

export const getSafeCovidencePackageConfig = (cursorValue: unknown) => {
  return typeof cursorValue === 'string' ? getCovidencePackageConfig(cursorValue) : null
}
