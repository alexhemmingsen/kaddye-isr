/**
 * Renderer Lambda for Qlara.
 *
 * This file is bundled into a self-contained ZIP and deployed as a standard Lambda.
 * It does NOT run in the developer's Node.js — it runs in AWS Lambda.
 *
 * The renderer:
 * 1. Reads the route's _fallback.html from S3
 * 2. Patches the __QLARA_FALLBACK__ placeholder with the actual param value
 * 3. Calls the developer's metaDataGenerator to fetch metadata from the data source
 * 4. Patches <title>, <meta> tags, and RSC flight data with real metadata
 * 5. Uploads the final SEO-complete HTML to S3 for future requests
 *
 * The route file is bundled by esbuild at deploy time. It exports an array of
 * route definitions, each with a pattern and a metaDataGenerator function.
 */

import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import type {
  QlaraMetadata,
  QlaraOpenGraph,
  QlaraOpenGraphBase,
  QlaraOGImage,
  QlaraOGImageDescriptor,
  QlaraOGAudio,
  QlaraOGAudioDescriptor,
  QlaraOGVideo,
  QlaraOGVideoDescriptor,
  QlaraTwitter,
  QlaraTwitterImage,
  QlaraTwitterImageDescriptor,
  QlaraRobots,
  QlaraRobotsInfo,
  QlaraAlternateURLs,
  QlaraAlternateLinkDescriptor,
  QlaraIcons,
  QlaraIcon,
  QlaraIconDescriptor,
  QlaraVerification,
  QlaraAppleWebApp,
  QlaraFormatDetection,
  QlaraFacebook,
  QlaraPinterest,
  QlaraAppLinks,
  QlaraAppLinksApple,
  QlaraAppLinksAndroid,
  QlaraAppLinksWindows,
  QlaraAppLinksWeb,
  QlaraAuthor,
} from '../../types.js';

// The routes module is resolved by esbuild at deploy time.
// esbuild's `alias` option maps this import to the developer's route file.
// At bundle time: '__qlara_routes__' → './qlara.routes.ts' (or wherever the dev put it)
// Injected at bundle time by esbuild define
declare const __QLARA_CACHE_TTL__: number;
declare const __QLARA_FRAMEWORK__: string;

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — resolved at bundle time by esbuild alias
import routes from '__qlara_routes__';

interface RendererEvent {
  /** The request URI, e.g. '/product/42' */
  uri: string;
  /** S3 bucket name to upload the rendered HTML to */
  bucket: string;
  /** The route pattern that matched, e.g. '/product/:id' */
  routePattern: string;
  /** The extracted route params, e.g. { id: '42' } */
  params: Record<string, string>;
}

interface RendererResult {
  statusCode: number;
  body: string;
  /** The fully rendered HTML — used by the edge handler to serve on first request */
  html?: string;
}

// Module-scope S3 client — reused across warm invocations (avoids recreating TCP/TLS connections)
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });

/**
 * Derive the S3 key for a rendered page.
 * Matches the Next.js static export convention: /product/42 → product/42.html
 */
