# Qlara

Runtime ISR for static React apps — dynamic routing and SEO metadata for statically exported Next.js apps on AWS CloudFront + Lambda.

## The Problem

When you use `output: 'export'` in Next.js, you get a fast, cheap static site — but you lose dynamic routes and per-page SEO metadata. Pages like `/product/42` don't exist at build time, so crawlers see nothing and users get 404s.

## How Qlara Solves It

Qlara sits between CloudFront and S3. When a visitor (or crawler) requests a page that doesn't exist yet:

1. **Lambda@Edge** intercepts the request, checks S3, and invokes a renderer if the page is missing
2. **Renderer Lambda** loads a fallback HTML template, calls your `generateMetadata()` function, and injects real `<title>`, `<meta>`, Open Graph, and Twitter tags
3. The rendered page is **saved to S3** and **cached by CloudFront** — subsequent requests are served at edge speed

No SSR runtime. No origin servers. Just static files generated on demand.

## Quick Start

### Install

```bash
npm install qlara
# or
pnpm add qlara
```

### 1. Define your routes

Create a `qlara.routes.ts` file:

```typescript
import type { QlaraRoutes } from 'qlara';

const routes: QlaraRoutes = [
  {
    route: '/product/:id',
    generateMetadata: async (params) => {
      const product = await fetchProduct(params.id);
      if (!product) return null;

      return {
        title: `${product.name} | My Store`,
        description: product.description,
        openGraph: {
          title: product.name,
          description: product.description,
          images: [{ url: product.imageUrl, alt: product.name }],
        },
      };
    },
  },
];

export default routes;
```

### 2. Configure Next.js

```typescript
// next.config.ts
import { withQlara } from 'qlara/next';
import { aws } from 'qlara/aws';

export default withQlara({
  routeFile: './qlara.routes.ts',
  provider: aws(),
  env: ['DATABASE_URL'], // env vars forwarded to the renderer Lambda
})({
  output: 'export',
});
```

### 3. Build and deploy

```bash
next build       # generates static export + .qlara/config.json
qlara deploy     # provisions AWS infrastructure and deploys
```

That's it. Your static site now handles dynamic routes with full SEO metadata.

## Route Patterns

Routes use `:param` syntax for dynamic segments. Multiple params and nested paths are supported:

```typescript
const routes: QlaraRoutes = [
  { route: '/product/:id', generateMetadata: /* ... */ },
  { route: '/blog/:slug', generateMetadata: /* ... */ },
  { route: '/:lang/products/:id', generateMetadata: /* ... */ },
];
```

### Validation

Reject invalid params early with `validate` — returns 404 without generating a page:

```typescript
{
  route: '/:lang/products/:id',
  validate: async (params) => {
    return ['en', 'da', 'de'].includes(params.lang);
  },
  generateMetadata: async (params) => { /* ... */ },
}
```

## Metadata

The `generateMetadata` function returns a `QlaraMetadata` object. Only `title` is required — everything else is optional:

```typescript
{
  title: 'Product Name | Store',
  description: 'A great product',
  keywords: ['shoes', 'running'],
  openGraph: {
    title: 'Product Name',
    description: 'A great product',
    images: [{ url: 'https://example.com/image.jpg' }],
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Product Name',
    images: ['https://example.com/image.jpg'],
  },
  robots: { index: true, follow: true },
  alternates: {
    canonical: 'https://example.com/product/42',
    languages: { 'da': '/da/product/42' },
  },
}
```

Return `null` from `generateMetadata` to serve a 404.

## AWS Provider Options

```typescript
import { aws } from 'qlara/aws';

// Managed mode — Qlara creates all infrastructure via CloudFormation
aws()
aws({ stackName: 'my-app-prod', cacheTtl: 7200 })

// BYOI (Bring Your Own Infrastructure) — use existing resources
aws({
  bucketName: 'my-bucket',
  distributionId: 'E1234567890',
  distributionDomain: 'd111111abcdef8.cloudfront.net',
  edgeFunctionArn: 'arn:aws:lambda:us-east-1:...',
  rendererFunctionArn: 'arn:aws:lambda:us-east-1:...',
})
```

| Option | Default | Description |
|--------|---------|-------------|
| `stackName` | auto-generated | CloudFormation stack name |
| `cacheTtl` | `3600` | CloudFront cache TTL in seconds |
| `bucketName` | — | S3 bucket (BYOI only) |
| `distributionId` | — | CloudFront distribution ID (BYOI only) |
| `distributionDomain` | — | CloudFront domain (BYOI only) |
| `edgeFunctionArn` | — | Lambda@Edge ARN (BYOI only) |
| `rendererFunctionArn` | — | Renderer Lambda ARN (BYOI only) |

## CLI

```bash
qlara deploy      # Set up infrastructure and deploy
qlara teardown    # Destroy all provisioned resources
```

## Architecture

```
                         CloudFront
                             |
                    CloudFront Function
                    (URL rewriting)
                             |
                      Lambda@Edge
                    (origin-request)
                       /         \
                 exists?        missing?
                   |               |
                  S3          Renderer Lambda
              (cached HTML)   (generate + upload)
                                   |
                                  S3
```

**What gets deployed (managed mode):**
- S3 bucket with Origin Access Control
- CloudFront distribution
- CloudFront Function for URL rewriting (`/product/42` -> `/product/42.html`)
- Lambda@Edge function (origin-request trigger)
- Renderer Lambda with IAM roles
- All managed via a single CloudFormation stack

## Requirements

- Node.js >= 18
- Next.js >= 14
- AWS credentials configured (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` or AWS CLI profile)

## License

MIT
