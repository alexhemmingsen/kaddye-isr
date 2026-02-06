# Kaddye - Implementation Plan

## What Kaddye Is

A Vite plugin + CLI that gives any React application:
1. Pre-rendered static HTML for known routes at build time (SEO works)
2. SPA fallback for client-side navigation (standard SPA behavior)
3. Incremental pre-rendering for new routes after deployment (SEO without rebuild)
4. One-command deployment to S3 + CloudFront

Framework-agnostic: works with any React app (React Router, TanStack Router, or no router at all).

## How It Works

### Build Time (Vite Plugin)
- Developer defines routes and data fetching in `kaddye.config.ts`
- At build time, Kaddye renders each route to static HTML using `ReactDOMServer.renderToString()`
- Outputs: static HTML files + the normal SPA bundle + an SSR bundle for Lambda

### Runtime (AWS Infrastructure)
- Static HTML files served from S3 via CloudFront (SEO works for known routes)
- SPA fallback served for unknown routes (client-side rendering)
- When a request hits a dynamic route that has no HTML file:
  - CloudFront Function detects the miss
  - Triggers a Lambda function
  - Lambda loads the SSR bundle, calls the route's data function, renders to HTML
  - Uploads the HTML to S3
  - Returns the HTML to the requester
  - All subsequent requests get the static file from S3

## Architecture

```
kaddye/
├── packages/
│   ├── kaddye/                    # Main package (npm: kaddye)
│   │   ├── src/
│   │   │   ├── vite-plugin/       # Vite plugin for build-time pre-rendering
│   │   │   │   ├── index.ts       # Plugin entry point
│   │   │   │   ├── prerender.ts   # HTML generation logic
│   │   │   │   └── ssr-bundle.ts  # SSR bundle generation
│   │   │   ├── cli/               # CLI for deploy + infrastructure
│   │   │   │   ├── index.ts       # CLI entry point
│   │   │   │   ├── deploy.ts      # S3 sync + CloudFront invalidation
│   │   │   │   └── setup.ts       # AWS infrastructure provisioning
│   │   │   ├── aws/               # AWS adapter
│   │   │   │   ├── lambda/        # Lambda function for incremental rendering
│   │   │   │   │   └── handler.ts # Lambda handler
│   │   │   │   ├── cloudfront/    # CloudFront Function code
│   │   │   │   │   └── router.js  # Request routing logic
│   │   │   │   └── cdk/           # CDK construct for infrastructure
│   │   │   │       └── stack.ts   # S3 + CloudFront + Lambda stack
│   │   │   ├── runtime/           # Client-side runtime
│   │   │   │   └── hydrate.ts     # Hydration helper
│   │   │   └── config.ts          # Config types and validation
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── create-kaddye/             # npx create-kaddye scaffolding
│       ├── src/
│       │   └── index.ts
│       ├── templates/
│       │   └── default/           # Starter template
│       └── package.json
├── examples/
│   └── food-store/                # Example app (your use case)
├── package.json                   # Workspace root
└── tsconfig.json
```

## Developer Experience

### 1. Config File

```typescript
// kaddye.config.ts
import { defineConfig } from 'kaddye';

export default defineConfig({
  // The React component that wraps the entire app (provides <html>, <head>, etc.)
  shell: './src/Shell.tsx',

  routes: [
    {
      path: '/',
      component: './src/pages/Home.tsx',
      data: async () => {
        const res = await fetch('https://api.example.com/featured');
        return res.json();
      },
    },
    {
      path: '/product/:id',
      component: './src/pages/Product.tsx',
      // Static params: these routes are pre-rendered at build time
      staticParams: async () => {
        const res = await fetch('https://api.example.com/products');
        const products = await res.json();
        return products.map((p) => ({ id: p.id }));
      },
      // Data function: used both at build time AND by Lambda for incremental rendering
      data: async (params) => {
        const res = await fetch(`https://api.example.com/products/${params.id}`);
        if (!res.ok) return null; // returning null = 404
        return res.json();
      },
    },
  ],

  // AWS configuration (used by CLI)
  aws: {
    region: 'eu-west-1',
    bucketName: 'my-food-store',
    distributionId: 'E1234567890', // optional, auto-detected after setup
  },
});
```

### 2. Shell Component

The developer provides a shell component that wraps everything. This is the HTML document:

```tsx
// src/Shell.tsx
import type { ShellProps } from 'kaddye';

export default function Shell({ children, head }: ShellProps) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {head}
      </head>
      <body>
        <div id="root">{children}</div>
      </body>
    </html>
  );
}
```

### 3. Page Components

Page components receive data as a prop:

```tsx
// src/pages/Product.tsx
import type { PageProps } from 'kaddye';

interface ProductData {
  id: string;
  name: string;
  price: number;
  description: string;
}

export function head(data: ProductData) {
  return (
    <>
      <title>{data.name} | My Food Store</title>
      <meta name="description" content={data.description} />
    </>
  );
}

export default function Product({ data }: PageProps<ProductData>) {
  return (
    <div>
      <h1>{data.name}</h1>
      <p>{data.description}</p>
      <p>${data.price}</p>
    </div>
  );
}
```

### 4. Build & Deploy

```bash
# Development
npx vite dev

# Build (pre-renders known routes + generates SSR bundle)
npx vite build

# First time: provision AWS infrastructure
npx kaddye setup