function deriveS3Key(uri: string): string {
  const cleanUri = uri.replace(/^\//, '').replace(/\/$/, '');
  if (!cleanUri) return 'index.html';
  if (cleanUri.endsWith('.html')) return cleanUri;
  return `${cleanUri}.html`;
}

/**
 * Derive the fallback S3 key from a route pattern.
 * Filters out dynamic segments (starting with ':') and appends _fallback.html.
 * Must match getFallbackKey() in fallback.ts.
 *
 * '/product/:id' → 'product/_fallback.html'
 * '/:lang/products/:id' → 'products/_fallback.html'
 * '/:a/:b/:c' → '_fallback.html'
 */
function deriveFallbackKey(routePattern: string): string {
  const parts = routePattern.replace(/^\//, '').split('/');
  const dirParts = parts.filter(p => !p.startsWith(':'));
  return [...dirParts, '_fallback.html'].join('/');
}

/**
 * Generate a per-param placeholder string.
 * Must match paramPlaceholder() in fallback.ts (inlined because renderer
 * is bundled as a standalone Lambda ZIP).
 */
function paramPlaceholder(paramName: string): string {
  return `__QLARA_FALLBACK_${paramName}__`;
}

// ── Helpers: normalize single-or-array values ────────────────────

function toArray<T>(val: T | T[] | undefined): T[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

function toStringArray(val: string | string[] | undefined): string[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

// ── Robots string builder ────────────────────────────────────────

function robotsInfoToString(info: QlaraRobotsInfo): string {
  const parts: string[] = [];
  if (info.index === true) parts.push('index');
  if (info.index === false) parts.push('noindex');
  if (info.follow === true) parts.push('follow');
  if (info.follow === false) parts.push('nofollow');
  if (info.noarchive) parts.push('noarchive');
  if (info.nosnippet) parts.push('nosnippet');
  if (info.noimageindex) parts.push('noimageindex');
  if (info.nocache) parts.push('nocache');
  if (info.notranslate) parts.push('notranslate');
  if (info.indexifembedded) parts.push('indexifembedded');
  if (info.nositelinkssearchbox) parts.push('nositelinkssearchbox');
  if (info.unavailable_after) parts.push(`unavailable_after:${info.unavailable_after}`);
  if (info['max-video-preview'] !== undefined) parts.push(`max-video-preview:${info['max-video-preview']}`);
  if (info['max-image-preview']) parts.push(`max-image-preview:${info['max-image-preview']}`);
  if (info['max-snippet'] !== undefined) parts.push(`max-snippet:${info['max-snippet']}`);
  return parts.join(', ');
}

// ── metadataToHtml: convert QlaraMetadata → HTML tag strings ─────

function metadataToHtml(metadata: QlaraMetadata): string[] {
  const tags: string[] = [];

  const meta = (name: string, content: string) =>
    `<meta name="${escapeAttr(name)}" content="${escapeAttr(content)}"/>`;
  const prop = (property: string, content: string) =>
    `<meta property="${escapeAttr(property)}" content="${escapeAttr(content)}"/>`;
  const link = (rel: string, href: string, attrs?: Record<string, string>) => {
    const extra = attrs
      ? Object.entries(attrs).map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('')
      : '';
    return `<link rel="${escapeAttr(rel)}" href="${escapeAttr(href)}"${extra}/>`;
  };

  // Basic meta tags
  if (metadata.description) tags.push(meta('description', metadata.description));
  if (metadata.applicationName) tags.push(meta('application-name', metadata.applicationName));
  if (metadata.generator) tags.push(meta('generator', metadata.generator));
  if (metadata.creator) tags.push(meta('creator', metadata.creator));
  if (metadata.publisher) tags.push(meta('publisher', metadata.publisher));
  if (metadata.category) tags.push(meta('category', metadata.category));
  if (metadata.classification) tags.push(meta('classification', metadata.classification));
  if (metadata.abstract) tags.push(meta('abstract', metadata.abstract));
  if (metadata.referrer) tags.push(meta('referrer', metadata.referrer));

  // Keywords
  const keywords = toStringArray(metadata.keywords);
  if (keywords.length > 0) tags.push(meta('keywords', keywords.join(', ')));

  // Authors
  for (const author of toArray(metadata.authors)) {
    if (author.name) tags.push(meta('author', author.name));
    if (author.url) tags.push(link('author', author.url));
  }

  // Robots
  if (metadata.robots) {
    if (typeof metadata.robots === 'string') {
      tags.push(meta('robots', metadata.robots));
    } else {
      const robotsStr = robotsInfoToString(metadata.robots);
      if (robotsStr) tags.push(meta('robots', robotsStr));
      if (metadata.robots.googleBot) {
        if (typeof metadata.robots.googleBot === 'string') {
          tags.push(meta('googlebot', metadata.robots.googleBot));
        } else {
          const gbStr = robotsInfoToString(metadata.robots.googleBot);
          if (gbStr) tags.push(meta('googlebot', gbStr));
        }
      }
    }
  }

  // Alternates
  if (metadata.alternates) {
    const alt = metadata.alternates;
    if (alt.canonical) {
      const canonical = typeof alt.canonical === 'string' ? alt.canonical : alt.canonical.url;
      tags.push(link('canonical', canonical));
    }
    if (alt.languages) {
      for (const [hreflang, urls] of Object.entries(alt.languages)) {
        if (typeof urls === 'string') {
          tags.push(link('alternate', urls, { hreflang }));
        } else {
          for (const u of toArray(urls)) {
            tags.push(link('alternate', u.url, { hreflang }));
          }
        }
      }
    }
    if (alt.media) {
      for (const [mediaQuery, urls] of Object.entries(alt.media)) {
        if (typeof urls === 'string') {
          tags.push(link('alternate', urls, { media: mediaQuery }));
        } else {
          for (const u of toArray(urls)) {
            tags.push(link('alternate', u.url, { media: mediaQuery }));
          }
        }
      }
    }
    if (alt.types) {
      for (const [mimeType, urls] of Object.entries(alt.types)) {
        if (typeof urls === 'string') {
          tags.push(link('alternate', urls, { type: mimeType }));
        } else {
          for (const u of toArray(urls)) {
            tags.push(link('alternate', u.url, { type: mimeType }));
          }
        }
      }
    }
  }

  // Icons
  if (metadata.icons) {
    let icons: QlaraIcons;
    if (typeof metadata.icons === 'string') {
      icons = { icon: [metadata.icons] };
    } else if (Array.isArray(metadata.icons)) {
      icons = { icon: metadata.icons };
    } else {
      icons = metadata.icons;
    }

    const emitIcon = (icon: QlaraIcon, defaultRel: string) => {
      if (typeof icon === 'string') {
        tags.push(link(defaultRel, icon));
      } else {
        const attrs: Record<string, string> = {};
        if (icon.type) attrs.type = icon.type;
        if (icon.sizes) attrs.sizes = icon.sizes;
        if (icon.color) attrs.color = icon.color;
        if (icon.media) attrs.media = icon.media;
        tags.push(link(icon.rel || defaultRel, icon.url, attrs));
      }
    };

    for (const icon of toArray(icons.icon)) emitIcon(icon, 'icon');
    for (const icon of toArray(icons.shortcut)) emitIcon(icon, 'shortcut icon');
    for (const icon of toArray(icons.apple)) emitIcon(icon, 'apple-touch-icon');
    for (const icon of toArray(icons.other)) emitIcon(icon, 'icon');
  }

  // Manifest
  if (metadata.manifest) tags.push(link('manifest', metadata.manifest));

  // Open Graph
  if (metadata.openGraph) {
    const og = metadata.openGraph;
    if (og.title) tags.push(prop('og:title', og.title));
    if (og.description) tags.push(prop('og:description', og.description));
    if (og.url) tags.push(prop('og:url', og.url));
    if (og.siteName) tags.push(prop('og:site_name', og.siteName));
    if (og.locale) tags.push(prop('og:locale', og.locale));
    if (og.type) tags.push(prop('og:type', og.type));
    if (og.determiner) tags.push(prop('og:determiner', og.determiner));
    if (og.countryName) tags.push(prop('og:country-name', og.countryName));
    if (og.ttl !== undefined) tags.push(prop('og:ttl', String(og.ttl)));

    for (const locale of toStringArray(og.alternateLocale)) {
      tags.push(prop('og:locale:alternate', locale));
    }
    for (const email of toStringArray(og.emails)) {
      tags.push(prop('og:email', email));
    }
    for (const phone of toStringArray(og.phoneNumbers)) {
      tags.push(prop('og:phone_number', phone));
    }
    for (const fax of toStringArray(og.faxNumbers)) {
      tags.push(prop('og:fax_number', fax));
    }

    // OG images
    for (const img of toArray(og.images)) {
      if (typeof img === 'string') {
        tags.push(prop('og:image', img));
      } else {
        tags.push(prop('og:image', img.url));
        if (img.secureUrl) tags.push(prop('og:image:secure_url', img.secureUrl));
        if (img.alt) tags.push(prop('og:image:alt', img.alt));
        if (img.type) tags.push(prop('og:image:type', img.type));
        if (img.width !== undefined) tags.push(prop('og:image:width', String(img.width)));
        if (img.height !== undefined) tags.push(prop('og:image:height', String(img.height)));
      }
    }

    // OG audio
    for (const audio of toArray(og.audio)) {
      if (typeof audio === 'string') {
        tags.push(prop('og:audio', audio));
      } else {
        tags.push(prop('og:audio', audio.url));
        if (audio.secureUrl) tags.push(prop('og:audio:secure_url', audio.secureUrl));
        if (audio.type) tags.push(prop('og:audio:type', audio.type));
      }
    }

    // OG videos
    for (const video of toArray(og.videos)) {
      if (typeof video === 'string') {
        tags.push(prop('og:video', video));
      } else {
        tags.push(prop('og:video', video.url));
        if (video.secureUrl) tags.push(prop('og:video:secure_url', video.secureUrl));
        if (video.type) tags.push(prop('og:video:type', video.type));
        if (video.width !== undefined) tags.push(prop('og:video:width', String(video.width)));
        if (video.height !== undefined) tags.push(prop('og:video:height', String(video.height)));
      }
    }

    // OG type-specific fields
    if (og.type === 'article') {
      if (og.publishedTime) tags.push(prop('article:published_time', og.publishedTime));
      if (og.modifiedTime) tags.push(prop('article:modified_time', og.modifiedTime));
      if (og.expirationTime) tags.push(prop('article:expiration_time', og.expirationTime));
      if (og.section) tags.push(prop('article:section', og.section));
      for (const author of toStringArray(og.authors)) tags.push(prop('article:author', author));
      for (const tag of toStringArray(og.tags)) tags.push(prop('article:tag', tag));
    } else if (og.type === 'book') {
      if (og.isbn) tags.push(prop('book:isbn', og.isbn));
      if (og.releaseDate) tags.push(prop('book:release_date', og.releaseDate));
      for (const author of toStringArray(og.authors)) tags.push(prop('book:author', author));
      for (const tag of toStringArray(og.tags)) tags.push(prop('book:tag', tag));
    } else if (og.type === 'profile') {
      if (og.firstName) tags.push(prop('profile:first_name', og.firstName));
      if (og.lastName) tags.push(prop('profile:last_name', og.lastName));
      if (og.username) tags.push(prop('profile:username', og.username));
      if (og.gender) tags.push(prop('profile:gender', og.gender));
    } else if (og.type === 'music.song') {
      if (og.duration !== undefined) tags.push(prop('music:duration', String(og.duration)));
      for (const album of toStringArray(og.albums)) tags.push(prop('music:album', album));
      for (const musician of toStringArray(og.musicians)) tags.push(prop('music:musician', musician));
    } else if (og.type === 'music.album') {
      if (og.releaseDate) tags.push(prop('music:release_date', og.releaseDate));
      for (const song of toStringArray(og.songs)) tags.push(prop('music:song', song));
      for (const musician of toStringArray(og.musicians)) tags.push(prop('music:musician', musician));
    } else if (og.type === 'music.playlist') {
      for (const song of toStringArray(og.songs)) tags.push(prop('music:song', song));
      for (const creator of toStringArray(og.creators)) tags.push(prop('music:creator', creator));
    } else if (og.type === 'music.radio_station') {
      for (const creator of toStringArray(og.creators)) tags.push(prop('music:creator', creator));
    } else if (og.type === 'video.movie' || og.type === 'video.episode') {
      if (og.duration !== undefined) tags.push(prop('video:duration', String(og.duration)));
      if (og.releaseDate) tags.push(prop('video:release_date', og.releaseDate));
      for (const actor of toStringArray(og.actors)) tags.push(prop('video:actor', actor));
      for (const director of toStringArray(og.directors)) tags.push(prop('video:director', director));
      for (const writer of toStringArray(og.writers)) tags.push(prop('video:writer', writer));
      for (const tag of toStringArray(og.tags)) tags.push(prop('video:tag', tag));
      if (og.type === 'video.episode' && og.series) tags.push(prop('video:series', og.series));
    }
  }

  // Twitter
  if (metadata.twitter) {
    const tw = metadata.twitter;
    const card = ('card' in tw && tw.card) ? tw.card : 'summary';
    tags.push(meta('twitter:card', card));
    if (tw.site) tags.push(meta('twitter:site', tw.site));
    if (tw.siteId) tags.push(meta('twitter:site:id', tw.siteId));
    if (tw.creator) tags.push(meta('twitter:creator', tw.creator));
    if (tw.creatorId) tags.push(meta('twitter:creator:id', tw.creatorId));
    if (tw.title) tags.push(meta('twitter:title', tw.title));
    if (tw.description) tags.push(meta('twitter:description', tw.description));

    for (const img of toArray(tw.images)) {
      if (typeof img === 'string') {
        tags.push(meta('twitter:image', img));
      } else {
        tags.push(meta('twitter:image', img.url));
        if (img.alt) tags.push(meta('twitter:image:alt', img.alt));
      }
    }

    if ('players' in tw && tw.players) {
      for (const player of toArray(tw.players)) {
        tags.push(meta('twitter:player', player.playerUrl));
        tags.push(meta('twitter:player:stream', player.streamUrl));
        tags.push(meta('twitter:player:width', String(player.width)));
        tags.push(meta('twitter:player:height', String(player.height)));
      }
    }

    if ('app' in tw && tw.app) {
      if (tw.app.name) tags.push(meta('twitter:app:name:iphone', tw.app.name));
      if (tw.app.id.iphone) tags.push(meta('twitter:app:id:iphone', String(tw.app.id.iphone)));
      if (tw.app.id.ipad) tags.push(meta('twitter:app:id:ipad', String(tw.app.id.ipad)));
      if (tw.app.id.googleplay) tags.push(meta('twitter:app:id:googleplay', tw.app.id.googleplay));
      if (tw.app.url?.iphone) tags.push(meta('twitter:app:url:iphone', tw.app.url.iphone));
      if (tw.app.url?.ipad) tags.push(meta('twitter:app:url:ipad', tw.app.url.ipad));
      if (tw.app.url?.googleplay) tags.push(meta('twitter:app:url:googleplay', tw.app.url.googleplay));
    }
  }

  // Verification
  if (metadata.verification) {
    const v = metadata.verification;
    for (const val of toStringArray(v.google)) tags.push(meta('google-site-verification', val));
    for (const val of toStringArray(v.yahoo)) tags.push(meta('y_key', val));
    for (const val of toStringArray(v.yandex)) tags.push(meta('yandex-verification', val));
    for (const val of toStringArray(v.me)) tags.push(meta('me', val));
    if (v.other) {
      for (const [name, values] of Object.entries(v.other)) {
        for (const val of toStringArray(values as string | string[])) {
          tags.push(meta(name, val));
        }
      }
    }
  }

  // Apple Web App
  if (metadata.appleWebApp !== undefined) {
    if (metadata.appleWebApp === true) {
      tags.push(meta('apple-mobile-web-app-capable', 'yes'));
    } else if (typeof metadata.appleWebApp === 'object') {
      const awa = metadata.appleWebApp;
      if (awa.capable) tags.push(meta('apple-mobile-web-app-capable', 'yes'));
      if (awa.title) tags.push(meta('apple-mobile-web-app-title', awa.title));
      if (awa.statusBarStyle) tags.push(meta('apple-mobile-web-app-status-bar-style', awa.statusBarStyle));
      for (const img of toArray(awa.startupImage)) {
        if (typeof img === 'string') {
          tags.push(link('apple-touch-startup-image', img));
        } else {
          const attrs: Record<string, string> = {};
          if (img.media) attrs.media = img.media;
          tags.push(link('apple-touch-startup-image', img.url, attrs));
        }
      }
    }
  }

  // Format detection
  if (metadata.formatDetection) {
    const fd = metadata.formatDetection;
    const parts: string[] = [];
    if (fd.telephone === false) parts.push('telephone=no');
    if (fd.date === false) parts.push('date=no');
    if (fd.address === false) parts.push('address=no');
    if (fd.email === false) parts.push('email=no');
    if (fd.url === false) parts.push('url=no');
    if (parts.length > 0) tags.push(meta('format-detection', parts.join(', ')));
  }

  // iTunes
  if (metadata.itunes) {
    const parts = [`app-id=${metadata.itunes.appId}`];
    if (metadata.itunes.appArgument) parts.push(`app-argument=${metadata.itunes.appArgument}`);
    tags.push(meta('apple-itunes-app', parts.join(', ')));
  }

  // Facebook
  if (metadata.facebook) {
    if (metadata.facebook.appId) tags.push(prop('fb:app_id', metadata.facebook.appId));
    for (const admin of toStringArray(metadata.facebook.admins)) {
      tags.push(prop('fb:admins', admin));
    }
  }

  // Pinterest
  if (metadata.pinterest?.richPin !== undefined) {
    tags.push(meta('pinterest-rich-pin', String(metadata.pinterest.richPin)));
  }

  // App Links
  if (metadata.appLinks) {
    const al = metadata.appLinks;
    const emitApple = (platform: string, items: QlaraAppLinksApple[]) => {
      for (const item of items) {
        tags.push(prop(`al:${platform}:url`, item.url));
        if (item.app_store_id) tags.push(prop(`al:${platform}:app_store_id`, String(item.app_store_id)));
        if (item.app_name) tags.push(prop(`al:${platform}:app_name`, item.app_name));
      }
    };
    const emitAndroid = (items: QlaraAppLinksAndroid[]) => {
      for (const item of items) {
        tags.push(prop('al:android:package', item.package));
        if (item.url) tags.push(prop('al:android:url', item.url));
        if (item.class) tags.push(prop('al:android:class', item.class));
        if (item.app_name) tags.push(prop('al:android:app_name', item.app_name));
      }
    };
    const emitWindows = (platform: string, items: QlaraAppLinksWindows[]) => {
      for (const item of items) {
        tags.push(prop(`al:${platform}:url`, item.url));
        if (item.app_id) tags.push(prop(`al:${platform}:app_id`, item.app_id));
        if (item.app_name) tags.push(prop(`al:${platform}:app_name`, item.app_name));
      }
    };
    const emitWeb = (items: QlaraAppLinksWeb[]) => {
      for (const item of items) {
        tags.push(prop('al:web:url', item.url));
        if (item.should_fallback !== undefined) {
          tags.push(prop('al:web:should_fallback', String(item.should_fallback)));
        }
      }
    };

    emitApple('ios', toArray(al.ios));
    emitApple('iphone', toArray(al.iphone));
    emitApple('ipad', toArray(al.ipad));
    emitAndroid(toArray(al.android));
    emitWindows('windows_phone', toArray(al.windows_phone));
    emitWindows('windows', toArray(al.windows));
    emitWindows('windows_universal', toArray(al.windows_universal));
    emitWeb(toArray(al.web));
  }

  // Link tags: archives, assets, bookmarks
  for (const href of toStringArray(metadata.archives)) tags.push(link('archives', href));
  for (const href of toStringArray(metadata.assets)) tags.push(link('assets', href));
  for (const href of toStringArray(metadata.bookmarks)) tags.push(link('bookmarks', href));

  // Pagination
  if (metadata.pagination?.previous) tags.push(link('prev', metadata.pagination.previous));
  if (metadata.pagination?.next) tags.push(link('next', metadata.pagination.next));

  // Catch-all custom meta tags
  if (metadata.other) {
    for (const [name, values] of Object.entries(metadata.other)) {
      for (const val of toArray(values)) {
        tags.push(meta(name, String(val)));
      }
    }
  }

  return tags;
}

/**
 * Patch the HTML with real metadata from the metaDataGenerator.
 * This produces output identical to what the framework generates at build time.
 */
function patchMetadata(html: string, metadata: QlaraMetadata): string {
  let patched = html;

  // 1. Update <title> tag
  patched = patched.replace(
    /<title>[^<]*<\/title>/,
    `<title>${escapeHtml(metadata.title)}</title>`
  );

  // 2. Remove existing Qlara-managed tags broadly.
  //    Meta tags with name= or property= attributes that Qlara generates.
  patched = patched.replace(/<meta\s+(?:name|property)="(?:description|application-name|generator|creator|publisher|category|classification|abstract|referrer|keywords|author|robots|googlebot|og:[^"]*|twitter:[^"]*|fb:[^"]*|al:[^"]*|google-site-verification|y_key|yandex-verification|me|apple-mobile-web-app-[^"]*|format-detection|apple-itunes-app|pinterest-rich-pin)"\s+content="[^"]*"\s*\/?>/g, '');
  //    Also match content-first ordering: <meta content="..." name="..."/>
  patched = patched.replace(/<meta\s+content="[^"]*"\s+(?:name|property)="(?:description|application-name|generator|creator|publisher|category|classification|abstract|referrer|keywords|author|robots|googlebot|og:[^"]*|twitter:[^"]*|fb:[^"]*|al:[^"]*|google-site-verification|y_key|yandex-verification|me|apple-mobile-web-app-[^"]*|format-detection|apple-itunes-app|pinterest-rich-pin)"\s*\/?>/g, '');
  //    Link tags that Qlara manages
  patched = patched.replace(/<link\s+rel="(?:canonical|alternate|author|icon|shortcut icon|apple-touch-icon|apple-touch-startup-image|manifest|archives|assets|bookmarks|prev|next)"[^>]*\/?>/g, '');

  // 3. Generate and inject all meta/link tags after </title>
  const htmlTags = metadataToHtml(metadata);
  patched = patched.replace(
    /(<\/title>)/,
    `$1${htmlTags.join('')}`
  );

  // 4. Patch RSC flight data so React doesn't overwrite metadata on hydration.
  //    RSC data lives inside <script>self.__next_f.push([1,"..."])</script>
  //    where quotes are escaped as \". We must match and replace in that form.
  //    Build-time format:
  //    8:{"metadata":[[...title...],[...meta tags...]],\"error\":null,\"digest\":\"$undefined\"}
  const rscEntries = metadataToRscEntries(metadata);

  patched = patched.replace(
    /8:\{\\\"metadata\\\":\[[\s\S]*?\],\\\"error\\\":null,\\\"digest\\\":\\\"?\$undefined\\\"?\}/,
    `8:{\\\"metadata\\\":[${rscEntries}],\\\"error\\\":null,\\\"digest\\\":\\\"$undefined\\\"}`
  );

  return patched;
}

/**
 * Build RSC flight data metadata entries from QlaraMetadata.
 * Each entry is a serialized React element in the RSC wire format.
 * Uses auto-incrementing keys for element IDs.
 */
function metadataToRscEntries(metadata: QlaraMetadata): string {
  const q = '\\"'; // escaped quote as it appears in the HTML script
  let idx = 0;

  const entries: string[] = [];

  // Title element (special — uses children prop)
  entries.push(
    `[${q}$${q},${q}title${q},${q}${idx++}${q},{${q}children${q}:${q}${escapeRsc(metadata.title)}${q}}]`
  );

  // Helper: emit a <meta> RSC entry with name= or property= attribute
  const rscMeta = (attrName: string, attrValue: string, content: string) => {
    entries.push(
      `,[${q}$${q},${q}meta${q},${q}${idx++}${q},{${q}${attrName}${q}:${q}${escapeRsc(attrValue)}${q},${q}content${q}:${q}${escapeRsc(content)}${q}}]`
    );
  };

  const rscLink = (rel: string, href: string, extra?: Record<string, string>) => {
    let props = `${q}rel${q}:${q}${escapeRsc(rel)}${q},${q}href${q}:${q}${escapeRsc(href)}${q}`;
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        props += `,${q}${escapeRsc(k)}${q}:${q}${escapeRsc(v)}${q}`;
      }
    }
    entries.push(`,[${q}$${q},${q}link${q},${q}${idx++}${q},{${props}}]`);
  };

  // Basic meta
  if (metadata.description) rscMeta('name', 'description', metadata.description);
  if (metadata.applicationName) rscMeta('name', 'application-name', metadata.applicationName);
  if (metadata.generator) rscMeta('name', 'generator', metadata.generator);
  if (metadata.creator) rscMeta('name', 'creator', metadata.creator);
  if (metadata.publisher) rscMeta('name', 'publisher', metadata.publisher);
  if (metadata.category) rscMeta('name', 'category', metadata.category);
  if (metadata.classification) rscMeta('name', 'classification', metadata.classification);
  if (metadata.abstract) rscMeta('name', 'abstract', metadata.abstract);
  if (metadata.referrer) rscMeta('name', 'referrer', metadata.referrer);

  const keywords = toStringArray(metadata.keywords);
  if (keywords.length > 0) rscMeta('name', 'keywords', keywords.join(', '));

  for (const author of toArray(metadata.authors)) {
    if (author.name) rscMeta('name', 'author', author.name);
    if (author.url) rscLink('author', author.url);
  }

  // Robots
  if (metadata.robots) {
    if (typeof metadata.robots === 'string') {
      rscMeta('name', 'robots', metadata.robots);
    } else {
      const robotsStr = robotsInfoToString(metadata.robots);
      if (robotsStr) rscMeta('name', 'robots', robotsStr);
      if (metadata.robots.googleBot) {
        const gbStr = typeof metadata.robots.googleBot === 'string'
          ? metadata.robots.googleBot
          : robotsInfoToString(metadata.robots.googleBot);
        if (gbStr) rscMeta('name', 'googlebot', gbStr);
      }
    }
  }

  // Alternates
  if (metadata.alternates) {
    const alt = metadata.alternates;
    if (alt.canonical) {
      const href = typeof alt.canonical === 'string' ? alt.canonical : alt.canonical.url;
      rscLink('canonical', href);
    }
    if (alt.languages) {
      for (const [hreflang, urls] of Object.entries(alt.languages)) {
        if (typeof urls === 'string') {
          rscLink('alternate', urls, { hreflang });
        } else {
          for (const u of toArray(urls)) {
            rscLink('alternate', u.url, { hreflang });
          }
        }
      }
    }
  }

  // Open Graph
  if (metadata.openGraph) {
    const og = metadata.openGraph;
    if (og.title) rscMeta('property', 'og:title', og.title);
    if (og.description) rscMeta('property', 'og:description', og.description);
    if (og.url) rscMeta('property', 'og:url', og.url);
    if (og.siteName) rscMeta('property', 'og:site_name', og.siteName);
    if (og.locale) rscMeta('property', 'og:locale', og.locale);
    if (og.type) rscMeta('property', 'og:type', og.type);

    for (const img of toArray(og.images)) {
      if (typeof img === 'string') {
        rscMeta('property', 'og:image', img);
      } else {
        rscMeta('property', 'og:image', img.url);
        if (img.alt) rscMeta('property', 'og:image:alt', img.alt);
        if (img.width !== undefined) rscMeta('property', 'og:image:width', String(img.width));
        if (img.height !== undefined) rscMeta('property', 'og:image:height', String(img.height));
        if (img.type) rscMeta('property', 'og:image:type', img.type);
      }
    }

    // Article type-specific
    if (og.type === 'article') {
      if (og.publishedTime) rscMeta('property', 'article:published_time', og.publishedTime);
      if (og.modifiedTime) rscMeta('property', 'article:modified_time', og.modifiedTime);
      if (og.section) rscMeta('property', 'article:section', og.section);
      for (const tag of toStringArray(og.tags)) rscMeta('property', 'article:tag', tag);
    }
  }

  // Twitter
  if (metadata.twitter) {
    const tw = metadata.twitter;
    const card = ('card' in tw && tw.card) ? tw.card : 'summary';
    rscMeta('name', 'twitter:card', card);
    if (tw.site) rscMeta('name', 'twitter:site', tw.site);
    if (tw.creator) rscMeta('name', 'twitter:creator', tw.creator);
    if (tw.title) rscMeta('name', 'twitter:title', tw.title);
    if (tw.description) rscMeta('name', 'twitter:description', tw.description);

    for (const img of toArray(tw.images)) {
      if (typeof img === 'string') {
        rscMeta('name', 'twitter:image', img);
      } else {
        rscMeta('name', 'twitter:image', img.url);
        if (img.alt) rscMeta('name', 'twitter:image:alt', img.alt);
      }
    }
  }

  // Verification
  if (metadata.verification) {
    const v = metadata.verification;
    for (const val of toStringArray(v.google)) rscMeta('name', 'google-site-verification', val);
    for (const val of toStringArray(v.yandex)) rscMeta('name', 'yandex-verification', val);
  }

  // Catch-all
  if (metadata.other) {
    for (const [name, values] of Object.entries(metadata.other)) {
      for (const val of toArray(values)) {
        rscMeta('name', name, String(val));
      }
    }
  }

  return entries.join('');
}

/**
 * Extract RSC flight data from rendered HTML (Next.js-specific).
 *
 * Next.js embeds RSC data inside <script>self.__next_f.push([1,"..."])</script> blocks.
 * The .txt file is these payloads concatenated with JSON string escapes resolved.
 * Next.js's client-side router fetches the .txt file for client-side navigation
 * instead of the full .html — so we must generate it for renderer-created pages.
 *
 * Only called when __QLARA_FRAMEWORK__ === 'next'.
 */
function extractRscFlightData(html: string): string | null {
  const chunks: string[] = [];
  const regex = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  let match;

  while ((match = regex.exec(html)) !== null) {
    // Unescape the JSON string: \" → ", \\ → \, \n → newline
    const unescaped = match[1]
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
    chunks.push(unescaped);
  }

  if (chunks.length === 0) return null;
  return chunks.join('');
}

// ── Per-segment prefetch file generation (Next.js 16+) ───────────
//
// Next.js 16 introduced per-segment prefetch files in a subdirectory
// per page (e.g. product/1/__next._tree.txt). The renderer must generate
// these for renderer-created pages so they match build-time pages.
//
// Approach: discover segment files from a build-time reference page on S3,
// classify each file, and copy/patch as needed. If no reference page exists
// (Next.js 15 or no build-time pages), segment generation is skipped.

/** Cache reference segment directory per route prefix across warm invocations */
const referencePageCache = new Map<string, string | null>();

/**
 * Find a build-time page's segment directory in S3 to use as a template.
 * Returns the S3 key prefix (e.g. 'product/1/') or null.
 */
async function findReferenceSegmentDir(bucket: string, routePrefix: string): Promise<string | null> {
  const cached = referencePageCache.get(routePrefix);
  if (cached !== undefined) return cached;

  try {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `${routePrefix}/`,
      MaxKeys: 200,
    }));

    for (const obj of response.Contents || []) {
      const key = obj.Key || '';
      if (key.endsWith('/__next._tree.txt')) {
        const dir = key.slice(0, key.length - '__next._tree.txt'.length);
        referencePageCache.set(routePrefix, dir);
        return dir;
      }
    }
  } catch {
    // S3 error — skip segment generation
  }

  referencePageCache.set(routePrefix, null);
  return null;
}

