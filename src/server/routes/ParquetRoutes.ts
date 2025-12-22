/**
 * Parquet Files Routes - Admin API for viewing Parquet file stats in S3
 */

import {Elysia} from 'elysia'

import {auth} from '../../auth'
import {getS3Client, getS3Config, listObjects} from '../../services/s3/s3Client'
import {requireAdminAuth} from '../utils/authGuard'
import {withErrorHandler} from '../utils/routeErrorHandler'

interface ParquetFileInfo {
  key: string
  year: string | null
  month: string | null
  filename: string
}

interface ParquetStats {
  totalFiles: number
  totalSizeBytes: number
  bucket: string
  endpoint: string
  files: ParquetFileInfo[]
  partitions: {year: string; month: string; count: number}[]
}

/**
 * Parse a Hive-partitioned path like "judgments/year=2024/month=12/file.parquet"
 */
const parseParquetPath = (key: string): ParquetFileInfo => {
  const yearMatch = key.match(/year=(\d{4})/)
  const monthMatch = key.match(/month=(\d{2})/)
  const filename = key.split('/').pop() ?? key

  return {key, year: yearMatch?.[1] ?? null, month: monthMatch?.[1] ?? null, filename}
}

export const parquetRoutes = new Elysia()
  .use(withErrorHandler())
  .use(requireAdminAuth())
  .get('/api/parquet/stats', async ({request, set}) => {
    const session = await auth.api.getSession({headers: request.headers})
    const role = session?.user?.role ?? null
    if (role !== 'admin') {
      set.status = 403
      return {data: null, error: 'Administrator access required'}
    }

    try {
      const s3Config = getS3Config()
      const client = getS3Client()

      // List all objects in the bucket with the judgments prefix
      const keys = await listObjects(s3Config.bucket, 'judgments/', client)

      // Parse file info
      const files = keys
        .filter((k) => {
          return k.endsWith('.parquet')
        })
        .map(parseParquetPath)

      // Group by partition
      const partitionMap = new Map<string, number>()
      for (const file of files) {
        if (file.year && file.month) {
          const key = `${file.year}-${file.month}`
          partitionMap.set(key, (partitionMap.get(key) ?? 0) + 1)
        }
      }

      const partitions = Array.from(partitionMap.entries())
        .map(([key, count]) => {
          const [year, month] = key.split('-')
          return {year: year ?? '', month: month ?? '', count}
        })
        .sort((a, b) => {
          const aKey = `${a.year}-${a.month}`
          const bKey = `${b.year}-${b.month}`
          return bKey.localeCompare(aKey) // Descending order
        })

      const stats: ParquetStats = {
        totalFiles: files.length,
        totalSizeBytes: 0, // S3 listObjects doesn't return size, would need HeadObject for each
        bucket: s3Config.bucket,
        endpoint: s3Config.endpoint,
        files: files.slice(0, 100), // Limit to first 100 files
        partitions,
      }

      return {data: stats}
    } catch (error) {
      console.error('Failed to get parquet stats:', error)
      set.status = 500
      return {data: null, error: error instanceof Error ? error.message : 'Failed to get parquet stats'}
    }
  })
