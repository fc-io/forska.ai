export const csvUtf8Bom = '\uFEFF'
export const csvContentType = 'text/csv; charset=utf-8'

export const getCsvDownloadHeaders = (filename: string) => {
  return {'Content-Disposition': `attachment; filename="${filename}"`, 'Content-Type': csvContentType}
}
