import {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStacksCommand,
  DescribeStackEventsCommand,
  DeleteStackCommand,
  ListStackResourcesCommand,
  waitUntilStackCreateComplete,
  waitUntilStackDeleteComplete,
} from '@aws-sdk/client-cloudformation';
import {
  LambdaClient,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  PublishVersionCommand,
  AddPermissionCommand,
  InvokeCommand,
  waitUntilFunctionUpdatedV2,
} from '@aws-sdk/client-lambda';
import {
  IAMClient,
  PutRolePolicyCommand,
} from '@aws-sdk/client-iam';
import {
  CloudFrontClient,
  GetDistributionConfigCommand,
  UpdateDistributionCommand,
  CreateInvalidationCommand,
  CreateCachePolicyCommand,
  ListCachePoliciesCommand,
} from '@aws-sdk/client-cloudfront';
import type {
  QlaraProvider,
  QlaraDeployConfig,
  ProviderResources
} from '../../types.js';
import { createS3Client, syncToS3, emptyBucket } from './s3.js';
import { buildTemplate } from './cloudformation.js';
import { bundleEdgeHandler, bundleRenderer } from './bundle.js';
import { STACK_NAME_PREFIX } from './constants.js';
import { generateFallbacks } from '../../fallback.js';

export interface AwsConfig {
  stackName?: string;
  bucketName?: string;

  /**
   * How long (in seconds) CloudFront should cache dynamically rendered pages.
   * This sets the `s-maxage` value on the Cache-Control header.
   *
   * - Browsers always revalidate with CloudFront (`max-age=0`)
   * - CloudFront serves from edge cache for this duration
   *
   * @default 3600 (1 hour)
   */
  cacheTtl?: number;

  // ── Bring your own infrastructure ──────────────────────────────
  // When all of these are provided, Qlara skips CloudFormation
  // and deploys directly to the existing resources.
  distributionId?: string;
  distributionDomain?: string;
  edgeFunctionArn?: string;
  rendererFunctionArn?: string;
}

export interface AwsResources extends ProviderResources {
  provider: 'aws';
  region: string;
  stackName: string;
  bucketName: string;
  distributionId: string;
  distributionDomain: string;
  edgeFunctionArn: string;
  rendererFunctionArn: string;
}

/**
 * Get CloudFormation stack outputs as a typed object.
 */
async function getStackOutputs(
  cfn: CloudFormationClient,
  stackName: string
): Promise<Record<string, string>> {
  const result = await cfn.send(
    new DescribeStacksCommand({ StackName: stackName })
  );

  const stack = result.Stacks?.[0];
  if (!stack || !stack.Outputs) {
    throw new Error(
      `[qlara/aws] Stack ${stackName} not found or has no outputs`
    );
  }

  const outputs: Record<string, string> = {};
  for (const output of stack.Outputs) {
    if (output.OutputKey && output.OutputValue) {
      outputs[output.OutputKey] = output.OutputValue;
    }
  }

  return outputs;
}

/**
 * Convert stack outputs to AwsResources.
 */
function outputsToResources(
  stackName: string,
  region: string,
  outputs: Record<string, string>
): AwsResources {
  return {
    provider: 'aws',
    region,
    stackName,
    bucketName: outputs.BucketName,
    distributionId: outputs.DistributionId,
    distributionDomain: outputs.DistributionDomain,
    edgeFunctionArn: outputs.EdgeFunctionArn,
    rendererFunctionArn: outputs.RendererFunctionArn
  };
}

/**
 * Managed CachingOptimized policy ID — we need to detect and replace this
 * because it has MinTTL=1 which prevents the edge handler's max-age=0 from working.
 */
const CACHING_OPTIMIZED_POLICY_ID = '658327ea-f89d-4fab-a63d-7e88639e58f6';
const QLARA_CACHE_POLICY_NAME = 'qlara-cache-policy';

/**
 * Ensure a Qlara-specific cache policy exists with MinTTL=0.
 * Returns the policy ID.
 */