# Deploy to S3 + CloudFront
npx kaddye deploy
```

## Build Output

```
dist/
├── client/                     # → Uploaded to S3
│   ├── index.html              # Pre-rendered home page
│   ├── product/
│   │   ├── 1/
│   │   │   └── index.html      # Pre-rendered product 1
│   │   ├── 2/
│   │   │   └── index.html      # Pre-rendered product 2
│   │   └── 3/
│   │       └── index.html      # Pre-rendered product 3
│   ├── __spa-fallback.html     # SPA shell for client-only routes
│   └── assets/
│       ├── app-[hash].js       # SPA bundle
│       └── app-[hash].css      # Styles
├── server/                     # → Deployed to Lambda
│   └── render.js               # SSR bundle for incremental rendering
└── kaddye-manifest.json        # Route manifest for Lambda
```

## Implementation Steps

### Phase 1: Project Setup
1. Initialize monorepo with pnpm workspaces
2. Set up TypeScript configuration
3. Set up build tooling (tsup for library bundling)
4. Create package structure

### Phase 2: Config & Types
1. Define the `KaddyeConfig` type
2. Implement config file loading and validation
3. Define `ShellProps`, `PageProps`, and `HeadFunction` types
4. Implement route matching logic

### Phase 3: Vite Plugin - Pre-rendering
1. Create the Vite plugin that hooks into the build process
2. After Vite's client build completes, load each route's component and data function
3. Render each known route to static HTML using `renderToString`
4. Write HTML files to the output directory
5. Generate the SPA fallback HTML

### Phase 4: Vite Plugin - SSR Bundle
1. Run a second Vite build pass to create the SSR bundle
2. The SSR bundle contains: all page components, all data functions, the shell, and a render function
3. This bundle is what Lambda loads to render new pages

### Phase 5: CLI - AWS Setup
1. Implement `kaddye setup` command
2. Use AWS CDK (or raw CloudFormation) to provision:
   - S3 bucket
   - CloudFront distribution with OAC
   - CloudFront Function for routing
   - Lambda function for incremental rendering
   - Lambda@Edge or CloudFront Function to trigger Lambda on cache miss
   - IAM roles and policies
3. Store infrastructure IDs in a local config file

### Phase 6: CLI - Deploy
1. Implement `kaddye deploy` command
2. Sync `dist/client/` to S3
3. Deploy `dist/server/` to Lambda
4. Invalidate CloudFront cache for changed paths

### Phase 7: Lambda Handler
1. Implement the Lambda function that:
   - Receives a request path from CloudFront
   - Loads the SSR bundle
   - Matches the path against route definitions
   - Calls the data function for that route
   - Renders the component to HTML
   - Uploads the HTML to S3
   - Returns the HTML as the response
2. Handle 404s (data function returns null)
3. Handle errors gracefully

### Phase 8: CloudFront Function
1. Implement the CloudFront Function that:
   - For known static files (assets, existing HTML): pass through to S3
   - For unknown routes matching dynamic patterns: trigger Lambda origin
   - For other unknown routes: serve SPA fallback

### Phase 9: Client-Side Hydration
1. Implement a lightweight hydration helper
2. On page load, hydrate the pre-rendered HTML so it becomes interactive
3. After hydration, client-side routing takes over (developer's router of choice)

### Phase 10: Testing & Example App
1. Build the food-store example app using Kaddye
2. Write unit tests for config parsing, route matching, HTML generation
3. Write integration tests for the full build pipeline
4. Test the Lambda handler locally
5. End-to-end test with actual AWS deployment

## Key Design Decisions

### Why a config file instead of file-based routing?
- Framework-agnostic: doesn't impose a file structure
- Explicit: developer knows exactly what routes exist and how they're rendered
- Flexible: data functions can call any API, database, or CMS
- The developer can use any router they want for client-side navigation

### Why CDK for infrastructure?
- Declarative: the infrastructure is code, versioned, reproducible
- Standard: CDK is the AWS-recommended tool for infrastructure
- One command: `kaddye setup` provisions everything
- Alternative: Could use raw CloudFormation templates to avoid the CDK dependency

### Why a separate SSR bundle?
- Lambda needs to render React components without the full client build
- The SSR bundle excludes browser-only code (event handlers, effects, etc.)
- It includes only what's needed: components, data functions, shell
- Keeps Lambda cold start fast by minimizing bundle size

### How does hydration work with any router?
- Kaddye handles the initial HTML rendering and hydration of the page component
- After hydration, the developer's router (React Router, TanStack, etc.) takes over
- Client-side navigation is handled entirely by the developer's router
- Kaddye doesn't interfere with client-side routing at all

### What about data updates (not new routes)?
- If product 1's price changes, the existing HTML on S3 is stale
- Options for the developer:
  a. Re-run `kaddye deploy` (rebuilds all known routes)
  b. Set a TTL on CloudFront for dynamic routes (e.g. 1 hour)
  c. Call `kaddye invalidate /product/1` to delete the cached HTML + invalidate CloudFront
- This is a v2 concern; MVP focuses on new route creation

## Open Questions (to resolve during implementation)

1. Should the config support defining which routes are "incrementally renderable" vs static-only?
2. How to handle authentication/cookies in data functions running in Lambda?
3. Should we support multiple AWS accounts/environments (staging, production)?
4. What's the cold start impact of loading the SSR bundle in Lambda?
5. Should we use Lambda@Edge or a standard Lambda behind CloudFront?