type SegmentFileType = 'shared' | 'tree' | 'head' | 'full' | 'page';

/**
 * Classify a segment file by its name.
 */
function classifySegmentFile(name: string): SegmentFileType {
  if (name === '__next._tree.txt') return 'tree';
  if (name === '__next._head.txt') return 'head';
  if (name === '__next._full.txt') return 'full';
  if (name.includes('__PAGE__')) return 'page';
  return 'shared';
}

/**
 * List all segment file names in a reference directory.
 */
async function listReferenceSegmentFiles(bucket: string, refDir: string): Promise<string[]> {
  try {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `${refDir}__next.`,
      MaxKeys: 50,
    }));

    return (response.Contents || [])
      .map(obj => obj.Key || '')
      .filter(key => key.endsWith('.txt'))
      .map(key => key.slice(refDir.length));
  } catch {
    return [];
  }
}

/**
 * Patch the _tree.txt segment: replace dynamic paramKey values for all params.
 * Each dynamic segment has "name":"<paramName>","paramType":"d","paramKey":"<value>".
 * We match on the param name to replace the correct paramKey for each param.
 */
function patchTreeSegment(template: string, params: Record<string, string>): string {
  let result = template;
  for (const [name, value] of Object.entries(params)) {
    result = result.replace(
      new RegExp(`"name":"${name}","paramType":"d","paramKey":"[^"]*"`),
      `"name":"${name}","paramType":"d","paramKey":"${value}"`
    );
  }
  return result;
}

