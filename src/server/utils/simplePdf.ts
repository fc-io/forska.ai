type PdfFont = 'regular' | 'bold'

type PdfTextOptions = {font?: PdfFont; fontSize?: number; gapAfter?: number; indent?: number}
type PdfInlineTextSegment = {font?: PdfFont; text: string}
type PdfInlineTextOptions = {fontSize?: number; gapAfter?: number; indent?: number}
type PdfDefinitionRowOptions = {fontSize?: number; gapAfter?: number; termWidth?: number}
type PdfCheckboxOptions = {checked?: boolean; fieldName: string; fontSize?: number; gapAfter?: number; indent?: number}
type PdfCheckboxRowOption = PdfCheckboxOptions & {label: string}
type PdfRadioRowOption = {fontSize?: number; gapAfter?: number; indent?: number; label: string; value: string}
type PdfTextFieldOptions = {
  fieldName: string
  fontSize?: number
  gapAfter?: number
  hidden?: boolean
  indent?: number
  label?: string
  value?: string
  width?: number
}
type PdfPanelOptions = {gapAfter?: number; title: string}
type PdfCheckboxField = {checked: boolean; fieldName: string; pageIndex: number; size: number; x: number; y: number}
type PdfRadioField = {pageIndex: number; size: number; value: string; x: number; y: number}
type PdfRadioGroup = {fieldName: string; fields: PdfRadioField[]; selectedValue?: string}
type PdfTextField = {
  fieldName: string
  fontSize: number
  hidden: boolean
  pageIndex: number
  value: string
  width: number
  x: number
  y: number
}

const pageWidth = 595
const pageHeight = 842
const marginX = 48
const marginTop = 42
const marginBottom = 42
const lineHeightMultiplier = 1.25
const sectionFillColor = '0.96 0.98 1.00'
const sectionStrokeColor = '0.82 0.88 0.95'
const panelPaddingX = 16
const panelPaddingTop = 24
const panelPaddingBottom = 16

const getNormalizedPdfText = (value: string) => {
  return value.replace(/&#x0D;|&#13;/gi, '\n').replace(/&#x0A;|&#10;/gi, '\n')
}

const getPdfSafeAsciiText = (value: string) => {
  return value
    .normalize('NFKD')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u00A0/g, ' ')
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/[\\()]/g, (match) => {
      return `\\${match}`
    })
}

const getPdfSafeName = (value: string) => {
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, '_')

  return safe || 'Option'
}