async function ensureCachePolicy(cf: CloudFrontClient): Promise<string> {
  // Check if our custom policy already exists
  const listResult = await cf.send(
    new ListCachePoliciesCommand({ Type: 'custom' })
  );

  const existing = listResult.CachePolicyList?.Items?.find(
    (item) => item.CachePolicy?.CachePolicyConfig?.Name === QLARA_CACHE_POLICY_NAME
  );

  if (existing?.CachePolicy?.Id) {
    return existing.CachePolicy.Id;
  }

  // Create it
  const createResult = await cf.send(
    new CreateCachePolicyCommand({
      CachePolicyConfig: {
        Name: QLARA_CACHE_POLICY_NAME,
        Comment: 'Qlara cache policy — MinTTL=0, respects origin Cache-Control',
        MinTTL: 0,
        DefaultTTL: 86400,
        MaxTTL: 31536000,
        ParametersInCacheKeyAndForwardedToOrigin: {
          CookiesConfig: { CookieBehavior: 'none' },
          HeadersConfig: { HeaderBehavior: 'none' },
          QueryStringsConfig: { QueryStringBehavior: 'none' },
          EnableAcceptEncodingGzip: true,
          EnableAcceptEncodingBrotli: true,
        },
      },
    })
  );

  const policyId = createResult.CachePolicy?.Id;
  if (!policyId) {
    throw new Error('[qlara/aws] Failed to create cache policy');
  }

  return policyId;
}

/**
 * Update CloudFront distribution to use a new Lambda@Edge version.
 * Also ensures the cache policy has MinTTL=0 (replaces CachingOptimized if needed).
 */
async function updateCloudFrontEdgeVersion(
  cf: CloudFrontClient,
  distributionId: string,
  newVersionArn: string
): Promise<void> {
  // Get current distribution config
  const getResult = await cf.send(
    new GetDistributionConfigCommand({ Id: distributionId })
  );

  const config = getResult.DistributionConfig;
  const etag = getResult.ETag;

  if (!config || !etag) {
    throw new Error('[qlara/aws] Could not get distribution config');
  }

  // Update Lambda@Edge association in the default cache behavior
  const lambdaAssociations =
    config.DefaultCacheBehavior?.LambdaFunctionAssociations;

  if (lambdaAssociations?.Items) {
    for (const assoc of lambdaAssociations.Items) {
      if (assoc.EventType === 'origin-request' || assoc.EventType === 'origin-response') {
        assoc.LambdaFunctionARN = newVersionArn;
        assoc.EventType = 'origin-request'; // Ensure origin-request for caching
      }
    }
  }

  // Ensure the cache policy is correct (MinTTL=0, not CachingOptimized)
  const currentPolicyId = config.DefaultCacheBehavior?.CachePolicyId;
  if (currentPolicyId === CACHING_OPTIMIZED_POLICY_ID) {
    console.log('[qlara/aws] Replacing CachingOptimized with Qlara cache policy (MinTTL=0)...');
    const qlaraPolicyId = await ensureCachePolicy(cf);
    config.DefaultCacheBehavior!.CachePolicyId = qlaraPolicyId;
  }

  // Update the distribution
  await cf.send(
    new UpdateDistributionCommand({
      Id: distributionId,
      DistributionConfig: config,
      IfMatch: etag
    })
  );
}

/**
 * Check if all BYOI (bring your own infrastructure) fields are present.
 */
function isByoi(
  config: AwsConfig
): config is AwsConfig &
  Required<
    Pick<
      AwsConfig,
      | 'bucketName'
      | 'distributionId'
      | 'distributionDomain'
      | 'edgeFunctionArn'
      | 'rendererFunctionArn'
    >
  > {
  return !!(
    config.bucketName &&
    config.distributionId &&
    config.distributionDomain &&
    config.edgeFunctionArn &&
    config.rendererFunctionArn
  );
}

/**
 * Build AwsResources from BYOI config (no CloudFormation).
 */
function byoiResources(
  config: AwsConfig & { bucketName: string }
): AwsResources {
  return {
    provider: 'aws',
    region: 'us-east-1',
    stackName: '', // No stack — externally managed
    bucketName: config.bucketName,
    distributionId: config.distributionId!,
    distributionDomain: config.distributionDomain!,
    edgeFunctionArn: config.edgeFunctionArn!,
    rendererFunctionArn: config.rendererFunctionArn!
  };
}

/**
 * AWS provider for Qlara.
 *
 * All resources are deployed in us-east-1 (Lambda@Edge requirement).
 * CloudFront serves from edge locations globally regardless.
 *
 * Usage — Qlara manages everything:
 * ```typescript
 * aws()
 * ```
 *
 * Usage — bring your own infrastructure:
 * ```typescript
 * aws({
 *   bucketName: 'my-bucket',
 *   distributionId: 'E1234567890',
 *   distributionDomain: 'd111111abcdef.cloudfront.net',
 *   edgeFunctionArn: 'arn:aws:lambda:us-east-1:123456789:function:my-edge',
 *   rendererFunctionArn: 'arn:aws:lambda:us-east-1:123456789:function:my-renderer',
 * })
 * ```
 */
