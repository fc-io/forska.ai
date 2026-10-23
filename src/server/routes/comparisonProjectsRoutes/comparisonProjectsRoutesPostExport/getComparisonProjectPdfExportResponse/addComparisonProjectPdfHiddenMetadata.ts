import {SimplePdfDocument} from '../../../../utils/simplePdf.ts'

const getComparisonProjectPdfMetadataValue = (value: unknown) => {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

export const addComparisonProjectPdfHiddenMetadata = (pdf: SimplePdfDocument, fieldName: string, value: unknown) => {
  pdf.addTextField({fieldName, hidden: true, value: getComparisonProjectPdfMetadataValue(value)})
}
