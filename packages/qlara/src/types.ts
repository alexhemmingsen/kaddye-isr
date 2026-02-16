// ── Metadata Types ───────────────────────────────────────────────
// Framework-agnostic metadata types. Covers the full range of HTML
// metadata that modern frameworks (Next.js, etc.) can generate.
// All fields are optional except `title`.

export interface QlaraAuthor {
  name?: string;
  url?: string;
}

export type QlaraReferrer =
  | 'no-referrer'
  | 'origin'
  | 'no-referrer-when-downgrade'
  | 'origin-when-cross-origin'
  | 'same-origin'
  | 'strict-origin'
  | 'strict-origin-when-cross-origin';

// ── Robots ───────────────────────────────────────────────────────

export interface QlaraRobotsInfo {
  index?: boolean;
  follow?: boolean;
  noarchive?: boolean;
  nosnippet?: boolean;
  noimageindex?: boolean;
  nocache?: boolean;
  notranslate?: boolean;
  indexifembedded?: boolean;
  nositelinkssearchbox?: boolean;
  unavailable_after?: string;
  'max-video-preview'?: number | string;
  'max-image-preview'?: 'none' | 'standard' | 'large';
  'max-snippet'?: number;
}

export type QlaraRobots = string | (QlaraRobotsInfo & {
  googleBot?: string | QlaraRobotsInfo;
});

// ── Alternates ───────────────────────────────────────────────────

export interface QlaraAlternateLinkDescriptor {
  title?: string;
  url: string;
}

export interface QlaraAlternateURLs {
  canonical?: string | QlaraAlternateLinkDescriptor;
  languages?: Record<string, string | QlaraAlternateLinkDescriptor[]>;
  media?: Record<string, string | QlaraAlternateLinkDescriptor[]>;
  types?: Record<string, string | QlaraAlternateLinkDescriptor[]>;
}

// ── Icons ────────────────────────────────────────────────────────

export interface QlaraIconDescriptor {
  url: string;
  type?: string;
  sizes?: string;
  color?: string;
  rel?: string;
  media?: string;
  fetchPriority?: 'high' | 'low' | 'auto';
}

export type QlaraIcon = string | QlaraIconDescriptor;

export interface QlaraIcons {
  icon?: QlaraIcon | QlaraIcon[];
  shortcut?: QlaraIcon | QlaraIcon[];
  apple?: QlaraIcon | QlaraIcon[];
  other?: QlaraIconDescriptor | QlaraIconDescriptor[];
}

// ── Open Graph ───────────────────────────────────────────────────

export interface QlaraOGImageDescriptor {
  url: string;
  secureUrl?: string;
  alt?: string;
  type?: string;
  width?: string | number;
  height?: string | number;
}

export type QlaraOGImage = string | QlaraOGImageDescriptor;

export interface QlaraOGAudioDescriptor {
  url: string;
  secureUrl?: string;
  type?: string;
}

export type QlaraOGAudio = string | QlaraOGAudioDescriptor;

export interface QlaraOGVideoDescriptor {
  url: string;
  secureUrl?: string;
  type?: string;
  width?: string | number;
  height?: string | number;
}

export type QlaraOGVideo = string | QlaraOGVideoDescriptor;

export interface QlaraOpenGraphBase {
  title?: string;
  description?: string;
  url?: string;
  siteName?: string;
  locale?: string;
  alternateLocale?: string | string[];
  determiner?: 'a' | 'an' | 'the' | 'auto' | '';
  emails?: string | string[];
  phoneNumbers?: string | string[];
  faxNumbers?: string | string[];
  countryName?: string;
  ttl?: number;
  images?: QlaraOGImage | QlaraOGImage[];
  audio?: QlaraOGAudio | QlaraOGAudio[];
  videos?: QlaraOGVideo | QlaraOGVideo[];
}

export interface QlaraOpenGraphWebsite extends QlaraOpenGraphBase {
  type?: 'website';
}

export interface QlaraOpenGraphArticle extends QlaraOpenGraphBase {
  type: 'article';
  publishedTime?: string;
  modifiedTime?: string;
  expirationTime?: string;
  authors?: string | string[];
  section?: string;
  tags?: string | string[];
}

export interface QlaraOpenGraphBook extends QlaraOpenGraphBase {
  type: 'book';
  isbn?: string;
  releaseDate?: string;
  authors?: string | string[];
  tags?: string | string[];
}

export interface QlaraOpenGraphProfile extends QlaraOpenGraphBase {
  type: 'profile';
  firstName?: string;
  lastName?: string;
  username?: string;
  gender?: string;
}

export interface QlaraOpenGraphMusicSong extends QlaraOpenGraphBase {
  type: 'music.song';
  duration?: number;
  albums?: string | string[];
  musicians?: string | string[];
}

export interface QlaraOpenGraphMusicAlbum extends QlaraOpenGraphBase {
  type: 'music.album';
  songs?: string | string[];
  musicians?: string | string[];
  releaseDate?: string;
}

export interface QlaraOpenGraphMusicPlaylist extends QlaraOpenGraphBase {
  type: 'music.playlist';
  songs?: string | string[];
  creators?: string | string[];
}

