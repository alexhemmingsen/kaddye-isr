export interface KaddyeRoute {
  /** Dynamic route pattern, e.g. '/product/:id' */
  pattern: string;
}

export interface KaddyePluginConfig {
  routes: KaddyeRoute[];
  provider: KaddyeProvider;
}

export interface KaddyeProvider {
  name: string;
  setup(config: KaddyePluginConfig): Promise<ProviderResources>;
  deploy(config: KaddyePluginConfig, resources: ProviderResources, buildDir: string): Promise<void>;
  exists(config: KaddyePluginConfig): Promise<ProviderResources | null>;
  teardown(resources: ProviderResources): Promise<void>;
}

export interface ProviderResources {
  provider: string;
  [key: string]: unknown;
}

export interface KaddyeManifest {
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
