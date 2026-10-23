import {
  getPdfDictionaryEntries,
  getPdfNonWhitespaceIndex,
  getPdfPatternEndIndex,
  readPdfDictionaryEndIndex,
  readPdfStringToken,
} from './pdfSyntaxReader.ts'

type PdfDocumentIndex = {dictionaries: string[]; stringObjects: Map<string, string>}

const pdfTopLevelTokenStartPattern = /[%(<]|(?<![A-Za-z0-9])obj(?![A-Za-z0-9])/g
const pdfObjectKeyword = 'obj'
const pdfCommentPattern = /%[^\r\n]*/y
const pdfStreamKeywordPattern = /stream(?:\r\n|\r|\n)/y
const pdfDirectLengthPattern = /(\d+)(?!\d)(?!\s+\d+\s+R)/y

const pdfIndirectObjectHeaderPattern = /(\d+)\s+\d+\s+obj\s*$/
const pdfEndStreamKeyword = 'endstream'

const getPdfStreamEndIndex = (source: string, dictionary: string, dataStartIndex: number) => {
  const lengthIndex = getPdfDictionaryEntries(dictionary).get('Length')
  pdfDirectLengthPattern.lastIndex = lengthIndex ?? dictionary.length
  const directLength = lengthIndex === undefined ? null : pdfDirectLengthPattern.exec(dictionary)?.[1]
  const lengthEndIndex =
    directLength === undefined || directLength === null
      ? null
      : getPdfNonWhitespaceIndex(source, dataStartIndex + Number(directLength))
  const keywordIndex =
    lengthEndIndex !== null && source.startsWith(pdfEndStreamKeyword, lengthEndIndex)
      ? lengthEndIndex
      : source.indexOf(pdfEndStreamKeyword, dataStartIndex)

  return keywordIndex === -1 ? source.length : keywordIndex + pdfEndStreamKeyword.length
}

const getPdfIndexAfterStream = (source: string, dictionary: string, dictionaryEndIndex: number) => {
  const keywordIndex = getPdfNonWhitespaceIndex(source, dictionaryEndIndex)
  pdfStreamKeywordPattern.lastIndex = keywordIndex
  const keyword = pdfStreamKeywordPattern.exec(source)

  return keyword ? getPdfStreamEndIndex(source, dictionary, keywordIndex + keyword[0].length) : dictionaryEndIndex
}

const getPdfIndirectObjectNumber = (source: string, index: number) => {
  return pdfIndirectObjectHeaderPattern.exec(source.slice(Math.max(index - 40, 0), index))?.[1] ?? null
}

export const getPdfDocumentIndex = (source: string): PdfDocumentIndex => {
  const dictionaries: string[] = []
  const stringObjects = new Map<string, string>()
  let index = 0

  while (index < source.length) {
    pdfTopLevelTokenStartPattern.lastIndex = index
    const tokenStart = pdfTopLevelTokenStartPattern.exec(source)?.index ?? source.length
    const character = source[tokenStart]

    if (character === '%') {
      index = getPdfPatternEndIndex(pdfCommentPattern, source, tokenStart)
      continue
    }

    if (source.startsWith(pdfObjectKeyword, tokenStart)) {
      stringObjects.delete(getPdfIndirectObjectNumber(source, tokenStart + pdfObjectKeyword.length) ?? '')
      index = tokenStart + pdfObjectKeyword.length
      continue
    }

    if (character === '<' && source[tokenStart + 1] === '<') {
      const dictionaryEndIndex = readPdfDictionaryEndIndex(source, tokenStart)
      const dictionary = dictionaryEndIndex === null ? null : source.slice(tokenStart, dictionaryEndIndex)

      if (dictionary) {
        dictionaries.push(dictionary)
      }

      index = dictionary ? getPdfIndexAfterStream(source, dictionary, tokenStart + dictionary.length) : tokenStart + 2
      continue
    }

    const stringToken = tokenStart < source.length ? readPdfStringToken(source, tokenStart) : null
    const objectNumber = stringToken ? getPdfIndirectObjectNumber(source, tokenStart) : null

    if (stringToken && objectNumber) {
      stringObjects.set(objectNumber, stringToken.bytes)
    }

    index = stringToken ? stringToken.endIndex : tokenStart + 1
  }

  return {dictionaries, stringObjects}
}
