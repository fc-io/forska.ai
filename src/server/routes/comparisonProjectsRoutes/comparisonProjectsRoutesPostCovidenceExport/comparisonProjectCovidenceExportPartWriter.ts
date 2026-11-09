import {strToU8, Zip, ZipDeflate} from 'fflate'

import {getComparisonProjectCovidenceExportPartFilename} from './comparisonProjectCovidenceExportFilename.ts'

export type ComparisonProjectCovidenceExportPlan = {filenameStem: string; maxRecordsPerFile: number; partCount: number}

export type ComparisonProjectCovidenceExportPartWriter = {
  close: () => void
  write: (partIndex: number, risText: string) => void
}

type ComparisonProjectCovidenceExportZipState = {
  entry: ZipDeflate | null
  partIndex: number
  plan: ComparisonProjectCovidenceExportPlan
  zip: Zip
}

const comparisonProjectCovidenceExportZipDeflateLevel = 6

export const getComparisonProjectCovidenceExportRisWriter = (
  controller: ReadableStreamDefaultController<string>,
): ComparisonProjectCovidenceExportPartWriter => {
  return {
    close: () => {
      controller.close()
    },
    write: (_partIndex, risText) => {
      controller.enqueue(risText)
    },
  }
}

const finishComparisonProjectCovidenceExportZipPart = (state: ComparisonProjectCovidenceExportZipState) => {
  state.entry?.push(new Uint8Array(0), true)
}

const startComparisonProjectCovidenceExportZipPart = (
  state: ComparisonProjectCovidenceExportZipState,
  partIndex: number,
) => {
  const entry = new ZipDeflate(
    getComparisonProjectCovidenceExportPartFilename(state.plan.filenameStem, partIndex, state.plan.partCount),
    {level: comparisonProjectCovidenceExportZipDeflateLevel},
  )

  finishComparisonProjectCovidenceExportZipPart(state)
  state.zip.add(entry)
  state.entry = entry
  state.partIndex = partIndex
  return entry
}

const getComparisonProjectCovidenceExportZipPart = (
  state: ComparisonProjectCovidenceExportZipState,
  partIndex: number,
) => {
  return state.entry !== null && state.partIndex === partIndex
    ? state.entry
    : startComparisonProjectCovidenceExportZipPart(state, partIndex)
}

const getComparisonProjectCovidenceExportZip = (controller: ReadableStreamDefaultController<Uint8Array>) => {
  return new Zip((error, data) => {
    if (error) {
      controller.error(error)
    } else {
      controller.enqueue(data)
    }
  })
}

export const getComparisonProjectCovidenceExportZipWriter = (
  controller: ReadableStreamDefaultController<Uint8Array>,
  plan: ComparisonProjectCovidenceExportPlan,
): ComparisonProjectCovidenceExportPartWriter => {
  const state: ComparisonProjectCovidenceExportZipState = {
    entry: null,
    partIndex: -1,
    plan,
    zip: getComparisonProjectCovidenceExportZip(controller),
  }

  return {
    close: () => {
      finishComparisonProjectCovidenceExportZipPart(state)
      state.zip.end()
      controller.close()
    },
    write: (partIndex, risText) => {
      getComparisonProjectCovidenceExportZipPart(state, partIndex).push(strToU8(risText))
    },
  }
}
