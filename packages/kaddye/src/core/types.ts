import type { ReactNode } from 'react';

export interface PageProps<T = unknown> {
  data: T;
}

export type HeadFunction<T = unknown> = (data: T) => ReactNode;

export type RouteParams = Record<string, string>;

export interface KaddyeRoute {
  /** URL path pattern with dynamic segments, e.g. "/product/:id" */
  path: string;
  /** Path to the React component file, relative to project root */
  component: string;
  /** Async data fetcher. Return null to indicate 404. */
  data?: (params: RouteParams) => Promise<unknown | null>;
  /** Returns param sets to pre-render at build time */
  staticParams?: () => Promise<RouteParams[]>;
}

export interface AwsConfig {
  region: string;
  bucketName: string;
  distributionId?: string;
}

export interface KaddyeConfig {
  routes: KaddyeRoute[];
  /** CSS selector for the root element in index.html. Defaults to '#root'. */
  rootSelector?: string;
  aws?: AwsConfig;
}

export interface RenderedPage {
  path: string;
  html: string;
}

export interface ManifestRoute {
  path: string;
  hasData: boolean;
  preRenderedPaths: string[];
}

export interface KaddyeManifest {
  version: 1;
  routes: ManifestRoute[];
  generatedAt: string;
}
