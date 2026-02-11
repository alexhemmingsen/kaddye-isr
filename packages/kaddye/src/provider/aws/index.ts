import type { KaddyeProvider, KaddyePluginConfig, ProviderResources } from '../../types.js';

export interface AwsConfig {
  region: string;
  bucketName?: string;
}

export interface AwsResources extends ProviderResources {
  provider: 'aws';
  region: string;
  bucketName: string;
  distributionId: string;
  edgeFunctionArn: string;
  rendererFunctionArn: string;
}

/**
 * AWS provider for Kaddye.
 *
 * Usage:
 * ```typescript
 * import { aws } from 'kaddye/aws';
 *
 * aws({ region: 'eu-west-1' })
 * ```
 */
export function aws(awsConfig: AwsConfig): KaddyeProvider {
  return {
    name: 'aws',

    async setup(_config: KaddyePluginConfig): Promise<AwsResources> {
      // TODO: Implement CloudFormation provisioning
      // - S3 bucket
      // - CloudFront distribution with OAC
      // - Lambda@Edge (us-east-1)
      // - Renderer Lambda + Chromium layer
      // - IAM roles
      throw new Error('[kaddye/aws] setup not yet implemented');
    },

    async deploy(
      _config: KaddyePluginConfig,
      _resources: ProviderResources,
      _buildDir: string
    ): Promise<void> {
      // TODO: Implement deployment
      // - Sync build dir to S3
      // - Bundle + deploy edge handler to Lambda@Edge
      // - Deploy renderer to Lambda
      // - Invalidate CloudFront
      console.log('[kaddye/aws] deploy not yet implemented — skipping');
    },

    async exists(_config: KaddyePluginConfig): Promise<AwsResources | null> {
      // TODO: Check if CloudFormation stack exists
      return null;
    },

    async teardown(_resources: ProviderResources): Promise<void> {
      // TODO: Delete CloudFormation stack
      throw new Error('[kaddye/aws] teardown not yet implemented');
    },
  };
}
