import {mkdir, writeFile} from 'fs/promises'
import path from 'path'

import {resolveRuntimeWritablePath} from '../../../utils/runtimeWritablePath.ts'

/**
 * Store an uploaded PDF to the local assets folder.
 * Returns the relative path to the stored file, or null on failure.
 */
export const storeUploadedPdf = async (articleId: string, pdfBuffer: Buffer): Promise<string | null> => {
  const relDir = 'assets/user_uploaded_article_pdfs'
  const fileName = `${articleId}.pdf`
  const relPath = `${relDir}/${fileName}`
  const absDir = resolveRuntimeWritablePath({pathValue: relDir})
  const absPath = path.join(absDir, fileName)

  try {
    await mkdir(absDir, {recursive: true})
    await writeFile(absPath, pdfBuffer)
    return relPath
  } catch (error) {
    console.error('Failed to store uploaded PDF:', error)
    return null
  }
}