const hasCjkText = (value: string) => {
  return /[\u3000-\u303F\u3400-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(value)
}

const isCjkCharacter = (value: string) => {
  return /^[\u3000-\u303F\u3400-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]$/.test(value)
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
  if (hasCjkText(line)) {
    const segments = Array.from(line).reduce<Array<{font: string; text: string}>>((textSegments, character) => {
      const segmentFont = isCjkCharacter(character) ? 'F3' : font
      const lastSegment = textSegments[textSegments.length - 1]

      if (lastSegment?.font === segmentFont) {
        lastSegment.text += character
        return textSegments
      }

      textSegments.push({font: segmentFont, text: character})
      return textSegments
    }, [])
    const textCommands = segments
      .map((segment) => {
        return segment.font === 'F3'
          ? `/F3 ${fontSize} Tf <${getUtf16BeHexText(segment.text)}> Tj`
          : `/${font} ${fontSize} Tf (${getPdfSafeAsciiText(segment.text)}) Tj`
      })
      .join(' ')

    return `BT ${x.toFixed(2)} ${y.toFixed(2)} Td ${textCommands} ET`
  }

  return `BT /${font} ${fontSize} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${getPdfSafeAsciiText(line)}) Tj ET`
}

type PdfTextMeasureMode = 'regular' | 'cjk'

const getCharacterWidthFactor = (character: string, mode: PdfTextMeasureMode = 'regular') => {
  if (mode === 'cjk') {
    return character === ' ' ? 0.5 : 1.08
  }

  if (isCjkCharacter(character)) {
    return 1.08
  }

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

const getTextWidth = (value: string, fontSize: number, mode: PdfTextMeasureMode = 'regular') => {
  return Array.from(value).reduce((width, character) => {
    return width + getCharacterWidthFactor(character, mode) * fontSize
  }, 0)
}

const splitLongWordToWidth = (
  word: string,
  maxWidth: number,
  fontSize: number,
  mode: PdfTextMeasureMode = 'regular',
) => {
  const chunks: string[] = []
  let chunk = ''

  Array.from(word).forEach((character) => {
    const candidate = `${chunk}${character}`

    if (chunk && getTextWidth(candidate, fontSize, mode) > maxWidth) {
      const hyphenatedChunk = `${chunk}-`
      chunks.push(
        mode === 'regular' && getTextWidth(hyphenatedChunk, fontSize, mode) <= maxWidth ? hyphenatedChunk : chunk,
      )
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

const getCjkWrappedLines = (paragraph: string, maxWidth: number, fontSize: number) => {
  const lines: string[] = []
  let line = ''
  let nonCjkRun = ''

  const appendToken = (token: string) => {
    if (!token) {
      return
    }

    if (token === ' ') {
      if (line && !line.endsWith(' ')) {
        line += token
      }

      return
    }

    const tokenParts =
      getTextWidth(token, fontSize, 'cjk') > maxWidth ? splitLongWordToWidth(token, maxWidth, fontSize, 'cjk') : [token]

    tokenParts.forEach((part) => {
      const candidate = `${line}${part}`

      if (line && getTextWidth(candidate, fontSize, 'cjk') > maxWidth) {
        lines.push(line.trimEnd())
        line = part.trimStart()
        return
      }

      line = candidate.trimStart()
    })
  }

  Array.from(paragraph.trim()).forEach((character) => {
    if (/\s/.test(character)) {
      appendToken(nonCjkRun)
      nonCjkRun = ''
      appendToken(' ')
      return
    }

    if (isCjkCharacter(character)) {
      appendToken(nonCjkRun)
      nonCjkRun = ''
      appendToken(character)
      return
    }

    nonCjkRun += character
  })

  appendToken(nonCjkRun)

  if (line) {
    lines.push(line.trimEnd())
  }

  return lines.length > 0 ? lines : ['']
}

const getWrappedLines = (value: string, maxWidth: number, fontSize: number) => {
  const paragraphs = value.split(/\r\n|\n|\r/g)

  return paragraphs.flatMap((paragraph) => {
    if (hasCjkText(paragraph)) {
      return getCjkWrappedLines(paragraph, maxWidth, fontSize)
    }

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
  private readonly radioGroups: PdfRadioGroup[] = []
  private readonly textFields: PdfTextField[] = []
  private y = pageHeight - marginTop

  addPage() {
    this.pages.push([])
    this.y = pageHeight - marginTop
  }

  addText(value: string | null | undefined, options: PdfTextOptions = {}) {
    const text = getNormalizedPdfText(String(value ?? '')).trim()
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

  addInlineText(segments: PdfInlineTextSegment[], options: PdfInlineTextOptions = {}) {
    const fontSize = options.fontSize ?? 10
    const lineHeight = fontSize * lineHeightMultiplier
    const startX = marginX + (options.indent ?? 0)

    if (this.y - lineHeight < marginBottom) {
      this.addPage()
    }

    segments.reduce((x, segment) => {
      const text = getNormalizedPdfText(segment.text).replace(/\s+/g, ' ')

      if (!text.trim()) {
        return x + getTextWidth(text, fontSize)
      }

      const font = segment.font === 'bold' ? 'F2' : 'F1'
      this.pages[this.pages.length - 1]?.push(getPdfTextCommand(text, font, fontSize, x, this.y))

      return x + getTextWidth(text, fontSize)
    }, startX)

    this.y -= lineHeight + (options.gapAfter ?? 0)
  }

  addDefinitionRow(term: string, definition: string, options: PdfDefinitionRowOptions = {}) {
    const fontSize = options.fontSize ?? 10
    const lineHeight = fontSize * lineHeightMultiplier
    const termWidth = options.termWidth ?? 118
    const columnGap = 18
    const termX = marginX
    const definitionX = termX + termWidth + columnGap
    const definitionWidth = pageWidth - definitionX - marginX
    const termLines = getWrappedLines(getNormalizedPdfText(term).trim() || ' ', termWidth, fontSize)
    const definitionLines = getWrappedLines(getNormalizedPdfText(definition).trim() || ' ', definitionWidth, fontSize)
    const rowLineCount = Math.max(termLines.length, definitionLines.length)
    const rowHeight = rowLineCount * lineHeight

    if (this.y - rowHeight < marginBottom) {
      this.addPage()
    }

    Array.from({length: rowLineCount}).forEach((_, index) => {
      const y = this.y - index * lineHeight
      const termLine = termLines[index]
      const definitionLine = definitionLines[index]

      if (termLine !== undefined) {
        this.pages[this.pages.length - 1]?.push(getPdfTextCommand(termLine, 'F2', fontSize, termX, y))
      }

      if (definitionLine !== undefined) {
        this.pages[this.pages.length - 1]?.push(getPdfTextCommand(definitionLine, 'F1', fontSize, definitionX, y))
      }
    })

    this.y -= rowHeight + (options.gapAfter ?? 0)
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
    const checkboxY = this.y + (lineHeight - size) / 2 + size - 2
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

  addCheckboxRow(options: PdfCheckboxRowOption[]) {
    if (options.length === 0) {
      return
    }

    const fontSize = options[0]?.fontSize ?? 10
    const lineHeight = fontSize * lineHeightMultiplier
    const size = Math.max(fontSize + 2, 12)
    const startX = marginX + (options[0]?.indent ?? 0)
    const gap = 18

    if (this.y - lineHeight < marginBottom) {
      this.addPage()
    }

    const pageIndex = this.pages.length - 1
    const rowY = this.y
    const checkboxY = rowY + (lineHeight - size) / 2 + size - 2

    options.reduce((x, option) => {
      this.checkboxFields.push({
        checked: option.checked ?? false,
        fieldName: option.fieldName,
        pageIndex,
        size,
        x,
        y: checkboxY,
      })
      this.pages[pageIndex]?.push(getPdfTextCommand(option.label, 'F1', fontSize, x + size + 8, rowY))

      return x + size + 8 + getTextWidth(option.label, fontSize) + gap
    }, startX)

    this.y -= lineHeight + (options[0]?.gapAfter ?? 0)
  }

  addRadioRow(fieldName: string, selectedValue: string | null | undefined, options: PdfRadioRowOption[]) {
    if (options.length === 0) {
      return
    }

    const fontSize = options[0]?.fontSize ?? 10
    const lineHeight = fontSize * lineHeightMultiplier
    const size = Math.max(fontSize + 2, 12)
    const startX = marginX + (options[0]?.indent ?? 0)
    const gap = 18

    if (this.y - lineHeight < marginBottom) {
      this.addPage()
    }

    const pageIndex = this.pages.length - 1
    const rowY = this.y
    const radioY = rowY + (lineHeight - size) / 2 + size - 2
    const fields: PdfRadioField[] = []

    options.reduce((x, option) => {
      fields.push({pageIndex, size, value: option.value, x, y: radioY})
      this.pages[pageIndex]?.push(getPdfTextCommand(option.label, 'F1', fontSize, x + size + 8, rowY))

      return x + size + 8 + getTextWidth(option.label, fontSize) + gap
    }, startX)

    this.radioGroups.push({fieldName, fields, selectedValue: selectedValue ?? undefined})
    this.y -= lineHeight + (options[0]?.gapAfter ?? 0)
  }

  addTextField(options: PdfTextFieldOptions) {
    const fontSize = options.fontSize ?? 10
    const lineHeight = fontSize * lineHeightMultiplier
    const fieldHeight = Math.max(fontSize + 8, 18)
    const x = marginX + (options.indent ?? 0)
    const width = options.width ?? pageWidth - x - marginX

    if (options.hidden) {
      this.textFields.push({
        fieldName: options.fieldName,
        fontSize,
        hidden: true,
        pageIndex: this.pages.length - 1,
        value: options.value ?? '',
        width: 0,
        x: 0,
        y: 0,
      })
      return
    }

    if (this.y - lineHeight - fieldHeight < marginBottom) {
      this.addPage()
    }

    if (options.label) {
      this.addText(options.label, {font: 'bold', fontSize, gapAfter: 3, indent: options.indent})
    }

    const pageIndex = this.pages.length - 1
    const topY = this.y
    const bottomY = topY - fieldHeight
    this.pages[pageIndex]?.push(
      [
        'q',
        '1 1 1 rg',
        '0.45 0.52 0.60 RG',
        '1 w',
        `${x.toFixed(2)} ${bottomY.toFixed(2)} ${width.toFixed(2)} ${fieldHeight.toFixed(2)} re`,
        'B',
        'Q',
      ].join(' '),
    )
    this.textFields.push({
      fieldName: options.fieldName,
      fontSize,
      hidden: false,
      pageIndex,
      value: options.value ?? '',
      width,
      x,
      y: topY,
    })
    this.y = bottomY - (options.gapAfter ?? 8)
  }

  addGap(points: number) {
    this.y -= points

    if (this.y < marginBottom) {
      this.addPage()
    }
  }

  ensureSpace(points: number) {
    if (this.y - points < marginBottom) {
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

    this.addText(options.title, {font: 'bold', fontSize: 12, gapAfter: 10})
    renderContent()

    const endPageIndex = this.pages.length - 1
    const endY = this.y

    Array.from({length: endPageIndex - pageIndex + 1}).forEach((_, offset) => {
      const currentPageIndex = pageIndex + offset
      const isStartPage = currentPageIndex === pageIndex
      const isEndPage = currentPageIndex === endPageIndex
      const rectTopY = isStartPage ? topY : pageHeight - marginTop + panelPaddingTop
      const rectBottomY = isEndPage ? Math.max(endY - panelPaddingBottom, marginBottom) : marginBottom
      const rectHeight = rectTopY - rectBottomY
      const rectCommand = [
        'q',
        `${sectionFillColor} rg`,
        `${sectionStrokeColor} RG`,
        '1 w',
        `${(marginX - panelPaddingX).toFixed(2)} ${rectBottomY.toFixed(2)} ${(pageWidth - (marginX - panelPaddingX) * 2).toFixed(2)} ${rectHeight.toFixed(2)} re`,
        'B',
        'Q',
      ].join(' ')

      this.pages[currentPageIndex]?.splice(isStartPage ? startCommandIndex : 0, 0, rectCommand)
    })

    this.y = Math.max(endY - panelPaddingBottom, marginBottom) - (options.gapAfter ?? 10)
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
    const radioOnAppearanceId = addStreamObject(
      '/Type /XObject /Subtype /Form /BBox [0 0 12 12] /Resources << >>',
      'q 1 1 1 rg 0.45 0.52 0.60 RG 1 w 6 11.4 m 8.98 11.4 11.4 8.98 11.4 6 c 11.4 3.02 8.98 0.6 6 0.6 c 3.02 0.6 0.6 3.02 0.6 6 c 0.6 8.98 3.02 11.4 6 11.4 c B 0.12 0.33 0.60 rg 6 8.9 m 7.6 8.9 8.9 7.6 8.9 6 c 8.9 4.4 7.6 3.1 6 3.1 c 4.4 3.1 3.1 4.4 3.1 6 c 3.1 7.6 4.4 8.9 6 8.9 c f Q',
    )
    const radioOffAppearanceId = addStreamObject(
      '/Type /XObject /Subtype /Form /BBox [0 0 12 12] /Resources << >>',
      'q 1 1 1 rg 0.45 0.52 0.60 RG 1 w 6 11.4 m 8.98 11.4 11.4 8.98 11.4 6 c 11.4 3.02 8.98 0.6 6 0.6 c 3.02 0.6 0.6 3.02 0.6 6 c 0.6 8.98 3.02 11.4 6 11.4 c B Q',
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
    const radioWidgetIdsByPage = new Map<number, number[]>()
    const radioGroupIds = this.radioGroups.map((group) => {
      const parentFieldId = addObject('')
      const widgetIds = group.fields.map((field) => {
        const valueName = getPdfSafeName(field.value)
        const state = group.selectedValue === field.value ? `/${valueName}` : '/Off'
        const widgetId = addObject(
          [
            '<< /Type /Annot /Subtype /Widget',
            `/Parent ${parentFieldId} 0 R`,
            `/Rect [${field.x.toFixed(2)} ${(field.y - field.size).toFixed(2)} ${(field.x + field.size).toFixed(2)} ${field.y.toFixed(2)}]`,
            `/AS ${state} /F 4 /H /P`,
            '/MK << /BC [0.45 0.52 0.60] /BG [1 1 1] >>',
            '/BS << /W 1 /S /S >>',
            `/AP << /N << /${valueName} ${radioOnAppearanceId} 0 R /Off ${radioOffAppearanceId} 0 R >> >>`,
            '>>',
          ].join(' '),
        )

        radioWidgetIdsByPage.set(field.pageIndex, [...(radioWidgetIdsByPage.get(field.pageIndex) ?? []), widgetId])

        return widgetId
      })
      const selectedValue =
        group.selectedValue
        && group.fields.some((field) => {
          return field.value === group.selectedValue
        })
          ? `/${getPdfSafeName(group.selectedValue)}`
          : '/Off'

      objects[parentFieldId - 1] = getObject(
        [
          '<< /FT /Btn /Ff 49152',
          `/T (${getPdfSafeAsciiText(group.fieldName)})`,
          `/V ${selectedValue}`,
          `/Kids [${widgetIds
            .map((widgetId) => {
              return `${widgetId} 0 R`
            })
            .join(' ')}]`,
          '>>',
        ].join(' '),
      )

      return parentFieldId
    })
    const textFieldIds = this.textFields.map((field) => {
      const bottomY = field.y - Math.max(field.fontSize + 8, 18)
      const rect = field.hidden
        ? '[0.00 0.00 0.00 0.00]'
        : `[${field.x.toFixed(2)} ${bottomY.toFixed(2)} ${(field.x + field.width).toFixed(2)} ${field.y.toFixed(2)}]`
      const flags = field.hidden ? '2' : '4'

      return addObject(
        [
          '<< /Type /Annot /Subtype /Widget /FT /Tx',
          `/T (${getPdfSafeAsciiText(field.fieldName)})`,
          `/Rect ${rect}`,
          `/V (${getPdfSafeAsciiText(field.value)}) /DV (${getPdfSafeAsciiText(field.value)}) /F ${flags} /H /P`,
          `/DA (/F1 ${field.fontSize} Tf 0 0 0 rg)`,
          '/MK << /BC [0.45 0.52 0.60] /BG [1 1 1] >>',
          '/BS << /W 1 /S /S >>',
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
      const pageRadioWidgetIds = radioWidgetIdsByPage.get(index) ?? []
      const pageTextFieldIds = textFieldIds.filter((_, fieldIndex) => {
        const field = this.textFields[fieldIndex]
        return field?.pageIndex === index && !field.hidden
      })
      const pageAnnotationIds = [...pageCheckboxIds, ...pageRadioWidgetIds, ...pageTextFieldIds]
      const contentId = addStreamObject('', pageCommands.join('\n'))
      const pageId = addObject(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${regularFontId} 0 R /F2 ${boldFontId} 0 R /F3 ${cjkFontId} 0 R >> >> /Contents ${contentId} 0 R${
          pageAnnotationIds.length > 0
            ? ` /Annots [${pageAnnotationIds
                .map((annotationId) => {
                  return `${annotationId} 0 R`
                })
                .join(' ')}]`
            : ''
        } >>`,
      )

      pageIds.push(pageId)
    })

    objects[catalogId - 1] = getObject(
      `<< /Type /Catalog /Pages ${pagesId} 0 R${
        checkboxFieldIds.length > 0 || radioGroupIds.length > 0 || textFieldIds.length > 0
          ? ` /AcroForm << /Fields [${[...checkboxFieldIds, ...radioGroupIds, ...textFieldIds]
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