export interface QlaraOpenGraphMusicRadioStation extends QlaraOpenGraphBase {
  type: 'music.radio_station';
  creators?: string | string[];
}

export interface QlaraOpenGraphVideoMovie extends QlaraOpenGraphBase {
  type: 'video.movie';
  actors?: string | string[];
  directors?: string | string[];
  writers?: string | string[];
  duration?: number;
  releaseDate?: string;
  tags?: string | string[];
}

export interface QlaraOpenGraphVideoEpisode extends QlaraOpenGraphBase {
  type: 'video.episode';
  actors?: string | string[];
  directors?: string | string[];
  writers?: string | string[];
  duration?: number;
  releaseDate?: string;
  tags?: string | string[];
  series?: string;
}

export interface QlaraOpenGraphVideoTVShow extends QlaraOpenGraphBase {
  type: 'video.tv_show';
}

export interface QlaraOpenGraphVideoOther extends QlaraOpenGraphBase {
  type: 'video.other';
}

export type QlaraOpenGraph =
  | QlaraOpenGraphWebsite
  | QlaraOpenGraphArticle
  | QlaraOpenGraphBook
  | QlaraOpenGraphProfile
  | QlaraOpenGraphMusicSong
  | QlaraOpenGraphMusicAlbum
  | QlaraOpenGraphMusicPlaylist
  | QlaraOpenGraphMusicRadioStation
  | QlaraOpenGraphVideoMovie
  | QlaraOpenGraphVideoEpisode
  | QlaraOpenGraphVideoTVShow
  | QlaraOpenGraphVideoOther;

// ── Twitter ──────────────────────────────────────────────────────

export interface QlaraTwitterImageDescriptor {
  url: string;
  alt?: string;
  secureUrl?: string;
  type?: string;
  width?: string | number;
  height?: string | number;
}

export type QlaraTwitterImage = string | QlaraTwitterImageDescriptor;

export interface QlaraTwitterPlayerDescriptor {
  playerUrl: string;
  streamUrl: string;
  width: number;
  height: number;
}

export interface QlaraTwitterAppDescriptor {
  id: {
    iphone?: string | number;
    ipad?: string | number;
    googleplay?: string;
  };
  url?: {
    iphone?: string;
    ipad?: string;
    googleplay?: string;
  };
  name?: string;
}

export interface QlaraTwitterBase {
  site?: string;
  siteId?: string;
  creator?: string;
  creatorId?: string;
  title?: string;
  description?: string;
  images?: QlaraTwitterImage | QlaraTwitterImage[];
}

export interface QlaraTwitterSummary extends QlaraTwitterBase {
  card: 'summary';
}

export interface QlaraTwitterSummaryLargeImage extends QlaraTwitterBase {
  card: 'summary_large_image';
}

export interface QlaraTwitterPlayer extends QlaraTwitterBase {
  card: 'player';
  players: QlaraTwitterPlayerDescriptor | QlaraTwitterPlayerDescriptor[];
}

export interface QlaraTwitterApp extends QlaraTwitterBase {
  card: 'app';
  app: QlaraTwitterAppDescriptor;
}

export type QlaraTwitter =
  | QlaraTwitterBase
  | QlaraTwitterSummary
  | QlaraTwitterSummaryLargeImage
  | QlaraTwitterPlayer
  | QlaraTwitterApp;

// ── Verification ─────────────────────────────────────────────────

export interface QlaraVerification {
  google?: string | string[];
  yahoo?: string | string[];
  yandex?: string | string[];
  me?: string | string[];
  other?: Record<string, string | string[]>;
}

// ── Apple Web App ────────────────────────────────────────────────

export interface QlaraAppleImageDescriptor {
  url: string;
  media?: string;
}

export type QlaraAppleImage = string | QlaraAppleImageDescriptor;

export interface QlaraAppleWebApp {
  capable?: boolean;
  title?: string;
  startupImage?: QlaraAppleImage | QlaraAppleImage[];
  statusBarStyle?: 'default' | 'black' | 'black-translucent';
}

// ── Format Detection ─────────────────────────────────────────────

export interface QlaraFormatDetection {
  telephone?: boolean;
  date?: boolean;
  address?: boolean;
  email?: boolean;
  url?: boolean;
}

// ── iTunes App ───────────────────────────────────────────────────

export interface QlaraItunesApp {
  appId: string;
  appArgument?: string;
}

// ── Facebook ─────────────────────────────────────────────────────

export interface QlaraFacebook {
  appId?: string;
  admins?: string | string[];
}

// ── Pinterest ────────────────────────────────────────────────────

export interface QlaraPinterest {
  richPin?: string | boolean;
}

// ── App Links ────────────────────────────────────────────────────

export interface QlaraAppLinksApple {
  url: string;
  app_store_id?: string | number;
  app_name?: string;
}

export interface QlaraAppLinksAndroid {
  package: string;
  url?: string;
  class?: string;
  app_name?: string;
}

export interface QlaraAppLinksWindows {
  url: string;
  app_id?: string;
  app_name?: string;
}

