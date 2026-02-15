/** Metadata returned by a route's metaDataGenerator function. */
export interface ClaraMetadata {
  title: string;
  description?: string;
  openGraph?: {
    title?: string;
    description?: string;
  };
}

/**
 * Function that fetches data for a dynamic route and returns metadata.
 * Equivalent to Next.js `generateMetadata()` — runs in the renderer Lambda
 * with access to the data source.
 *
 * @param params - The route parameters, e.g. { id: '42' } for /product/:id
 * @returns Metadata for the page, or null if the page doesn't exist
 */
export type ClaraMetaDataGenerator = (params: Record<string, string>) => Promise<ClaraMetadata | null>;

/** A single route definition with its pattern and metadata generator. */
export interface ClaraRouteDefinition {
  /** Dynamic route pattern, e.g. '/product/:id' */
  route: string;
  /** Function that fetches metadata for this route from the data source */
  metaDataGenerator: ClaraMetaDataGenerator;
}

/**
 * The route file default export type: an array of route definitions.
 *
 * Example:
 * ```typescript
 * import type { ClaraRoutes } from 'clara';
 * const routes: ClaraRoutes = [
 *   {
 *     route: '/product/:id',
 *     metaDataGenerator: async (params) => {
 *       const product = await getProduct(params.id);
 *       if (!product) return null;
 *       return { title: product.name, description: product.description };
 *     },
 *   },
 * ];
 * export default routes;
 * ```
 */
export type ClaraRoutes = ClaraRouteDefinition[];

export interface ClaraRoute {
  /** Dynamic route pattern, e.g. '/product/:id' */
  pattern: string;
}

export interface ClaraPluginConfig {
  /**
   * Path to a file that defines dynamic routes and their metadata generators.
   * Each entry has a `route` pattern and a `metaDataGenerator` function.
   *
   * The file should `export default` a `ClaraRoutes` array.
   * Route patterns are extracted from the `route` properties automatically.
   *
   * Example: `'./clara.routes.ts'`
   */
  routeFile: string;
  provider: ClaraProvider;
}

export interface ClaraProvider {
  name: string;
  /** The serializable config passed to the provider factory (e.g. { region: 'eu-west-1' }) */
  config: Record<string, unknown>;
  setup(config: ClaraDeployConfig): Promise<ProviderResources>;
  deploy(config: ClaraDeployConfig, resources: ProviderResources): Promise<void>;
  exists(config: ClaraDeployConfig): Promise<ProviderResources | null>;
  teardown(resources: ProviderResources): Promise<void>;
}

export interface ProviderResources {
  provider: string;
  [key: string]: unknown;
}

/** Serialized config written to .clara/config.json by the build plugin. Read by `clara deploy`. */
export interface ClaraDeployConfig {
  routes: ClaraRoute[];
  provider: {
    name: string;
    [key: string]: unknown;
  };
  outputDir: string;
  /** Absolute path to the route file. Bundled into the renderer Lambda at deploy time. */
  routeFile: string;
}

export interface ClaraManifest {
  version: 1;
  routes: ManifestRoute[];
}

export interface ManifestRoute {
  pattern: string;
  paramNames: string[];
  regex: string;
}

export interface RouteMatch {
  route: ManifestRoute;
  params: Record<string, string>;
}
