import {expect, test} from 'bun:test'

import {SimplePdfDocument} from './simplePdf.ts'

test('simple PDF keeps Latin text in Helvetica when punctuation is non-ASCII', () => {
  const pdf = new SimplePdfDocument()
  pdf.addText('regarding drug related problems for patients in intensive care \u2013 medication-related')

  const output = pdf.toBuffer().toString('latin1')

  expect(output).toContain('/F1 10 Tf')
  expect(output).toContain('(regarding drug related problems')
  expect(output).not.toContain('/F3 10 Tf')
})

test('simple PDF normalizes escaped carriage-return entities before drawing text', () => {
  const pdf = new SimplePdfDocument()
  pdf.addText('Quotes: &#x0D; - District health facility located within Hanoi or Ca Mau Provinces&#x0D;')

  const output = pdf.toBuffer().toString('latin1')

  expect(output).not.toContain('&#x0D;')
  expect(output).toContain('(Quotes:)')
  expect(output).toContain('(- District health facility located within Hanoi or Ca Mau Provinces)')
})

test('simple PDF wraps mixed Chinese text inside indented containers', () => {
  const pdf = new SimplePdfDocument()
  const text = '抗菌药物使用率为73.6%,平均使用抗菌药物4.23 d; 依赖C-RP检测可有效减少抗菌药物使用率'

  pdf.addPanel({title: 'LLM assessment'}, () => {
    pdf.addText(`Quotes: ${text}${text}`, {indent: 80})
  })

  const output = pdf.toBuffer().toString('latin1')
  const cjkLineCount = output.match(/\/F3 10 Tf/g)?.length ?? 0

  expect(cjkLineCount).toBeGreaterThan(1)
  expect(output).toContain('(LLM assessment)')
  expect(output).toContain('0.96 0.98 1.00 rg')
})

test('simple PDF panel padding grows outward so panel title aligns with page text', () => {
  const pdf = new SimplePdfDocument()
  pdf.addPanel({title: 'Conflict resolution'}, () => {
    pdf.addText('Current resolution: Not set')
  })

  const output = pdf.toBuffer().toString('latin1')

  expect(output).toContain('32.00')
  expect(output).toContain('/F2 12 Tf 48.00')
  expect(output).toContain('/F1 10 Tf 48.00')
})

test('simple PDF keeps checkbox row widgets aligned with one text baseline', () => {
  const pdf = new SimplePdfDocument()
  pdf.addCheckboxRow([
    {fieldName: 'resolution.yes', label: 'yes'},
    {fieldName: 'resolution.no', label: 'no'},
    {fieldName: 'resolution.maybe', label: 'maybe'},
  ])

  const output = pdf.toBuffer().toString('latin1')

  expect(output).toContain('(yes)')
  expect(output).toContain('(no)')
  expect(output).toContain('(maybe)')
  expect(output).toContain('/T (resolution.yes)')
  expect(output).toContain('/T (resolution.no)')
  expect(output).toContain('/T (resolution.maybe)')
})

test('simple PDF creates grouped radio rows for single-choice fields', () => {
  const pdf = new SimplePdfDocument()
  pdf.addRadioRow('resolution', 'no', [
    {label: 'yes', value: 'yes'},
    {label: 'no', value: 'no'},
    {label: 'maybe', value: 'maybe'},
  ])

  const output = pdf.toBuffer().toString('latin1')

  expect(output).toContain('/T (resolution)')
  expect(output).toContain('/Ff 49152')
  expect(output).toContain('/V /no')
  expect(output).toContain('/Kids [')
  expect(output).toContain('/AS /no')
  expect(output).toContain('/AS /Off')
  expect(output).not.toContain('/T (resolution.yes)')
})

test('simple PDF continues panel layout across page breaks without resetting to the first page bottom', () => {
  const pdf = new SimplePdfDocument()
  pdf.addPanel({title: 'LLM assessment'}, () => {
    Array.from({length: 90}).forEach((_, index) => {
      pdf.addText(`Line ${index + 1}`)
    })
  })
  pdf.addText('After panel')

  const output = pdf.toBuffer().toString('latin1')

  expect(output).toContain('(Line 90)')
  expect(output).toContain('(After panel)')
  expect(output).toContain('Page 2')
})