/**
 * Patch the __PAGE__.txt segment: replace param values in the component props.
 */
function patchPageSegment(template: string, params: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(params)) {
    // RSC wire format: ["$","$L2",null,{"id":"OLD"}]
    result = result.replace(
      new RegExp(`"${key}":"[^"]*"`),
      `"${key}":"${value}"`
    );
  }
  return result;
}

/**
 * Generate the _head.txt segment from a reference template and new metadata.
 * Extracts preamble (module declarations) and buildId from the reference,
 * rebuilds line 0 with new metadata.
 */
function generateHeadSegment(template: string, metadata: QlaraMetadata): string {
  // Split into lines — preamble is everything before the line starting with '0:'
  const lines = template.split('\n');
  const preambleLines: string[] = [];
  let line0 = '';

  for (const line of lines) {
    if (line.startsWith('0:')) {
      line0 = line;
    } else if (line.trim()) {
      preambleLines.push(line);
    }
  }

  // Extract buildId from reference
  const buildIdMatch = line0.match(/"buildId":"([^"]+)"/);
  const buildId = buildIdMatch ? buildIdMatch[1] : '';

  // Extract the viewport/charset meta tags from the reference (preserve them)
  // These are inside the rsc at children[1] (the $L2 viewport boundary)
  // We keep the structure identical but replace the metadata children
  const viewportMatch = line0.match(/"children":\[(\["\\?\$","meta"[^\]]*\](?:,\["\\?\$","meta"[^\]]*\])*)\]/);
  const viewportTags = viewportMatch ? viewportMatch[1] : '["\$","meta","0",{"charSet":"utf-8"}],["$","meta","1",{"name":"viewport","content":"width=device-width, initial-scale=1"}]';

  // Build metadata RSC children array (standard JSON, not HTML-escaped)
  const metaChildren: string[] = [];
  let idx = 0;

  // Title
  metaChildren.push(`["$","title","${idx++}",{"children":"${escapeJson(metadata.title)}"}]`);

  // Description
  if (metadata.description) {
    metaChildren.push(`["$","meta","${idx++}",{"name":"description","content":"${escapeJson(metadata.description)}"}]`);
  }

  // Open Graph
  if (metadata.openGraph) {
    const og = metadata.openGraph;
    if (og.title) metaChildren.push(`["$","meta","${idx++}",{"property":"og:title","content":"${escapeJson(og.title)}"}]`);
    if (og.description) metaChildren.push(`["$","meta","${idx++}",{"property":"og:description","content":"${escapeJson(og.description)}"}]`);
    if (og.url) metaChildren.push(`["$","meta","${idx++}",{"property":"og:url","content":"${escapeJson(og.url)}"}]`);
    if (og.siteName) metaChildren.push(`["$","meta","${idx++}",{"property":"og:site_name","content":"${escapeJson(og.siteName)}"}]`);
    if (og.type) metaChildren.push(`["$","meta","${idx++}",{"property":"og:type","content":"${escapeJson(og.type)}"}]`);
    for (const img of toArray(og.images)) {
      if (typeof img === 'string') {
        metaChildren.push(`["$","meta","${idx++}",{"property":"og:image","content":"${escapeJson(img)}"}]`);
      } else {
        metaChildren.push(`["$","meta","${idx++}",{"property":"og:image","content":"${escapeJson(img.url)}"}]`);
        if (img.alt) metaChildren.push(`["$","meta","${idx++}",{"property":"og:image:alt","content":"${escapeJson(img.alt)}"}]`);
        if (img.width !== undefined) metaChildren.push(`["$","meta","${idx++}",{"property":"og:image:width","content":"${String(img.width)}"}]`);
        if (img.height !== undefined) metaChildren.push(`["$","meta","${idx++}",{"property":"og:image:height","content":"${String(img.height)}"}]`);
      }
    }
  }

  // Twitter
  if (metadata.twitter) {
    const tw = metadata.twitter;
    const card = ('card' in tw && tw.card) ? tw.card : 'summary';
    metaChildren.push(`["$","meta","${idx++}",{"name":"twitter:card","content":"${escapeJson(card)}"}]`);
    if (tw.title) metaChildren.push(`["$","meta","${idx++}",{"name":"twitter:title","content":"${escapeJson(tw.title)}"}]`);
    if (tw.description) metaChildren.push(`["$","meta","${idx++}",{"name":"twitter:description","content":"${escapeJson(tw.description)}"}]`);
    for (const img of toArray(tw.images)) {
      if (typeof img === 'string') {
        metaChildren.push(`["$","meta","${idx++}",{"name":"twitter:image","content":"${escapeJson(img)}"}]`);
      } else {
        metaChildren.push(`["$","meta","${idx++}",{"name":"twitter:image","content":"${escapeJson(img.url)}"}]`);
        if (img.alt) metaChildren.push(`["$","meta","${idx++}",{"name":"twitter:image:alt","content":"${escapeJson(img.alt)}"}]`);
      }
    }
  }

  // Reconstruct the _head.txt content by replacing the metadata children
  // in the reference template's line 0 structure
  const metaChildrenStr = metaChildren.join(',');

  // The _head.txt line 0 structure (from analysis):
  // 0:{"buildId":"...","rsc":["$","$1","h",{"children":[null,["$","$L2",null,{"children":[viewport tags]}],["$","div",null,{"hidden":true,"children":["$","$L3",null,{"children":["$","$4",null,{"name":"Next.Metadata","children":[METADATA HERE]}]}]}],null]}],"loading":null,"isPartial":false}
  // Replace the "Next.Metadata" children array
  const newLine0 = line0.replace(
    /("name":"Next\.Metadata","children":\[)[\s\S]*?(\]\})/,
    `$1${metaChildrenStr}$2`
  );

  return preambleLines.join('\n') + '\n' + newLine0 + '\n';
}

