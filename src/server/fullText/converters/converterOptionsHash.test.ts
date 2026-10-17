import {expect, test} from 'bun:test'

import {getConverterOptionsHash} from './converterOptionsHash.ts'
import {doclingConvertOptions} from './doclingConverter.ts'
import {mineruConvertOptions} from './mineruConverter.ts'

test('converter options hash is the sha256 of the key-sorted options JSON', () => {
  expect(getConverterOptionsHash({a: [{c: 3, d: 2}], b: 1})).toBe(
    'aa0fff90b247460fff3592ff491ac879c69b05ee5efa14393d3154bd9199273f',
  )
  expect(getConverterOptionsHash({b: 1, a: [{d: 2, c: 3}]})).toBe(getConverterOptionsHash({a: [{c: 3, d: 2}], b: 1}))
})

test('converter options hash changes when any option value changes', () => {
  expect(getConverterOptionsHash({...mineruConvertOptions, tier: 'advanced'})).not.toBe(
    getConverterOptionsHash(mineruConvertOptions),
  )
  expect(getConverterOptionsHash({...doclingConvertOptions, image_export_mode: 'placeholder'})).not.toBe(
    getConverterOptionsHash(doclingConvertOptions),
  )
})

test('shipped converter options keep their frozen hashes', () => {
  expect(getConverterOptionsHash(mineruConvertOptions)).toBe(
    'e9d85ef6fe205701cea9cf7f29abcc18f3ba884041b2f392facf5262be7ffb96',
  )
  expect(getConverterOptionsHash(doclingConvertOptions)).toBe(
    '586cab5f8f4f27c9346faf409e31f8b6867e1af612c3bb824aacb5a9a6417bf0',
  )
})

test('shipped converter options are explicit about images, OCR, tables and pipeline', () => {
  expect(mineruConvertOptions).toEqual({
    ocr_mode: 'auto',
    output_formats: ['markdown', 'middle_json', 'zip'],
    page_range: '',
    tier: 'standard',
  })
  expect(doclingConvertOptions).toMatchObject({
    do_ocr: true,
    image_export_mode: 'referenced',
    include_images: true,
    pdf_backend: 'docling_parse',
    pipeline: 'standard',
    table_mode: 'accurate',
    to_formats: ['md', 'json', 'html'],
  })
})
