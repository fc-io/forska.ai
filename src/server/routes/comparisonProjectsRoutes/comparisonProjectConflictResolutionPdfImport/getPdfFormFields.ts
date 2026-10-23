import {getPdfDocumentIndex} from './getPdfFormFields/getPdfDocumentIndex.ts'
import {
  getPdfDictionaryEntries,
  getPdfPatternEndIndex,
  pdfNamePattern,
  readPdfStringToken,
} from './getPdfFormFields/pdfSyntaxReader.ts'
import {getDecodedPdfText} from './pdfTextDecoding.ts'

export type PdfFormField = {
  name: string
  value: string | null
  fieldType: 'button' | 'text' | 'unknown'
  hasUnresolvedValueReference: boolean
}

const pdfIndirectReferencePattern = /(\d+)\s+\d+\s+R/y

const getPdfTextStringAt = (source: string, index: number) => {
  const stringToken = readPdfStringToken(source, index)

  return stringToken ? getDecodedPdfText(stringToken.bytes) : null
}

const getPdfFieldValue = (dictionary: string, valueIndex: number, stringObjects: ReadonlyMap<string, string>) => {
  pdfIndirectReferencePattern.lastIndex = valueIndex
  const objectNumber = pdfIndirectReferencePattern.exec(dictionary)?.[1] ?? null
  const referencedBytes = objectNumber === null ? undefined : stringObjects.get(objectNumber)

  if (objectNumber !== null) {
    return {
      hasUnresolvedValueReference: referencedBytes === undefined,
      value: referencedBytes === undefined ? null : getDecodedPdfText(referencedBytes),
    }
  }

  return {
    hasUnresolvedValueReference: false,
    value: getPdfTextStringAt(dictionary, valueIndex) ?? getPdfNameAt(dictionary, valueIndex),
  }
}

const getPdfNameAt = (source: string, index: number) => {
  return source[index] === '/'
    ? source.slice(index + 1, getPdfPatternEndIndex(pdfNamePattern, source, index)) || null
    : null
}

const getPdfFormField = (dictionary: string, stringObjects: ReadonlyMap<string, string>): PdfFormField[] => {
  const entries = getPdfDictionaryEntries(dictionary)
  const fieldTypeIndex = entries.get('FT')
  const nameIndex = entries.get('T')
  const valueIndex = entries.get('V')
  const name =
    fieldTypeIndex === undefined || nameIndex === undefined ? null : getPdfTextStringAt(dictionary, nameIndex)

  if (!name || fieldTypeIndex === undefined) {
    return []
  }

  const fieldTypeName = getPdfNameAt(dictionary, fieldTypeIndex)
  const fieldValue =
    valueIndex === undefined
      ? {hasUnresolvedValueReference: false, value: null}
      : getPdfFieldValue(dictionary, valueIndex, stringObjects)
  const fieldType = fieldTypeName === 'Btn' ? 'button' : fieldTypeName === 'Tx' ? 'text' : 'unknown'

  return [{name, fieldType, ...fieldValue}]
}

const getLatestPdfFormFields = (fields: readonly PdfFormField[]) => {
  return Array.from(
    fields
      .reduce<Map<string, PdfFormField>>((fieldMap, field) => {
        return fieldMap.set(field.name, field)
      }, new Map<string, PdfFormField>())
      .values(),
  )
}

export const getPdfFormFields = (source: string): PdfFormField[] => {
  const documentIndex = getPdfDocumentIndex(source)

  return getLatestPdfFormFields(
    documentIndex.dictionaries.flatMap((dictionary) => {
      return getPdfFormField(dictionary, documentIndex.stringObjects)
    }),
  )
}
