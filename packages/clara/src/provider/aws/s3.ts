import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

/** Content-type map for common static file types */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
};

function getContentType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

function getCacheControl(key: string): string {
  // Hashed assets (e.g. _next/static/) — cache forever
  if (key.includes('_next/static/') || key.includes('.chunk.')) {
    return 'public, max-age=31536000, immutable';
  }
  // HTML files — always revalidate
  if (key.endsWith('.html')) {
    return 'public, max-age=0, must-revalidate';
  }
  // Everything else — 1 day
  return 'public, max-age=86400';
}

export function createS3Client(region: string): S3Client {
  return new S3Client({ region });
}

/**
 * Recursively list all files in a directory.
 */
function listFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir);

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...listFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Upload all files from a build directory to S3.
 */
export async function syncToS3(
  client: S3Client,
  bucketName: string,
  buildDir: string
): Promise<number> {
  const files = listFiles(buildDir);
  let uploaded = 0;

  // Upload in batches of 10 for reasonable concurrency
  const batchSize = 10;
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (filePath) => {
        const key = relative(buildDir, filePath);
        const body = readFileSync(filePath);
        const contentType = getContentType(filePath);
        const cacheControl = getCacheControl(key);

        await client.send(
          new PutObjectCommand({
            Bucket: bucketName,
            Key: key,
            Body: body,
            ContentType: contentType,
            CacheControl: cacheControl,
          })
        );
        uploaded++;
      })
    );
  }

  return uploaded;
}

/**
 * Get an object from S3.
 */
export async function getObject(
  client: S3Client,
  bucketName: string,
  key: string
): Promise<{ body: string; contentType: string } | null> {
  try {
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucketName, Key: key })
    );
    const body = await response.Body?.transformToString('utf-8');
    if (!body) return null;
    return {
      body,
      contentType: response.ContentType || 'application/octet-stream',
    };
  } catch {
    return null;
  }
}

/**
 * Put an object to S3.
 */
export async function putObject(
  client: S3Client,
  bucketName: string,
  key: string,
  body: string,
  contentType: string,
  cacheControl?: string
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: cacheControl || 'public, max-age=0, must-revalidate',
    })
  );
}

/**
 * Empty an S3 bucket (required before CloudFormation can delete it).
 */
export async function emptyBucket(
  client: S3Client,
  bucketName: string
): Promise<void> {
  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        ContinuationToken: continuationToken,
      })
    );

    if (response.Contents && response.Contents.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucketName,
          Delete: {
            Objects: response.Contents.map((obj) => ({ Key: obj.Key! })),
          },
        })
      );
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
}
