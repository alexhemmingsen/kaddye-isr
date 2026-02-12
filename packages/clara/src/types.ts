export interface ClaraRoute {
  /** Dynamic route pattern, e.g. '/product/:id' */
  pattern: string;
}

export interface ClaraPluginConfig {
  routes: ClaraRoute[];
  provider: ClaraProvider;
}

export interface ClaraProvider {
  name: string;
  /** The serializable config passed to the provider factory (e.g. { region: 'eu-west-1' }) */
  config: Record<string, unknown>;
  setup(config: ClaraPluginConfig): Promise<ProviderResources>;
  deploy(config: ClaraPluginConfig, resources: ProviderResources, buildDir: string): Promise<void>;
  exists(config: ClaraPluginConfig): Promise<ProviderResources | null>;
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
