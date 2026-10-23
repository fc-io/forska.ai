type PdfStringToken = {bytes: string; endIndex: number}

const pdfWhitespaceCharacters = new Set(['\0', '\t', '\n', '\f', '\r', ' '])
const pdfLiteralStringEscapes = new Map([
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
])
const pdfLiteralStringDepthChanges = new Map([
  ['(', 1],
  [')', -1],
])
export const pdfNamePattern = /\/[^\0\t\n\f\r ()<>[\]{}/%]*/y
const pdfRegularTokenPattern = /[^\0\t\n\f\r ()<>[\]{}/%]+/y
const pdfOctalEscapePattern = /[0-7]{1,3}/y

export const getPdfPatternEndIndex = (pattern: RegExp, source: string, index: number) => {
  pattern.lastIndex = index

  return index + (pattern.exec(source)?.[0].length ?? 0)
}

export const getPdfNonWhitespaceIndex = (source: string, startIndex: number) => {
  let index = startIndex

  while (index < source.length && pdfWhitespaceCharacters.has(source[index] ?? '')) {
    index += 1
  }

  return index
}

const readPdfLiteralStringEscape = (source: string, index: number): PdfStringToken => {
  const character = source[index] ?? ''
  const octalEndIndex = getPdfPatternEndIndex(pdfOctalEscapePattern, source, index)

  if (octalEndIndex > index) {
    return {bytes: String.fromCharCode(parseInt(source.slice(index, octalEndIndex), 8) & 0xff), endIndex: octalEndIndex}
  }

  if (character === '\r') {
    return {bytes: '', endIndex: source[index + 1] === '\n' ? index + 2 : index + 1}
  }

  if (character === '\n') {
    return {bytes: '', endIndex: index + 1}
  }

  return {bytes: pdfLiteralStringEscapes.get(character) ?? character, endIndex: index + 1}
}

const readPdfLiteralString = (source: string, startIndex: number): PdfStringToken | null => {
  let bytes = ''
  let depth = 1
  let index = startIndex + 1

  while (index < source.length) {
    const character = source[index] ?? ''

    if (character === '\\') {
      const escape = readPdfLiteralStringEscape(source, index + 1)

      bytes += escape.bytes
      index = escape.endIndex
      continue
    }

    depth += pdfLiteralStringDepthChanges.get(character) ?? 0

    if (depth === 0) {
      return {bytes, endIndex: index + 1}
    }

    bytes += character
    index += 1
  }

  return null
}

const readPdfHexString = (source: string, startIndex: number): PdfStringToken | null => {
  const endIndex = source.indexOf('>', startIndex + 1)
  const digits = endIndex === -1 ? null : source.slice(startIndex + 1, endIndex).replace(/[\0\t\n\f\r ]/g, '')

  return digits !== null && /^[0-9a-fA-F]*$/.test(digits)
    ? {
        bytes: Buffer.from(digits.length % 2 === 0 ? digits : `${digits}0`, 'hex').toString('latin1'),
        endIndex: endIndex + 1,
      }
    : null
}

export const readPdfStringToken = (source: string, index: number) => {
  if (source[index] === '(') {
    return readPdfLiteralString(source, index)
  }

  return source[index] === '<' && source[index + 1] !== '<' ? readPdfHexString(source, index) : null
}

export const readPdfDictionaryEndIndex = (source: string, startIndex: number) => {
  let depth = 0
  let index = startIndex

  while (index < source.length) {
    const character = source[index]
    const isDoubleBracket = source[index + 1] === character

    if (character === '(' || (character === '<' && !isDoubleBracket)) {
      const stringToken = readPdfStringToken(source, index)

      if (!stringToken) {
        return null
      }

      index = stringToken.endIndex
      continue
    }

    if ((character === '<' || character === '>') && isDoubleBracket) {
      depth += character === '<' ? 1 : -1
      index += 2

      if (depth === 0) {
        return index
      }

      continue
    }

    index += 1
  }

  return null
}

const getPdfArrayEndIndex = (source: string, startIndex: number) => {
  let index = getPdfNonWhitespaceIndex(source, startIndex + 1)

  while (index < source.length && source[index] !== ']') {
    index = getPdfNonWhitespaceIndex(source, getPdfTokenEndIndex(source, index))
  }

  return Math.min(index + 1, source.length)
}

const getPdfTokenEndIndex = (source: string, index: number): number => {
  const character = source[index]

  if (character === '(' || (character === '<' && source[index + 1] !== '<')) {
    return readPdfStringToken(source, index)?.endIndex ?? source.length
  }

  if (character === '<') {
    return readPdfDictionaryEndIndex(source, index) ?? source.length
  }

  if (character === '[') {
    return getPdfArrayEndIndex(source, index)
  }

  return character === '/'
    ? getPdfPatternEndIndex(pdfNamePattern, source, index)
    : Math.max(getPdfPatternEndIndex(pdfRegularTokenPattern, source, index), index + 1)
}

export const getPdfDictionaryEntries = (dictionary: string) => {
  const entries = new Map<string, number>()
  const contentEndIndex = dictionary.length - 2
  let index = getPdfNonWhitespaceIndex(dictionary, 2)
  let key: string | null = null

  while (index < contentEndIndex) {
    const endIndex = getPdfTokenEndIndex(dictionary, index)

    if (key !== null && !entries.has(key)) {
      entries.set(key, index)
    }

    key = key === null && dictionary[index] === '/' ? dictionary.slice(index + 1, endIndex) : null
    index = getPdfNonWhitespaceIndex(dictionary, endIndex)
  }

  return entries
}
