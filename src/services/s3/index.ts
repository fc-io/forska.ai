/**
 * S3 service module - exports for S3 client and utilities.
 */

export {
  // Utility functions
  bucketExists,
  CreateBucketCommand,
  // Client
  createS3Client,
  deleteFromS3,
  DeleteObjectCommand,
  downloadFromS3,
  ensureBucket,
  GetObjectCommand,
  getS3Client,
  // Config
  getS3Config,
  HeadBucketCommand,
  listObjects,
  ListObjectsV2Command,
  PutObjectCommand,
  // Re-export AWS SDK types for advanced usage
  S3Client,
  type S3Config,
  uploadToS3,
} from './s3Client'
