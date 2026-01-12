/**
 * S3 Client for SeaweedFS (local dev) / Ceph RGW (production)
 *
 * Environment variables:
 * - S3_ENDPOINT: S3-compatible endpoint URL (e.g., http://localhost:8333)
 * - S3_ACCESS_KEY: Access key for authentication
 * - S3_SECRET_KEY: Secret key for authentication
 * - S3_BUCKET: Default bucket name for Parquet files
 * - S3_REGION: Optional region (defaults to 'us-east-1' for compatibility)
 */

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type PutObjectCommandInput,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'

/**
 * S3 configuration loaded from environment variables.
 */
export interface S3Config {
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  region: string
}

/**
 * Get S3 configuration from environment variables.
 * Throws if required variables are missing.
 */
export const getS3Config = (): S3Config => {
  const endpoint = process.env.S3_ENDPOINT
  const accessKeyId = process.env.S3_ACCESS_KEY
  const secretAccessKey = process.env.S3_SECRET_KEY
  const bucket = process.env.S3_BUCKET
  const region = process.env.S3_REGION || 'us-east-1'

  if (!endpoint) {
    throw new Error('S3_ENDPOINT environment variable is required')
  }
  if (!accessKeyId) {
    throw new Error('S3_ACCESS_KEY environment variable is required')
  }
  if (!secretAccessKey) {
    throw new Error('S3_SECRET_KEY environment variable is required')
  }
  if (!bucket) {
    throw new Error('S3_BUCKET environment variable is required')
  }

  return {endpoint, accessKeyId, secretAccessKey, bucket, region}
}

/**
 * Create an S3 client configured for SeaweedFS or Ceph RGW.
 */
export const createS3Client = (config?: Partial<S3Config>): S3Client => {
  const fullConfig = config ? {...getS3Config(), ...config} : getS3Config()

  const s3Config: S3ClientConfig = {
    endpoint: fullConfig.endpoint,
    region: fullConfig.region,
    credentials: {accessKeyId: fullConfig.accessKeyId, secretAccessKey: fullConfig.secretAccessKey},
    // Required for S3-compatible services like SeaweedFS
    forcePathStyle: true,
  }

  return new S3Client(s3Config)
}

// Singleton client instance (lazy initialization)
let _s3Client: S3Client | null = null

/**
 * Get the singleton S3 client instance.
 * Creates the client on first access.
 */
export const getS3Client = (): S3Client => {
  if (!_s3Client) {
    _s3Client = createS3Client()
  }
  return _s3Client
}

/**
 * Check if a bucket exists.
 */
export const bucketExists = async (bucket: string, client?: S3Client): Promise<boolean> => {
  const s3 = client || getS3Client()
  try {
    await s3.send(new HeadBucketCommand({Bucket: bucket}))
    return true
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'NotFound') {
      return false
    }
    // For other errors (like 404 from seaweedfs), also return false
    if (error instanceof Error && 'statusCode' in error) {
      const statusCode = (error as {statusCode?: number}).statusCode
      if (statusCode === 404) {
        return false
      }
    }
    throw error
  }
}

/**
 * Ensure a bucket exists, creating it if necessary.
 */
export const ensureBucket = async (bucket: string, client?: S3Client): Promise<void> => {
  const s3 = client || getS3Client()
  const exists = await bucketExists(bucket, s3)
  if (!exists) {
    await s3.send(new CreateBucketCommand({Bucket: bucket}))
    console.log(`Created bucket: ${bucket}`)
  }
}

/**
 * Upload data to S3.
 */
export const uploadToS3 = async (
  bucket: string,
  key: string,
  body: Buffer | Uint8Array | string,
  contentType?: string,
  client?: S3Client,
): Promise<void> => {
  const s3 = client || getS3Client()
  const params: PutObjectCommandInput = {Bucket: bucket, Key: key, Body: body}
  if (contentType) {
    params.ContentType = contentType
  }
  await s3.send(new PutObjectCommand(params))
}

/**
 * List objects in a bucket with optional prefix.
 * Handles pagination automatically to retrieve all objects.
 */
export const listObjects = async (bucket: string, prefix?: string, client?: S3Client): Promise<string[]> => {
  const s3 = client || getS3Client()
  const keys: string[] = []
  let continuationToken: string | undefined

  do {
    const result = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    )

    if (result.Contents) {
      for (const obj of result.Contents) {
        if (obj.Key) {
          keys.push(obj.Key)
        }
      }
    }

    continuationToken = result.NextContinuationToken
  } while (continuationToken)

  return keys
}

/**
 * Download an object from S3.
 */
export const downloadFromS3 = async (bucket: string, key: string, client?: S3Client): Promise<Buffer> => {
  const s3 = client || getS3Client()
  const result = await s3.send(new GetObjectCommand({Bucket: bucket, Key: key}))
  // Convert stream to buffer
  const chunks: Uint8Array[] = []
  for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * Delete an object from S3.
 */
export const deleteFromS3 = async (bucket: string, key: string, client?: S3Client): Promise<void> => {
  const s3 = client || getS3Client()
  await s3.send(new DeleteObjectCommand({Bucket: bucket, Key: key}))
}

// Export types and commands for advanced usage
export {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
}
