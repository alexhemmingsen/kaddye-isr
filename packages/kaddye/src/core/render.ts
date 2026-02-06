import { renderToString, renderToStaticMarkup } from 'react-dom/server';
import { createElement, Fragment, type ComponentType, type ReactNode } from 'react';
import type {
  KaddyeRoute,
  RouteParams,
  RenderedPage,
  ManifestRoute,
  KaddyeManifest,
} from './types';
import { resolveRoutePath } from './routes';

export interface RenderContext {
  /** The index.html template from the framework's build output */
  htmlTemplate: string;
  /** CSS selector for root element, defaults to '#root' */
  rootSelector: string;
  /** Base path (e.g. '/') */
  base: string;
}

export interface LoadedRoute {
  route: KaddyeRoute;
  PageComponent: ComponentType<{ data: unknown }>;
  headFn?: (data: unknown) => ReactNode;
}

export interface RenderResult {
  pages: RenderedPage[];
  manifest: KaddyeManifest;
}

export async function renderRoutes(
  loadedRoutes: LoadedRoute[],
  context: RenderContext,
): Promise<RenderResult> {
  const pages: RenderedPage[] = [];
  const manifestRoutes: ManifestRoute[] = [];

  for (const { route, PageComponent, headFn } of loadedRoutes) {
    const manifestEntry: ManifestRoute = {
      path: route.path,
      hasData: !!route.data,
      preRenderedPaths: [],
    };

    if (route.staticParams) {
      const paramSets = await route.staticParams();
      console.log(
        `[kaddye]   ${route.path} -> ${paramSets.length} static variants`,
      );

      for (const params of paramSets) {
        const concretePath = resolveRoutePath(route.path, params);
        const page = await renderSinglePage(
          route,
          params,
          concretePath,
          PageComponent,
          headFn,
          context,
        );
        if (page) {
          pages.push(page);
          manifestEntry.preRenderedPaths.push(concretePath);
        }
      }
    } else {
      console.log(
        `[kaddye]   ${route.path} -> skipped (no staticParams, will rely on ISR)`,
      );
    }

    manifestRoutes.push(manifestEntry);
  }

  const manifest: KaddyeManifest = {
    version: 1,
    routes: manifestRoutes,
    generatedAt: new Date().toISOString(),
  };

  return { pages, manifest };
}

async function renderSinglePage(
  route: KaddyeRoute,
  params: RouteParams,
  concretePath: string,
  PageComponent: ComponentType<{ data: unknown }>,
  headFn: ((data: unknown) => ReactNode) | undefined,
  context: RenderContext,
): Promise<RenderedPage | null> {
  let data: unknown = null;
  if (route.data) {
    data = await route.data(params);
    if (data === null) {
      console.warn(
        `[kaddye] Warning: data() returned null for ${concretePath}. Skipping (404).`,
      );
      return null;
    }
  }

  // Render page component
  const pageElement = createElement(PageComponent, { data });
  const pageHtml = renderToString(pageElement);

  // Render head elements
  let headHtml = '';
  if (headFn) {
    const headContent = headFn(data);
    if (headContent) {
      headHtml = renderToStaticMarkup(
        createElement(Fragment, null, headContent),
      );
    }
  }

  const html = injectIntoTemplate(
    context.htmlTemplate,
    pageHtml,
    headHtml,
    data,
    context.rootSelector,
  );

  return { path: concretePath, html };
}

function injectIntoTemplate(
  template: string,
  pageHtml: string,
  headHtml: string,
  data: unknown | null,
  rootSelector: string,
): string {
  let result = template;

  // Inject page content into the root element
  const rootId = rootSelector.startsWith('#') ? rootSelector.slice(1) : null;
  const rootClass = rootSelector.startsWith('.')
    ? rootSelector.slice(1)
    : null;

  if (rootId) {
    const rootRegex = new RegExp(
      `(<div[^>]*\\bid="${rootId}"[^>]*>)([\\s\\S]*?)(</div>)`,
    );
    result = result.replace(rootRegex, `$1${pageHtml}$3`);
  } else if (rootClass) {
    const rootRegex = new RegExp(
      `(<div[^>]*\\bclass="${rootClass}"[^>]*>)([\\s\\S]*?)(</div>)`,
    );
    result = result.replace(rootRegex, `$1${pageHtml}$3`);
  }

  // Inject head HTML before </head>
  // If head output contains <title>, replace the existing one
  if (headHtml) {
    const newTitleMatch = headHtml.match(/<title>[\s\S]*?<\/title>/);
    if (newTitleMatch) {
      // Remove existing title from template
      result = result.replace(/<title>[\s\S]*?<\/title>/, '');
    }
    result = result.replace('</head>', `${headHtml}\n</head>`);
  }

  // Inject data script before </body>
  if (data !== null && data !== undefined) {
    const serialized = JSON.stringify(data)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e');
    const dataScript = `<script>window.__KADDYE_DATA__ = ${serialized};</script>`;
    result = result.replace('</body>', `${dataScript}\n</body>`);
  }

  return result;
}
