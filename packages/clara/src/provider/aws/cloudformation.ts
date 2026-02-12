export interface CloudFormationConfig {
  stackName: string;
  region: string;
}

/**
 * Build a CloudFormation template for Clara's AWS infrastructure.
 *
 * Creates:
 * - S3 bucket (private, OAC access only)
 * - CloudFront distribution with OAC
 * - CloudFront Function for URL rewriting (/product/42 → /product/42.html)
 * - Lambda@Edge origin-response handler
 * - Renderer Lambda with Chromium layer
 * - IAM roles for both Lambdas
 */
export function buildTemplate(config: CloudFormationConfig): Record<string, unknown> {
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: `Clara ISR infrastructure — ${config.stackName}`,

    Resources: {
      // ── S3 Bucket ──────────────────────────────────────────────
      ContentBucket: {
        Type: 'AWS::S3::Bucket',
        Properties: {
          // No BucketName — let CloudFormation auto-generate a unique name
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true,
          },
        },
      },

      // ── S3 Bucket Policy (CloudFront OAC) ──────────────────────
      ContentBucketPolicy: {
        Type: 'AWS::S3::BucketPolicy',
        Properties: {
          Bucket: { Ref: 'ContentBucket' },
          PolicyDocument: {
            Statement: [
              {
                Effect: 'Allow',
                Principal: { Service: 'cloudfront.amazonaws.com' },
                Action: 's3:GetObject',
                Resource: { 'Fn::Sub': '${ContentBucket.Arn}/*' },
                Condition: {
                  StringEquals: {
                    'AWS:SourceArn': {
                      'Fn::Sub':
                        'arn:aws:cloudfront::${AWS::AccountId}:distribution/${Distribution}',
                    },
                  },
                },
              },
            ],
          },
        },
      },

      // ── CloudFront Origin Access Control ───────────────────────
      OriginAccessControl: {
        Type: 'AWS::CloudFront::OriginAccessControl',
        Properties: {
          OriginAccessControlConfig: {
            Name: { 'Fn::Sub': '${AWS::StackName}-oac' },
            OriginAccessControlOriginType: 's3',
            SigningBehavior: 'always',
            SigningProtocol: 'sigv4',
          },
        },
      },

      // ── CloudFront Function (URL rewriting) ────────────────────
      // Rewrites /product/42 → /product/42.html to match Next.js static export convention.
      // Rewrites /about/ → /about/index.html for directory-style paths.
      URLRewriteFunction: {
        Type: 'AWS::CloudFront::Function',
        Properties: {
          Name: { 'Fn::Sub': '${AWS::StackName}-url-rewrite' },
          AutoPublish: true,
          FunctionConfig: {
            Comment: 'Append .html or /index.html to directory-like paths',
            Runtime: 'cloudfront-js-2.0',
          },
          FunctionCode: [
            'function handler(event) {',
            '  var request = event.request;',
            '  var uri = request.uri;',
            '  if (uri === "/") {',
            '    request.uri = "/index.html";',
            '  } else if (uri.endsWith("/")) {',
            '    request.uri += "index.html";',
            '  } else if (!uri.includes(".")) {',
            '    request.uri += ".html";',
            '  }',
            '  return request;',
            '}',
          ].join('\n'),
        },
      },

      // ── IAM Role for Lambda@Edge ───────────────────────────────
      EdgeHandlerRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: {
                  Service: ['lambda.amazonaws.com', 'edgelambda.amazonaws.com'],
                },
                Action: 'sts:AssumeRole',
              },
            ],
          },
          ManagedPolicyArns: [
            'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
          ],
          Policies: [
            {
              PolicyName: 'ClaraEdgePolicy',
              PolicyDocument: {
                Statement: [
                  {
                    Effect: 'Allow',
                    Action: ['s3:GetObject'],
                    Resource: { 'Fn::Sub': '${ContentBucket.Arn}/*' },
                  },
                  {
                    Effect: 'Allow',
                    Action: ['lambda:InvokeFunction'],
                    Resource: { 'Fn::GetAtt': ['RendererFunction', 'Arn'] },
                  },
                ],
              },
            },
          ],
        },
      },

      // ── Lambda@Edge Function ───────────────────────────────────
      // Placeholder code — real handler is deployed via `clara deploy`
      EdgeHandlerFunction: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: { 'Fn::Sub': '${AWS::StackName}-edge-handler' },
          Runtime: 'nodejs20.x',
          Handler: 'edge-handler.handler',
          Role: { 'Fn::GetAtt': ['EdgeHandlerRole', 'Arn'] },
          Code: {
            ZipFile: 'exports.handler = async (event) => event.Records[0].cf.response;',
          },
          MemorySize: 128,
          Timeout: 30,
        },
      },

      // Lambda@Edge requires a published version for CloudFront association
      EdgeHandlerVersion: {
        Type: 'AWS::Lambda::Version',
        Properties: {
          FunctionName: { Ref: 'EdgeHandlerFunction' },
          Description: 'Initial placeholder version',
        },
      },

      // Permission for CloudFront/Lambda@Edge replication to invoke the function
      EdgeHandlerPermission: {
        Type: 'AWS::Lambda::Permission',
        Properties: {
          FunctionName: { Ref: 'EdgeHandlerFunction' },
          Action: 'lambda:GetFunction',
          Principal: 'edgelambda.amazonaws.com',
        },
      },

      EdgeHandlerReplicationPermission: {
        Type: 'AWS::Lambda::Permission',
        Properties: {
          FunctionName: { Ref: 'EdgeHandlerFunction' },
          Action: 'lambda:GetFunction',
          Principal: 'replicator.lambda.amazonaws.com',
        },
      },

      // ── IAM Role for Renderer Lambda ───────────────────────────
      RendererRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: { Service: 'lambda.amazonaws.com' },
                Action: 'sts:AssumeRole',
              },
            ],
          },
          ManagedPolicyArns: [
            'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
          ],
          Policies: [
            {
              PolicyName: 'ClaraRendererPolicy',
              PolicyDocument: {
                Statement: [
                  {
                    Effect: 'Allow',
                    Action: ['s3:PutObject'],
                    Resource: { 'Fn::Sub': '${ContentBucket.Arn}/*' },
                  },
                ],
              },
            },
          ],
        },
      },

      // ── Renderer Lambda ────────────────────────────────────────
      // Placeholder code — real handler is deployed via `clara deploy`
      RendererFunction: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: { 'Fn::Sub': '${AWS::StackName}-renderer' },
          Runtime: 'nodejs20.x',
          Handler: 'renderer.handler',
          Role: { 'Fn::GetAtt': ['RendererRole', 'Arn'] },
          Code: {
            ZipFile: 'exports.handler = async () => ({ statusCode: 200 });',
          },
          MemorySize: 2048,
          Timeout: 60,
          // distributionDomain is passed via invocation payload from the edge handler
        },
      },

      // ── CloudFront Distribution ────────────────────────────────
      Distribution: {
        Type: 'AWS::CloudFront::Distribution',
        Properties: {
          DistributionConfig: {
            Enabled: true,
            DefaultRootObject: 'index.html',
            HttpVersion: 'http2and3',
            Origins: [
              {
                Id: 's3-origin',
                DomainName: {
                  'Fn::GetAtt': ['ContentBucket', 'RegionalDomainName'],
                },
                S3OriginConfig: {
                  OriginAccessIdentity: '', // Empty when using OAC
                },
                OriginAccessControlId: { Ref: 'OriginAccessControl' },
              },
            ],
            DefaultCacheBehavior: {
              TargetOriginId: 's3-origin',
              ViewerProtocolPolicy: 'redirect-to-https',
              Compress: true,
              // Use CachingOptimized managed policy
              CachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6',
              LambdaFunctionAssociations: [
                {
                  EventType: 'origin-response',
                  LambdaFunctionARN: { Ref: 'EdgeHandlerVersion' },
                  IncludeBody: false,
                },
              ],
              FunctionAssociations: [
                {
                  EventType: 'viewer-request',
                  FunctionARN: {
                    'Fn::GetAtt': ['URLRewriteFunction', 'FunctionARN'],
                  },
                },
              ],
            },
            // No CustomErrorResponses — the edge handler manages 403/404
          },
        },
      },
    },

    Outputs: {
      BucketName: {
        Value: { Ref: 'ContentBucket' },
        Description: 'S3 bucket for static content',
      },
      DistributionId: {
        Value: { Ref: 'Distribution' },
        Description: 'CloudFront distribution ID',
      },
      DistributionDomain: {
        Value: { 'Fn::GetAtt': ['Distribution', 'DomainName'] },
        Description: 'CloudFront distribution domain name',
      },
      EdgeFunctionArn: {
        Value: { 'Fn::GetAtt': ['EdgeHandlerFunction', 'Arn'] },
        Description: 'Lambda@Edge function ARN',
      },
      RendererFunctionArn: {
        Value: { 'Fn::GetAtt': ['RendererFunction', 'Arn'] },
        Description: 'Renderer Lambda function ARN',
      },
    },
  };
}