export interface QlaraAppLinksWeb {
  url: string;
  should_fallback?: boolean;
}

export interface QlaraAppLinks {
  ios?: QlaraAppLinksApple | QlaraAppLinksApple[];
  iphone?: QlaraAppLinksApple | QlaraAppLinksApple[];
  ipad?: QlaraAppLinksApple | QlaraAppLinksApple[];
  android?: QlaraAppLinksAndroid | QlaraAppLinksAndroid[];
  windows_phone?: QlaraAppLinksWindows | QlaraAppLinksWindows[];
  windows?: QlaraAppLinksWindows | QlaraAppLinksWindows[];
  windows_universal?: QlaraAppLinksWindows | QlaraAppLinksWindows[];
  web?: QlaraAppLinksWeb | QlaraAppLinksWeb[];
}

// ── Main Metadata Interface ──────────────────────────────────────

/** Metadata returned by a route's metaDataGenerator function. */
export interface QlaraMetadata {
  // Basic metadata
  title: string;
  description?: string;
  applicationName?: string;
  authors?: QlaraAuthor | QlaraAuthor[];
  generator?: string;
  keywords?: string | string[];
  referrer?: QlaraReferrer;
  creator?: string;
  publisher?: string;
  category?: string;
  classification?: string;
  abstract?: string;

  // Robots
  robots?: QlaraRobots;

  // Alternates (canonical, hreflang, etc.)
  alternates?: QlaraAlternateURLs;

  // Icons
  icons?: string | QlaraIcon[] | QlaraIcons;

  // Open Graph
  openGraph?: QlaraOpenGraph;

  // Twitter
  twitter?: QlaraTwitter;

  // Verification
  verification?: QlaraVerification;

  // Apple
  appleWebApp?: boolean | QlaraAppleWebApp;

  // Format detection
  formatDetection?: QlaraFormatDetection;

  // iTunes
  itunes?: QlaraItunesApp;

  // Facebook
  facebook?: QlaraFacebook;

  // Pinterest
  pinterest?: QlaraPinterest;

  // App links
  appLinks?: QlaraAppLinks;

  // Web app manifest
  manifest?: string;

  // Link tags
  archives?: string | string[];
  assets?: string | string[];
  bookmarks?: string | string[];

  // Pagination
  pagination?: {
    previous?: string;
    next?: string;
  };

  // Catch-all for custom meta tags
  other?: Record<string, string | number | (string | number)[]>;
}

/**
 * Function that fetches data for a dynamic route and returns metadata.
 * Equivalent to Next.js `generateMetadata()` — runs in the renderer Lambda
 * with access to the data source.
 *
 * @param params - The route parameters, e.g. { id: '42' } for /product/:id
 * @returns Metadata for the page, or null if the page doesn't exist
 */
export type QlaraMetaDataGenerator = (params: Record<string, string>) => Promise<QlaraMetadata | null>;

/** A single route definition with its pattern and metadata generator. */
export interface QlaraRouteDefinition {
  /** Dynamic route pattern, e.g. '/product/:id' */
  route: string;
  /** Function that fetches metadata for this route from the data source */
  metaDataGenerator: QlaraMetaDataGenerator;
}

/**
 * The route file default export type: an array of route definitions.
 *
 * Example:
 * ```typescript
 * import type { QlaraRoutes } from 'qlara';
 * const routes: QlaraRoutes = [
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
export type QlaraRoutes = QlaraRouteDefinition[];

export interface QlaraRoute {
  /** Dynamic route pattern, e.g. '/product/:id' */
  pattern: string;
}

export interface QlaraPluginConfig {
  /**
   * Path to a file that defines dynamic routes and their metadata generators.
   * Each entry has a `route` pattern and a `metaDataGenerator` function.
   *
   * The file should `export default` a `QlaraRoutes` array.
   * Route patterns are extracted from the `route` properties automatically.
   *
   * Example: `'./qlara.routes.ts'`
   */
  routeFile: string;
  provider: QlaraProvider;
  /** Env var names to forward to the renderer Lambda (values read from process.env at build time) */
  env?: string[];
}

export interface QlaraProvider {
  name: string;
  /** The serializable config passed to the provider factory (e.g. { region: 'eu-west-1' }) */
  config: Record<string, unknown>;
  setup(config: QlaraDeployConfig): Promise<ProviderResources>;
  deploy(config: QlaraDeployConfig, resources: ProviderResources): Promise<void>;
  exists(config: QlaraDeployConfig): Promise<ProviderResources | null>;
  teardown(resources: ProviderResources): Promise<void>;
}

export interface ProviderResources {
  provider: string;
  [key: string]: unknown;
}

/** Serialized config written to .qlara/config.json by the build plugin. Read by `qlara deploy`. */
export interface QlaraDeployConfig {
  routes: QlaraRoute[];
  provider: {
    name: string;
    [key: string]: unknown;
  };
  outputDir: string;
  /** Absolute path to the route file. Bundled into the renderer Lambda at deploy time. */
  routeFile: string;
  /** Environment variables for the renderer Lambda (key-value pairs resolved at build time) */
  env?: Record<string, string>;
}

export interface QlaraManifest {
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