export function aws(awsConfig: AwsConfig = {}): QlaraProvider {
  // All resources live in us-east-1 because Lambda@Edge requires it
  // and everything is in a single CloudFormation stack.
  // CloudFront serves from edge locations globally regardless.
  const region = 'us-east-1';
  const byoi = isByoi(awsConfig);
  const cacheTtl = awsConfig.cacheTtl ?? 3600;

  const stackName = byoi ? '' : awsConfig.stackName || STACK_NAME_PREFIX;

  return {
    name: 'aws',
    config: { ...awsConfig },

    async setup(_config: QlaraDeployConfig): Promise<AwsResources> {
      // BYOI: no provisioning needed — return the pre-configured resources
      if (byoi) {
        console.log('[qlara/aws] Using existing infrastructure (BYOI mode)');
        return byoiResources(awsConfig as AwsConfig & { bucketName: string });
      }

      const template = buildTemplate({ stackName, region });
      const cfn = new CloudFormationClient({ region });

      // Check if stack already exists
      let stackExists = false;
      try {
        const existing = await cfn.send(
          new DescribeStacksCommand({ StackName: stackName })
        );
        const status = existing.Stacks?.[0]?.StackStatus;
        if (status === 'ROLLBACK_COMPLETE' || status === 'DELETE_FAILED') {
          console.log(
            `[qlara/aws] Found failed stack (${status}). Deleting before retry...`
          );
          await cfn.send(new DeleteStackCommand({ StackName: stackName }));
          await waitUntilStackDeleteComplete(
            { client: cfn, maxWaitTime: 300 },
            { StackName: stackName }
          );
          console.log('[qlara/aws] Old stack deleted');
        } else if (status) {
          stackExists = true;
        }
      } catch {
        // Stack doesn't exist — that's fine
      }

      if (stackExists) {
        console.log(`[qlara/aws] Stack ${stackName} already exists`);
      } else {
        console.log(`[qlara/aws] Creating CloudFormation stack: ${stackName}`);

        await cfn.send(
          new CreateStackCommand({
            StackName: stackName,
            TemplateBody: JSON.stringify(template),
            Capabilities: ['CAPABILITY_IAM'],
          })
        );

        console.log(
          '[qlara/aws] Waiting for stack creation (this may take a few minutes)...'
        );

        try {
          await waitUntilStackCreateComplete(
            { client: cfn, maxWaitTime: 600 },
            { StackName: stackName }
          );
        } catch {
          const events = await cfn.send(
            new DescribeStackEventsCommand({ StackName: stackName })
          );

          const failures = (events.StackEvents || [])
            .filter((e) => e.ResourceStatus?.includes('FAILED'))
            .map((e) => `  ${e.LogicalResourceId}: ${e.ResourceStatusReason}`)
            .slice(0, 5);

          if (failures.length) {
            console.error('[qlara/aws] Stack creation failed:');
            failures.forEach((f) => console.error(f));
          }
          throw new Error('CloudFormation stack creation failed');
        }

        console.log('[qlara/aws] Stack created successfully');
      }

      const outputs = await getStackOutputs(cfn, stackName);
      return outputsToResources(stackName, region, outputs);
    },

    async deploy(
      config: QlaraDeployConfig,
      resources: ProviderResources,
    ): Promise<void> {
      const res = resources as AwsResources;
      const buildDir = config.outputDir;

      // 0. Generate fallback pages for dynamic routes before uploading
      console.log('[qlara/aws] Generating fallback pages...');
      const fallbacks = generateFallbacks(buildDir, config.routes);
      console.log(`[qlara/aws] Generated ${fallbacks.length} fallback page(s)`);

      // 1. Sync build output to S3 (includes the generated fallback pages)
      console.log('[qlara/aws] Syncing build output to S3...');
      const s3 = createS3Client(res.region);
      const { uploaded, deleted } = await syncToS3(s3, res.bucketName, buildDir, cacheTtl);
      console.log(`[qlara/aws] Uploaded ${uploaded} files, deleted ${deleted} stale files`);

      // 2. Bundle and deploy edge handler
      console.log('[qlara/aws] Bundling edge handler...');
      const edgeZip = await bundleEdgeHandler({
        bucketName: res.bucketName,
        rendererArn: res.rendererFunctionArn,
        region: res.region,
        cacheTtl,
      });

      const lambda = new LambdaClient({ region: res.region });

      // Wait for the function to be ready (may still be updating from stack creation)
      console.log('[qlara/aws] Waiting for edge handler to be ready...');
      await waitUntilFunctionUpdatedV2(
        { client: lambda, maxWaitTime: 120 },
        { FunctionName: res.edgeFunctionArn }
      );

      // Ensure edge handler has adequate timeout and memory (more memory = more CPU)
      await lambda.send(
        new UpdateFunctionConfigurationCommand({
          FunctionName: res.edgeFunctionArn,
          Timeout: 30,
          MemorySize: 512,
        })
      );

      await waitUntilFunctionUpdatedV2(
        { client: lambda, maxWaitTime: 120 },
        { FunctionName: res.edgeFunctionArn }
      );

      console.log('[qlara/aws] Deploying edge handler...');
      await lambda.send(
        new UpdateFunctionCodeCommand({
          FunctionName: res.edgeFunctionArn,
          ZipFile: edgeZip
        })
      );

      // Wait for the update to complete before publishing a version
      await waitUntilFunctionUpdatedV2(
        { client: lambda, maxWaitTime: 120 },
        { FunctionName: res.edgeFunctionArn }
      );

      // 3. Publish new version (Lambda@Edge requires published versions)
      const versionResult = await lambda.send(
        new PublishVersionCommand({
          FunctionName: res.edgeFunctionArn
        })
      );

      const newVersionArn = versionResult.FunctionArn;
      if (!newVersionArn) {
        throw new Error(
          '[qlara/aws] Failed to publish new edge handler version'
        );
      }

      console.log(
        `[qlara/aws] Published edge handler version: ${newVersionArn}`
      );

      // 3b. Add permission for CloudFront/Lambda@Edge to invoke this version
      try {
        await lambda.send(
          new AddPermissionCommand({
            FunctionName: res.edgeFunctionArn,
            Qualifier: versionResult.Version,
            StatementId: `CloudFrontInvoke-${versionResult.Version}`,
            Action: 'lambda:GetFunction',
            Principal: 'edgelambda.amazonaws.com',
          })
        );
      } catch (err) {
        // Permission may already exist from a previous deploy
        if (!(err as Error).message?.includes('already exists')) {
          throw err;
        }
      }

      try {
        await lambda.send(
          new AddPermissionCommand({
            FunctionName: res.edgeFunctionArn,
            Qualifier: versionResult.Version,
            StatementId: `ReplicatorInvoke-${versionResult.Version}`,
            Action: 'lambda:GetFunction',
            Principal: 'replicator.lambda.amazonaws.com',
          })
        );
      } catch (err) {
        if (!(err as Error).message?.includes('already exists')) {
          throw err;
        }
      }

      // 4. Update CloudFront to use the new edge handler version
      console.log('[qlara/aws] Updating CloudFront distribution...');
      const cf = new CloudFrontClient({ region: res.region });
      await updateCloudFrontEdgeVersion(cf, res.distributionId, newVersionArn);

      // 5. Bundle and deploy renderer
      //    The renderer is a simple Node.js Lambda that calls the developer's
      //    metadata generators to fetch metadata, then patches the fallback HTML.
      //    No Chromium or Puppeteer — just S3 reads, data source calls, and S3 writes.
      console.log('[qlara/aws] Bundling renderer...');
      const rendererZip = await bundleRenderer(config.routeFile, cacheTtl);

      // Wait for renderer to be ready
      await waitUntilFunctionUpdatedV2(
        { client: lambda, maxWaitTime: 120 },
        { FunctionName: res.rendererFunctionArn }
      );

      console.log('[qlara/aws] Deploying renderer...');
      await lambda.send(
        new UpdateFunctionCodeCommand({
          FunctionName: res.rendererFunctionArn,
          ZipFile: rendererZip,
        })
      );

      // Wait for code update before changing configuration
      await waitUntilFunctionUpdatedV2(
        { client: lambda, maxWaitTime: 120 },
        { FunctionName: res.rendererFunctionArn }
      );

      // 5b. Configure renderer — 512MB for faster CPU (no Chromium needed)
      console.log('[qlara/aws] Configuring renderer...');
      await lambda.send(
        new UpdateFunctionConfigurationCommand({
          FunctionName: res.rendererFunctionArn,
          Layers: [],
          MemorySize: 512,
          Timeout: 30,
          Environment: {
            Variables: config.env ?? {},
          },
        })
      );

      await waitUntilFunctionUpdatedV2(
        { client: lambda, maxWaitTime: 120 },
        { FunctionName: res.rendererFunctionArn }
      );

      // 5c. Ensure renderer has full S3 permissions (read fallback + write rendered pages)
      console.log('[qlara/aws] Ensuring renderer permissions...');
      try {
        const cfn = new CloudFormationClient({ region: res.region });
        const stackResources = await cfn.send(
          new ListStackResourcesCommand({ StackName: res.stackName })
        );

        const rendererRole = stackResources.StackResourceSummaries?.find(
          (r) => r.LogicalResourceId === 'RendererRole'
        );
        const contentBucket = stackResources.StackResourceSummaries?.find(
          (r) => r.LogicalResourceId === 'ContentBucket'
        );

        if (rendererRole?.PhysicalResourceId && contentBucket?.PhysicalResourceId) {
          const iam = new IAMClient({ region: res.region });
          const bucketArn = `arn:aws:s3:::${contentBucket.PhysicalResourceId}`;

          await iam.send(
            new PutRolePolicyCommand({
              RoleName: rendererRole.PhysicalResourceId,
              PolicyName: 'QlaraRendererS3Policy',
              PolicyDocument: JSON.stringify({
                Version: '2012-10-17',
                Statement: [
                  {
                    Effect: 'Allow',
                    Action: ['s3:GetObject', 's3:PutObject'],
                    Resource: `${bucketArn}/*`,
                  },
                  {
                    Effect: 'Allow',
                    Action: ['s3:ListBucket'],
                    Resource: bucketArn,
                  },
                ],
              }),
            })
          );
          console.log('[qlara/aws] Renderer S3 permissions applied');
        }
      } catch (err) {
        console.warn(
          `[qlara/aws] Could not update renderer permissions: ${(err as Error).message}`
        );
      }

      // 6. Warm up the renderer to eliminate cold start on first real request
      console.log('[qlara/aws] Warming up renderer...');
      try {
        await lambda.send(
          new InvokeCommand({
            FunctionName: res.rendererFunctionArn,
            InvocationType: 'RequestResponse',
            Payload: JSON.stringify({ warmup: true }),
          })
        );
        console.log('[qlara/aws] Renderer warmed up');
      } catch (err) {
        console.warn(
          `[qlara/aws] Renderer warm-up failed (non-critical): ${(err as Error).message}`
        );
      }

      // 7. Invalidate CloudFront cache
      console.log('[qlara/aws] Invalidating CloudFront cache...');
      await cf.send(
        new CreateInvalidationCommand({
          DistributionId: res.distributionId,
          InvalidationBatch: {
            CallerReference: `qlara-${Date.now()}`,
            Paths: {
              Quantity: 1,
              Items: ['/*']
            }
          }
        })
      );

      console.log('[qlara/aws] Deploy complete!');
      console.log(
        `[qlara/aws] Site available at: https://${res.distributionDomain}`
      );
    },

    async exists(_config: QlaraDeployConfig): Promise<AwsResources | null> {
      // BYOI: infrastructure always "exists"
      if (byoi) {
        return byoiResources(awsConfig as AwsConfig & { bucketName: string });
      }

      try {
        const cfn = new CloudFormationClient({ region });
        const outputs = await getStackOutputs(cfn, stackName);
        return outputsToResources(stackName, region, outputs);
      } catch {
        return null;
      }
    },

    async teardown(resources: ProviderResources): Promise<void> {
      const res = resources as AwsResources;

      // BYOI: refuse to tear down externally-managed infrastructure
      if (byoi) {
        console.log(
          '[qlara/aws] Infrastructure is externally managed (BYOI mode).'
        );
        console.log(
          '[qlara/aws] Skipping teardown — delete these resources manually.'
        );
        return;
      }

      // Empty the bucket first (CloudFormation can't delete non-empty buckets)
      console.log('[qlara/aws] Emptying S3 bucket...');
      const s3 = createS3Client(res.region);
      await emptyBucket(s3, res.bucketName);

      // Delete the CloudFormation stack
      console.log('[qlara/aws] Deleting CloudFormation stack...');
      const cfn = new CloudFormationClient({ region: res.region });

      await cfn.send(new DeleteStackCommand({ StackName: res.stackName }));

      console.log(
        '[qlara/aws] Waiting for stack deletion (this may take a few minutes)...'
      );

      await waitUntilStackDeleteComplete(
        { client: cfn, maxWaitTime: 600 },
        { StackName: res.stackName }
      );

      console.log('[qlara/aws] Infrastructure deleted');
    }
  };
}
