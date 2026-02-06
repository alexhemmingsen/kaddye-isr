import type { RouteParams } from './types';

export function isDynamicRoute(path: string): boolean {
  return path.includes(':');
}

export function extractParamNames(path: string): string[] {
  const matches = path.match(/:([^/]+)/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1));
}

export function resolveRoutePath(
  pattern: string,
  params: RouteParams,
): string {
  let resolved = pattern;
  for (const [key, value] of Object.entries(params)) {
    resolved = resolved.replace(`:${key}`, value);
  }
  return resolved;
}

export function createRouteMatcher(
  pattern: string,
): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const regexStr = pattern.replace(/:([^/]+)/g, (_match, paramName) => {
    paramNames.push(paramName);
    return '([^/]+)';
  });
  return {
    regex: new RegExp(`^${regexStr}$`),
    paramNames,
  };
}

export function matchRoute(
  pattern: string,
  concretePath: string,
): RouteParams | null {
  const { regex, paramNames } = createRouteMatcher(pattern);
  const match = concretePath.match(regex);
  if (!match) return null;
  const params: RouteParams = {};
  paramNames.forEach((name, i) => {
    params[name] = match[i + 1];
  });
  return params;
}
