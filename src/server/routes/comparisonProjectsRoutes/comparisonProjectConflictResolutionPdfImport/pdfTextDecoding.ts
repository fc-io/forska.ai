type PdfTextDecoder = {bom: string; decode: (bytes: string) => string}

const pdfDocEncodingCharacters = new Map<number, string>([
  ...[0x02d8, 0x02c7, 0x02c6, 0x02d9, 0x02dd, 0x02db, 0x02da, 0x02dc].map((codePoint, index) => {
    return [0x18 + index, String.fromCodePoint(codePoint)] as const
  }),
  ...[
    0x2022, 0x2020, 0x2021, 0x2026, 0x2014, 0x2013, 0x0192, 0x2044, 0x2039, 0x203a, 0x2212, 0x2030, 0x201e, 0x201c,
    0x201d, 0x2018, 0x2019, 0x201a, 0x2122, 0xfb01, 0xfb02, 0x0141, 0x0152, 0x0160, 0x0178, 0x017d, 0x0131, 0x0142,
    0x0153, 0x0161, 0x017e,
  ].map((codePoint, index) => {
    return [0x80 + index, String.fromCodePoint(codePoint)] as const
  }),
  [0x7f, ''],
  [0x9f, ''],
  [0xa0, String.fromCodePoint(0x20ac)],
  [0xad, ''],
])

const getUtf16Buffer = (bytes: string) => {
  return Buffer.from(bytes.length % 2 === 0 ? bytes : bytes.slice(0, -1), 'latin1')
}

const pdfTextDecoders: PdfTextDecoder[] = [
  {
    bom: String.fromCharCode(0xfe, 0xff),
    decode: (bytes) => {
      return getUtf16Buffer(bytes).swap16().toString('utf16le')
    },
  },
  {
    bom: String.fromCharCode(0xff, 0xfe),
    decode: (bytes) => {
      return getUtf16Buffer(bytes).toString('utf16le')
    },
  },
  {
    bom: String.fromCharCode(0xef, 0xbb, 0xbf),
    decode: (bytes) => {
      return Buffer.from(bytes, 'latin1').toString('utf8')
    },
  },
]

const getPdfDocEncodingText = (bytes: string) => {
  return Array.from(bytes)
    .map((character) => {
      return pdfDocEncodingCharacters.get(character.charCodeAt(0)) ?? character
    })
    .join('')
}

const getUnicodePdfText = (bytes: string) => {
  const decoder = pdfTextDecoders.find((textDecoder) => {
    return bytes.startsWith(textDecoder.bom)
  })

  return decoder ? decoder.decode(bytes.slice(decoder.bom.length)) : getPdfDocEncodingText(bytes)
}

export const getLineFeedText = (value: string) => {
  return value.replace(/\r\n?/g, '\n')
}

export const getDecodedPdfText = (bytes: string) => {
  return getLineFeedText(getUnicodePdfText(bytes))
}
