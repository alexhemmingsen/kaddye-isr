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
  CreateInvalidationCommand
} from '@aws-sdk/client-cloudfront';
import type {
  ClaraProvider,
  ClaraPluginConfig,
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

  // ── Bring your own infrastructure ──────────────────────────────
  // When all of these are provided, Clara skips CloudFormation
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
      `[clara/aws] Stack ${stackName} not found or has no outputs`
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
 * Update CloudFront distribution to use a new Lambda@Edge version.
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
    throw new Error('[clara/aws] Could not get distribution config');
  }

  // Update Lambda@Edge association in the default cache behavior
  const lambdaAssociations =
    config.DefaultCacheBehavior?.LambdaFunctionAssociations;

  if (lambdaAssociations?.Items) {
    for (const assoc of lambdaAssociations.Items) {
      if (assoc.EventType === 'origin-response') {
        assoc.LambdaFunctionARN = newVersionArn;
      }
    }
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
 * AWS provider for Clara.
 *
 * All resources are deployed in us-east-1 (Lambda@Edge requirement).
 * CloudFront serves from edge locations globally regardless.
 *
 * Usage — Clara manages everything:
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
export function aws(awsConfig: AwsConfig = {}): ClaraProvider {
  // All resources live in us-east-1 because Lambda@Edge requires it
  // and everything is in a single CloudFormation stack.
  // CloudFront serves from edge locations globally regardless.
  const region = 'us-east-1';
  const byoi = isByoi(awsConfig);

  const stackName = byoi ? '' : awsConfig.stackName || STACK_NAME_PREFIX;

  return {
    name: 'aws',
    config: { ...awsConfig },

    async setup(_config: ClaraPluginConfig): Promise<AwsResources> {
      // BYOI: no provisioning needed — return the pre-configured resources
      if (byoi) {
        console.log('[clara/aws] Using existing infrastructure (BYOI mode)');
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
            `[clara/aws] Found failed stack (${status}). Deleting before retry...`
          );
          await cfn.send(new DeleteStackCommand({ StackName: stackName }));
          await waitUntilStackDeleteComplete(
            { client: cfn, maxWaitTime: 300 },
            { StackName: stackName }
          );
          console.log('[clara/aws] Old stack deleted');
        } else if (status) {
          stackExists = true;
        }
      } catch {
        // Stack doesn't exist — that's fine
      }

      if (stackExists) {
        console.log(`[clara/aws] Stack ${stackName} already exists`);
      } else {
        console.log(`[clara/aws] Creating CloudFormation stack: ${stackName}`);

        await cfn.send(
          new CreateStackCommand({
            StackName: stackName,
            TemplateBody: JSON.stringify(template),
            Capabilities: ['CAPABILITY_IAM'],
          })
        );

        console.log(
          '[clara/aws] Waiting for stack creation (this may take a few minutes)...'
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
            console.error('[clara/aws] Stack creation failed:');
            failures.forEach((f) => console.error(f));
          }
          throw new Error('CloudFormation stack creation failed');
        }

        console.log('[clara/aws] Stack created successfully');
      }

      const outputs = await getStackOutputs(cfn, stackName);
      return outputsToResources(stackName, region, outputs);
    },

    async deploy(
      config: ClaraPluginConfig,
      resources: ProviderResources,
      buildDir: string
    ): Promise<void> {
      const res = resources as AwsResources;

      // 0. Generate fallback pages for dynamic routes before uploading
      console.log('[clara/aws] Generating fallback pages...');
      const fallbacks = generateFallbacks(buildDir, config.routes);
      console.log(`[clara/aws] Generated ${fallbacks.length} fallback page(s)`);

      // 1. Sync build output to S3 (includes the generated fallback pages)
      console.log('[clara/aws] Syncing build output to S3...');
      const s3 = createS3Client(res.region);
      const fileCount = await syncToS3(s3, res.bucketName, buildDir);
      console.log(`[clara/aws] Uploaded ${fileCount} files to S3`);

      // 2. Bundle and deploy edge handler
      console.log('[clara/aws] Bundling edge handler...');
      const edgeZip = await bundleEdgeHandler({
        bucketName: res.bucketName,
        rendererArn: res.rendererFunctionArn,
        region: res.region,
        distributionDomain: res.distributionDomain
      });

      const lambda = new LambdaClient({ region: res.region });

      // Wait for the function to be ready (may still be updating from stack creation)
      console.log('[clara/aws] Waiting for edge handler to be ready...');
      await waitUntilFunctionUpdatedV2(
        { client: lambda, maxWaitTime: 120 },
        { FunctionName: res.edgeFunctionArn }
      );

      // Ensure edge handler has adequate timeout (30s for origin-response)
      await lambda.send(
        new UpdateFunctionConfigurationCommand({
          FunctionName: res.edgeFunctionArn,
          Timeout: 30,
        })
      );

      await waitUntilFunctionUpdatedV2(
        { client: lambda, maxWaitTime: 120 },
        { FunctionName: res.edgeFunctionArn }
      );

      console.log('[clara/aws] Deploying edge handler...');
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
          '[clara/aws] Failed to publish new edge handler version'
        );
      }

      console.log(
        `[clara/aws] Published edge handler version: ${newVersionArn}`
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
      console.log('[clara/aws] Updating CloudFront distribution...');
      const cf = new CloudFrontClient({ region: res.region });
      await updateCloudFrontEdgeVersion(cf, res.distributionId, newVersionArn);

      // 5. Bundle and deploy renderer (includes @sparticuz/chromium in the ZIP)
      console.log('[clara/aws] Bundling renderer...');
      const rendererZip = await bundleRenderer();

      console.log('[clara/aws] Deploying renderer...');
      await lambda.send(
        new UpdateFunctionCodeCommand({
          FunctionName: res.rendererFunctionArn,
          ZipFile: rendererZip
        })
      );

      // Wait for code update before changing configuration
      await waitUntilFunctionUpdatedV2(
        { client: lambda, maxWaitTime: 120 },
        { FunctionName: res.rendererFunctionArn }
      );

      // 5b. Ensure renderer has adequate timeout/memory and no stale layers
      console.log('[clara/aws] Configuring renderer...');
      await lambda.send(
        new UpdateFunctionConfigurationCommand({
          FunctionName: res.rendererFunctionArn,
          Layers: [], // No layers needed — chromium is bundled in the ZIP
          MemorySize: 2048,
          Timeout: 60,
        })
      );

      await waitUntilFunctionUpdatedV2(
        { client: lambda, maxWaitTime: 120 },
        { FunctionName: res.rendererFunctionArn }
      );

      // 5c. Ensure renderer has full S3 permissions (read fallback + write rendered pages)
      console.log('[clara/aws] Ensuring renderer permissions...');
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
              PolicyName: 'ClaraRendererS3Policy',
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
          console.log('[clara/aws] Renderer S3 permissions applied');
        }
      } catch (err) {
        console.warn(
          `[clara/aws] Could not update renderer permissions: ${(err as Error).message}`
        );
      }

      // 6. Invalidate CloudFront cache
      console.log('[clara/aws] Invalidating CloudFront cache...');
      await cf.send(
        new CreateInvalidationCommand({
          DistributionId: res.distributionId,
          InvalidationBatch: {
            CallerReference: `clara-${Date.now()}`,
            Paths: {
              Quantity: 1,
              Items: ['/*']
            }
          }
        })
      );

      console.log('[clara/aws] Deploy complete!');
      console.log(
        `[clara/aws] Site available at: https://${res.distributionDomain}`
      );
    },

    async exists(_config: ClaraPluginConfig): Promise<AwsResources | null> {
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
          '[clara/aws] Infrastructure is externally managed (BYOI mode).'
        );
        console.log(
          '[clara/aws] Skipping teardown — delete these resources manually.'
        );
        return;
      }

      // Empty the bucket first (CloudFormation can't delete non-empty buckets)
      console.log('[clara/aws] Emptying S3 bucket...');
      const s3 = createS3Client(res.region);
      await emptyBucket(s3, res.bucketName);

      // Delete the CloudFormation stack
      console.log('[clara/aws] Deleting CloudFormation stack...');
      const cfn = new CloudFormationClient({ region: res.region });

      await cfn.send(new DeleteStackCommand({ StackName: res.stackName }));

      console.log(
        '[clara/aws] Waiting for stack deletion (this may take a few minutes)...'
      );

      await waitUntilStackDeleteComplete(
        { client: cfn, maxWaitTime: 600 },
        { StackName: res.stackName }
      );

      console.log('[clara/aws] Infrastructure deleted');
    }
  };
}
