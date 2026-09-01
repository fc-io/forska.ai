type PdfFont = 'regular' | 'bold'

type PdfTextOptions = {font?: PdfFont; fontSize?: number; gapAfter?: number; indent?: number}
type PdfCheckboxOptions = {checked?: boolean; fieldName: string; fontSize?: number; gapAfter?: number; indent?: number}
type PdfPanelOptions = {gapAfter?: number; title: string}
type PdfCheckboxField = {checked: boolean; fieldName: string; pageIndex: number; size: number; x: number; y: number}

const pageWidth = 595
const pageHeight = 842
const marginX = 48
const marginTop = 42
const marginBottom = 42
const lineHeightMultiplier = 1.25
const sectionFillColor = '0.96 0.98 1.00'
const sectionStrokeColor = '0.82 0.88 0.95'
const panelPaddingX = 14
const panelPaddingTop = 16
const panelPaddingBottom = 12

const getPdfSafeAsciiText = (value: string) => {
  return value
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/[\\()]/g, (match) => {
      return `\\${match}`
    })
}

const hasNonAsciiText = (value: string) => {
  return /[^\x20-\x7E]/.test(value)
}

const getUtf16BeHexText = (value: string) => {
  const utf16le = Buffer.from(value, 'utf16le')

  for (let index = 0; index < utf16le.length; index += 2) {
    const lowByte = utf16le[index]
    utf16le[index] = utf16le[index + 1] ?? 0
    utf16le[index + 1] = lowByte ?? 0
  }

  return utf16le.toString('hex').toUpperCase()
}

const getPdfTextCommand = (line: string, font: string, fontSize: number, x: number, y: number) => {
  if (hasNonAsciiText(line)) {
    return `BT /F3 ${fontSize} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td <${getUtf16BeHexText(line)}> Tj ET`
  }

  return `BT /${font} ${fontSize} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${getPdfSafeAsciiText(line)}) Tj ET`
}

