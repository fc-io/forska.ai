type PdfFont = 'regular' | 'bold'

type PdfTextOptions = {font?: PdfFont; fontSize?: number; gapAfter?: number; indent?: number}

const pageWidth = 595
const pageHeight = 842
const marginX = 48
const marginTop = 42
const marginBottom = 42
const lineHeightMultiplier = 1.25

const getPdfSafeText = (value: string) => {
  return value
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/[\\()]/g, (match) => {
      return `\\${match}`
    })
}

const getWrappedLines = (value: string, maxCharacters: number) => {
  const paragraphs = value.split(/\r\n|\n|\r/g)

  return paragraphs.flatMap((paragraph) => {
    const words = paragraph.trim().split(/\s+/).filter(Boolean)

    if (words.length === 0) {
      return ['']
    }

    return words.reduce<string[]>(
      (lines, word) => {
        const currentLine = lines[lines.length - 1] ?? ''
        const candidate = currentLine ? `${currentLine} ${word}` : word

        if (candidate.length <= maxCharacters) {
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
    const maxCharacters = Math.max(Math.floor(usableWidth / (fontSize * 0.5)), 20)
    const lines = getWrappedLines(text || ' ', maxCharacters)

    lines.forEach((line) => {
      if (this.y - lineHeight < marginBottom) {
        this.addPage()
      }

      const font = options.font === 'bold' ? 'F2' : 'F1'
      this.pages[this.pages.length - 1]?.push(
        `BT /${font} ${fontSize} Tf ${x.toFixed(2)} ${this.y.toFixed(2)} Td (${getPdfSafeText(line)}) Tj ET`,
      )
      this.y -= lineHeight
    })

    this.y -= options.gapAfter ?? 0
  }

  addGap(points: number) {
    this.y -= points

    if (this.y < marginBottom) {
      this.addPage()
    }
  }

  toBuffer() {
    const objects: Buffer[] = []
    const addObject = (body: string | Buffer) => {
      objects.push(getObject(body))
      return objects.length
    }

    const catalogId = addObject('')
    const pagesId = addObject('')
    const regularFontId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    const boldFontId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>')
    const pageIds: number[] = []

    this.pages.forEach((pageCommands, index) => {
      pageCommands.push(`BT /F1 8 Tf ${(pageWidth - marginX - 28).toFixed(2)} 24.00 Td (Page ${index + 1}) Tj ET`)
      const content = Buffer.from(pageCommands.join('\n'), 'utf8')
      const contentId = addObject(
        Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]),
      )
      const pageId = addObject(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${regularFontId} 0 R /F2 ${boldFontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      )

      pageIds.push(pageId)
    })

    objects[catalogId - 1] = getObject(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`)
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
