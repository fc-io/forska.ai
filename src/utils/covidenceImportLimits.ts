export const covidenceImportMaxReferencesPerFile = 15_000

export type CovidenceImportPartSegment<TRecord> = {partIndex: number; records: TRecord[]}

export const getCovidenceImportPartCount = (
  recordCount: number,
  maxRecordsPerFile = covidenceImportMaxReferencesPerFile,
): number => {
  return Math.max(1, Math.ceil(recordCount / maxRecordsPerFile))
}

export const getCovidenceImportPartSegments = <TRecord>(
  records: readonly TRecord[],
  firstRecordIndex: number,
  maxRecordsPerFile = covidenceImportMaxReferencesPerFile,
): CovidenceImportPartSegment<TRecord>[] => {
  const segmentLength = maxRecordsPerFile - (firstRecordIndex % maxRecordsPerFile)

  return records.length === 0
    ? []
    : [
        {partIndex: Math.floor(firstRecordIndex / maxRecordsPerFile), records: records.slice(0, segmentLength)},
        ...getCovidenceImportPartSegments(
          records.slice(segmentLength),
          firstRecordIndex + segmentLength,
          maxRecordsPerFile,
        ),
      ]
}