const getCharacterWidthFactor = (character: string) => {
  if (/[^\x20-\x7E]/.test(character)) {
    return 1
  }

  if (/[ilI.,'`:;|!]/.test(character)) {
    return 0.25
  }

  if (/[mwMW@#%&]/.test(character)) {
    return 0.8
  }

  if (/[A-Z0-9]/.test(character)) {
    return 0.62
  }

  if (character === ' ') {
    return 0.28
  }

  return 0.5
}

const getTextWidth = (value: string, fontSize: number) => {
  return Array.from(value).reduce((width, character) => {
    return width + getCharacterWidthFactor(character) * fontSize
  }, 0)
}

const splitLongWordToWidth = (word: string, maxWidth: number, fontSize: number) => {
  const chunks: string[] = []
  let chunk = ''

  Array.from(word).forEach((character) => {
    const candidate = `${chunk}${character}`

    if (chunk && getTextWidth(candidate, fontSize) > maxWidth) {
      chunks.push(chunk)
      chunk = character
      return
    }

    chunk = candidate
  })

  if (chunk) {
    chunks.push(chunk)
  }

  return chunks.length > 0 ? chunks : [word]
}

const getWrappedLines = (value: string, maxWidth: number, fontSize: number) => {
  const paragraphs = value.split(/\r\n|\n|\r/g)

  return paragraphs.flatMap((paragraph) => {
    const words = paragraph
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .flatMap((word) => {
        return getTextWidth(word, fontSize) > maxWidth ? splitLongWordToWidth(word, maxWidth, fontSize) : [word]
      })

    if (words.length === 0) {
      return ['']
    }

    return words.reduce<string[]>(
      (lines, word) => {
        const currentLine = lines[lines.length - 1] ?? ''
        const candidate = currentLine ? `${currentLine} ${word}` : word

        if (getTextWidth(candidate, fontSize) <= maxWidth) {
          lines[lines.length - 1] = candidate
          return lines
        }

        lines.push(word)
        return lines
      },
      [''],
    )
  })
}

const getObject = (body: string | Buffer) => {
  return Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
}

export class SimplePdfDocument {
  private readonly pages: string[][] = [[]]
  private readonly checkboxFields: PdfCheckboxField[] = []
  private y = pageHeight - marginTop

  addPage() {
    this.pages.push([])
    this.y = pageHeight - marginTop
  }

  addText(value: string | null | undefined, options: PdfTextOptions = {}) {
    const text = String(value ?? '').trim()
    const fontSize = options.fontSize ?? 10
    const lineHeight = fontSize * lineHeightMultiplier
    const x = marginX + (options.indent ?? 0)
    const usableWidth = pageWidth - x - marginX
    const lines = getWrappedLines(text || ' ', usableWidth, fontSize)

    lines.forEach((line) => {
      if (this.y - lineHeight < marginBottom) {
        this.addPage()
      }

      const font = options.font === 'bold' ? 'F2' : 'F1'
      this.pages[this.pages.length - 1]?.push(getPdfTextCommand(line, font, fontSize, x, this.y))
      this.y -= lineHeight
    })

    this.y -= options.gapAfter ?? 0
  }

  addCheckbox(label: string, options: PdfCheckboxOptions) {
    const fontSize = options.fontSize ?? 10
    const lineHeight = fontSize * lineHeightMultiplier
    const size = Math.max(fontSize + 2, 12)
    const x = marginX + (options.indent ?? 0)

    if (this.y - lineHeight < marginBottom) {
      this.addPage()
    }

    const pageIndex = this.pages.length - 1
    const checkboxY = this.y + 2
    this.checkboxFields.push({
      checked: options.checked ?? false,
      fieldName: options.fieldName,
      pageIndex,
      size,
      x,
      y: checkboxY,
    })

    this.pages[pageIndex]?.push(getPdfTextCommand(label, 'F1', fontSize, x + size + 8, this.y))
    this.y -= lineHeight + (options.gapAfter ?? 0)
  }

  addGap(points: number) {
    this.y -= points

    if (this.y < marginBottom) {
      this.addPage()
    }
  }

  addPanel(options: PdfPanelOptions, renderContent: () => void) {
    if (this.y < marginBottom + 90) {
      this.addPage()
    }

    const pageIndex = this.pages.length - 1
    const startCommandIndex = this.pages[pageIndex]?.length ?? 0
    const topY = this.y

    this.y -= panelPaddingTop

    this.addText(options.title, {font: 'bold', fontSize: 12, gapAfter: 10, indent: panelPaddingX})
    renderContent()

    const bottomY =
      this.pages.length - 1 === pageIndex ? Math.max(this.y - panelPaddingBottom, marginBottom) : marginBottom
    const rectHeight = topY - bottomY
    const rectCommand = [
      'q',
      `${sectionFillColor} rg`,
      `${sectionStrokeColor} RG`,
      '1 w',
      `${(marginX - 8).toFixed(2)} ${bottomY.toFixed(2)} ${(pageWidth - marginX * 2 + 16).toFixed(2)} ${rectHeight.toFixed(2)} re`,
      'B',
      'Q',
    ].join(' ')
    this.pages[pageIndex]?.splice(startCommandIndex, 0, rectCommand)
    this.y = bottomY - (options.gapAfter ?? 10)
  }

  toBuffer() {
    const objects: Buffer[] = []
    const addObject = (body: string | Buffer) => {
      objects.push(getObject(body))
      return objects.length
    }
    const addStreamObject = (dictionary: string, stream: string | Buffer) => {
      const content = getObject(stream)

      return addObject(
        Buffer.concat([
          Buffer.from(`<< ${dictionary} /Length ${content.length} >>\nstream\n`),
          content,
          Buffer.from('\nendstream'),
        ]),
      )
    }

    const catalogId = addObject('')
    const pagesId = addObject('')
    const regularFontId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    const boldFontId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>')
    const cjkDescendantFontId = addObject(
      '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /DW 1000 >>',
    )
    const cjkFontId = addObject(
      `<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [${cjkDescendantFontId} 0 R] >>`,
    )
    const checkboxOnAppearanceId = addStreamObject(
      '/Type /XObject /Subtype /Form /BBox [0 0 12 12] /Resources << >>',
      'q 1 1 1 rg 0.45 0.52 0.60 RG 1 w 0.5 0.5 11 11 re B 0.12 0.33 0.60 RG 1.8 w 2.7 6 m 5.1 3.6 l 9.4 8.7 l S Q',
    )
    const checkboxOffAppearanceId = addStreamObject(
      '/Type /XObject /Subtype /Form /BBox [0 0 12 12] /Resources << >>',
      'q 1 1 1 rg 0.45 0.52 0.60 RG 1 w 0.5 0.5 11 11 re B Q',
    )
    const checkboxFieldIds = this.checkboxFields.map((field) => {
      const state = field.checked ? '/Yes' : '/Off'

      return addObject(
        [
          '<< /Type /Annot /Subtype /Widget /FT /Btn',
          `/T (${getPdfSafeAsciiText(field.fieldName)})`,
          `/Rect [${field.x.toFixed(2)} ${(field.y - field.size).toFixed(2)} ${(field.x + field.size).toFixed(2)} ${field.y.toFixed(2)}]`,
          `/V ${state} /AS ${state} /F 4 /H /P`,
          '/MK << /BC [0.45 0.52 0.60] /BG [1 1 1] /CA (4) >>',
          '/BS << /W 1 /S /S >>',
          `/AP << /N << /Yes ${checkboxOnAppearanceId} 0 R /Off ${checkboxOffAppearanceId} 0 R >> >>`,
          '>>',
        ].join(' '),
      )
    })
    const pageIds: number[] = []

    this.pages.forEach((pageCommands, index) => {
      pageCommands.push(`BT /F1 8 Tf ${(pageWidth - marginX - 28).toFixed(2)} 24.00 Td (Page ${index + 1}) Tj ET`)
      const pageCheckboxIds = checkboxFieldIds.filter((_, fieldIndex) => {
        return this.checkboxFields[fieldIndex]?.pageIndex === index
      })
      const contentId = addStreamObject('', pageCommands.join('\n'))
      const pageId = addObject(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${regularFontId} 0 R /F2 ${boldFontId} 0 R /F3 ${cjkFontId} 0 R >> >> /Contents ${contentId} 0 R${
          pageCheckboxIds.length > 0
            ? ` /Annots [${pageCheckboxIds
                .map((fieldId) => {
                  return `${fieldId} 0 R`
                })
                .join(' ')}]`
            : ''
        } >>`,
      )

      pageIds.push(pageId)
    })

    objects[catalogId - 1] = getObject(
      `<< /Type /Catalog /Pages ${pagesId} 0 R${
        checkboxFieldIds.length > 0
          ? ` /AcroForm << /Fields [${checkboxFieldIds
              .map((fieldId) => {
                return `${fieldId} 0 R`
              })
              .join(' ')}] /NeedAppearances true >>`
          : ''
      } >>`,
    )
    objects[pagesId - 1] = getObject(
      `<< /Type /Pages /Kids [${pageIds
        .map((pageId) => {
          return `${pageId} 0 R`
        })
        .join(' ')}] /Count ${pageIds.length} >>`,
    )

    const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n')]
    const offsets = [0]

    objects.forEach((object, index) => {
      offsets.push(Buffer.concat(chunks).length)
      chunks.push(Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n'))
    })

    const xrefOffset = Buffer.concat(chunks).length
    chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`))
    offsets.slice(1).forEach((offset) => {
      chunks.push(Buffer.from(`${offset.toString().padStart(10, '0')} 00000 n \n`))
    })
    chunks.push(
      Buffer.from(
        `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
      ),
    )

    return Buffer.concat(chunks)
  }
}