/**
 * Generate per-segment prefetch files for a renderer-created page (Next.js 16+).
 * Reads segment files from a build-time reference page, patches page-specific data,
 * and uploads to the new page's subdirectory.
 *
 * Skips gracefully if no reference page exists (Next.js 15 or first deploy).
 */
async function generateSegmentFiles(
  bucket: string,
  uri: string,
  params: Record<string, string>,
  rscData: string | null,
  metadata: QlaraMetadata | null,
): Promise<void> {
  const cleanUri = uri.replace(/^\//, '').replace(/\/$/, '');
  const parts = cleanUri.split('/');
  const routePrefix = parts.slice(0, -1).join('/'); // 'product'
  const segmentDir = `${cleanUri}/`;                 // 'product/42/'

  // Find a build-time page with segment files to use as reference
  const refDir = await findReferenceSegmentDir(bucket, routePrefix);
  if (!refDir) return; // No segment files on S3 — Next.js 15 or no build-time pages

  // List all segment files in the reference directory
  const fileNames = await listReferenceSegmentFiles(bucket, refDir);
  if (fileNames.length === 0) return;

  // Read all reference files we need (skip _full — we use rscData directly)
  const filesToRead = fileNames.filter(name => classifySegmentFile(name) !== 'full');
  const readResults = await Promise.allSettled(
    filesToRead.map(async (name) => {
      const result = await s3.send(new GetObjectCommand({
        Bucket: bucket,
        Key: `${refDir}${name}`,
      }));
      return {
        name,
        content: await result.Body?.transformToString('utf-8') || '',
      };
    })
  );

  const refMap = new Map<string, string>();
  for (const result of readResults) {
    if (result.status === 'fulfilled' && result.value.content) {
      refMap.set(result.value.name, result.value.content);
    }
  }

  // Generate each segment file
  const uploads: Promise<unknown>[] = [];
  const cacheControl = `public, max-age=0, s-maxage=${__QLARA_CACHE_TTL__}, stale-while-revalidate=60`;

  for (const name of fileNames) {
    let content: string | null = null;
    const type = classifySegmentFile(name);

    switch (type) {
      case 'shared':
        content = refMap.get(name) || null;
        break;
      case 'tree': {
        const template = refMap.get(name);
        if (template) {
          content = patchTreeSegment(template, params);
        }
        break;
      }
      case 'head': {
        const template = refMap.get(name);
        if (template && metadata) {
          content = generateHeadSegment(template, metadata);
        }
        break;
      }
      case 'full':
        content = rscData;
        break;
      case 'page': {
        const template = refMap.get(name);
        if (template) {
          content = patchPageSegment(template, params);
        }
        break;
      }
    }

    if (content) {
      uploads.push(
        s3.send(new PutObjectCommand({
          Bucket: bucket,
          Key: `${segmentDir}${name}`,
          Body: content,
          ContentType: 'text/plain; charset=utf-8',
          CacheControl: cacheControl,
        }))
      );
    }
  }

  await Promise.all(uploads);
}

/**
 * Escape a string for use inside a JSON string value.
 */
function escapeJson(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

export async function handler(event: RendererEvent & { warmup?: boolean }): Promise<RendererResult> {
  // Warmup invocation — just initialize the runtime and return
  if (event.warmup) {
    return { statusCode: 200, body: 'warm' };
  }

  const { uri, bucket, routePattern, params } = event;

  try {
    // 0. Find route definition and run validation (if defined)
    const routeDef = routes?.find((r: { route: string }) => r.route === routePattern);

    if (routeDef?.validate) {
      const isValid = await routeDef.validate(params);
      if (!isValid) {
        return {
          statusCode: 404,
          body: JSON.stringify({ error: `Validation failed for ${uri}`, params }),
        };
      }
    }

    // 1. Check if already rendered + read fallback in parallel
    const s3Key = deriveS3Key(uri);
    const fallbackKey = deriveFallbackKey(routePattern);

    const [existingResult, fallbackResult] = await Promise.allSettled([
      s3.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key })),
      s3.send(new GetObjectCommand({ Bucket: bucket, Key: fallbackKey })),
    ]);

    // If page already exists, return it (guards against duplicate concurrent requests)
    if (existingResult.status === 'fulfilled') {
      const existingHtml = await existingResult.value.Body?.transformToString('utf-8');
      if (existingHtml) {
        return {
          statusCode: 200,
          body: JSON.stringify({ message: `Already rendered: ${uri}`, key: s3Key }),
          html: existingHtml,
        };
      }
    }

    // Extract fallback HTML
    let fallbackHtml: string;

    if (fallbackResult.status === 'fulfilled') {
      fallbackHtml = (await fallbackResult.value.Body?.transformToString('utf-8')) || '';
      if (!fallbackHtml) {
        return {
          statusCode: 500,
          body: JSON.stringify({ error: `Empty fallback at ${fallbackKey}` }),
        };
      }
    } else {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: `Fallback not found: ${fallbackKey}` }),
      };
    }

    // 2. Patch the fallback with actual param values (per-param placeholders)
    let html = fallbackHtml;
    for (const [name, value] of Object.entries(params)) {
      html = html.replace(new RegExp(paramPlaceholder(name), 'g'), value);
    }

    // 3. Call generateMetadata (or deprecated metaDataGenerator) to fetch metadata
    const metadataFn = routeDef?.generateMetadata || routeDef?.metaDataGenerator;
    let metadata: QlaraMetadata | null = null;

    if (metadataFn) {
      metadata = await metadataFn(params);
      if (metadata) {
        // 4. Patch the HTML with real metadata
        html = patchMetadata(html, metadata);
      }
    }

    // 5. Upload HTML to S3
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        Body: html,
        ContentType: 'text/html; charset=utf-8',
        CacheControl: `public, max-age=0, s-maxage=${__QLARA_CACHE_TTL__}, stale-while-revalidate=60`,
      })
    );

    // 6. Framework-specific post-render uploads
    //    Next.js: extract RSC flight data, upload .txt for client-side navigation,
    //    and generate per-segment prefetch files (Next.js 16+).
    if (__QLARA_FRAMEWORK__ === 'next') {
      const rscData = extractRscFlightData(html);
      if (rscData) {
        const txtKey = s3Key.replace(/\.html$/, '.txt');
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: txtKey,
            Body: rscData,
            ContentType: 'text/plain; charset=utf-8',
            CacheControl: `public, max-age=0, s-maxage=${__QLARA_CACHE_TTL__}, stale-while-revalidate=60`,
          })
        );
      }

      // 7. Generate per-segment prefetch files (Next.js 16+ Segment Cache)
      //    Reads templates from a build-time reference page, patches page-specific data.
      //    Skips automatically for Next.js 15 (no segment files on S3).
      await generateSegmentFiles(bucket, uri, params, rscData, metadata);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Rendered and cached: ${uri}`,
        key: s3Key,
      }),
      html,
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: `Render failed for ${uri}: ${(err as Error).message}`,
      }),
    };
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeRsc(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}
