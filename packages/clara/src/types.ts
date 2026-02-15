// ── Metadata Types ───────────────────────────────────────────────
// Framework-agnostic metadata types. Covers the full range of HTML
// metadata that modern frameworks (Next.js, etc.) can generate.
// All fields are optional except `title`.

export interface ClaraAuthor {
  name?: string;
  url?: string;
}

export type ClaraReferrer =
  | 'no-referrer'
  | 'origin'
  | 'no-referrer-when-downgrade'
  | 'origin-when-cross-origin'
  | 'same-origin'
  | 'strict-origin'
  | 'strict-origin-when-cross-origin';

// ── Robots ───────────────────────────────────────────────────────

export interface ClaraRobotsInfo {
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

export type ClaraRobots = string | (ClaraRobotsInfo & {
  googleBot?: string | ClaraRobotsInfo;
});

// ── Alternates ───────────────────────────────────────────────────

export interface ClaraAlternateLinkDescriptor {
  title?: string;
  url: string;
}

export interface ClaraAlternateURLs {
  canonical?: string | ClaraAlternateLinkDescriptor;
  languages?: Record<string, string | ClaraAlternateLinkDescriptor[]>;
  media?: Record<string, string | ClaraAlternateLinkDescriptor[]>;
  types?: Record<string, string | ClaraAlternateLinkDescriptor[]>;
}

// ── Icons ────────────────────────────────────────────────────────

export interface ClaraIconDescriptor {
  url: string;
  type?: string;
  sizes?: string;
  color?: string;
  rel?: string;
  media?: string;
  fetchPriority?: 'high' | 'low' | 'auto';
}

export type ClaraIcon = string | ClaraIconDescriptor;

export interface ClaraIcons {
  icon?: ClaraIcon | ClaraIcon[];
  shortcut?: ClaraIcon | ClaraIcon[];
  apple?: ClaraIcon | ClaraIcon[];
  other?: ClaraIconDescriptor | ClaraIconDescriptor[];
}

// ── Open Graph ───────────────────────────────────────────────────

export interface ClaraOGImageDescriptor {
  url: string;
  secureUrl?: string;
  alt?: string;
  type?: string;
  width?: string | number;
  height?: string | number;
}

export type ClaraOGImage = string | ClaraOGImageDescriptor;

export interface ClaraOGAudioDescriptor {
  url: string;
  secureUrl?: string;
  type?: string;
}

export type ClaraOGAudio = string | ClaraOGAudioDescriptor;

export interface ClaraOGVideoDescriptor {
  url: string;
  secureUrl?: string;
  type?: string;
  width?: string | number;
  height?: string | number;
}

export type ClaraOGVideo = string | ClaraOGVideoDescriptor;

export interface ClaraOpenGraphBase {
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
  images?: ClaraOGImage | ClaraOGImage[];
  audio?: ClaraOGAudio | ClaraOGAudio[];
  videos?: ClaraOGVideo | ClaraOGVideo[];
}

export interface ClaraOpenGraphWebsite extends ClaraOpenGraphBase {
  type?: 'website';
}

export interface ClaraOpenGraphArticle extends ClaraOpenGraphBase {
  type: 'article';
  publishedTime?: string;
  modifiedTime?: string;
  expirationTime?: string;
  authors?: string | string[];
  section?: string;
  tags?: string | string[];
}

export interface ClaraOpenGraphBook extends ClaraOpenGraphBase {
  type: 'book';
  isbn?: string;
  releaseDate?: string;
  authors?: string | string[];
  tags?: string | string[];
}

export interface ClaraOpenGraphProfile extends ClaraOpenGraphBase {
  type: 'profile';
  firstName?: string;
  lastName?: string;
  username?: string;
  gender?: string;
}

export interface ClaraOpenGraphMusicSong extends ClaraOpenGraphBase {
  type: 'music.song';
  duration?: number;
  albums?: string | string[];
  musicians?: string | string[];
}

export interface ClaraOpenGraphMusicAlbum extends ClaraOpenGraphBase {
  type: 'music.album';
  songs?: string | string[];
  musicians?: string | string[];
  releaseDate?: string;
}

export interface ClaraOpenGraphMusicPlaylist extends ClaraOpenGraphBase {
  type: 'music.playlist';
  songs?: string | string[];
  creators?: string | string[];
}

export interface ClaraOpenGraphMusicRadioStation extends ClaraOpenGraphBase {
  type: 'music.radio_station';
  creators?: string | string[];
}

export interface ClaraOpenGraphVideoMovie extends ClaraOpenGraphBase {
  type: 'video.movie';
  actors?: string | string[];
  directors?: string | string[];
  writers?: string | string[];
  duration?: number;
  releaseDate?: string;
  tags?: string | string[];
}

export interface ClaraOpenGraphVideoEpisode extends ClaraOpenGraphBase {
  type: 'video.episode';
  actors?: string | string[];
  directors?: string | string[];
  writers?: string | string[];
  duration?: number;
  releaseDate?: string;
  tags?: string | string[];
  series?: string;
}

export interface ClaraOpenGraphVideoTVShow extends ClaraOpenGraphBase {
  type: 'video.tv_show';
}

export interface ClaraOpenGraphVideoOther extends ClaraOpenGraphBase {
  type: 'video.other';
}

export type ClaraOpenGraph =
  | ClaraOpenGraphWebsite
  | ClaraOpenGraphArticle
  | ClaraOpenGraphBook
  | ClaraOpenGraphProfile
  | ClaraOpenGraphMusicSong
  | ClaraOpenGraphMusicAlbum
  | ClaraOpenGraphMusicPlaylist
  | ClaraOpenGraphMusicRadioStation
  | ClaraOpenGraphVideoMovie
  | ClaraOpenGraphVideoEpisode
  | ClaraOpenGraphVideoTVShow
  | ClaraOpenGraphVideoOther;

// ── Twitter ──────────────────────────────────────────────────────

export interface ClaraTwitterImageDescriptor {
  url: string;
  alt?: string;
  secureUrl?: string;
  type?: string;
  width?: string | number;
  height?: string | number;
}

export type ClaraTwitterImage = string | ClaraTwitterImageDescriptor;

export interface ClaraTwitterPlayerDescriptor {
  playerUrl: string;
  streamUrl: string;
  width: number;
  height: number;
}

export interface ClaraTwitterAppDescriptor {
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

export interface ClaraTwitterBase {
  site?: string;
  siteId?: string;
  creator?: string;
  creatorId?: string;
  title?: string;
  description?: string;
  images?: ClaraTwitterImage | ClaraTwitterImage[];
}

export interface ClaraTwitterSummary extends ClaraTwitterBase {
  card: 'summary';
}

export interface ClaraTwitterSummaryLargeImage extends ClaraTwitterBase {
  card: 'summary_large_image';
}

export interface ClaraTwitterPlayer extends ClaraTwitterBase {
  card: 'player';
  players: ClaraTwitterPlayerDescriptor | ClaraTwitterPlayerDescriptor[];
}

export interface ClaraTwitterApp extends ClaraTwitterBase {
  card: 'app';
  app: ClaraTwitterAppDescriptor;
}

export type ClaraTwitter =
  | ClaraTwitterBase
  | ClaraTwitterSummary
  | ClaraTwitterSummaryLargeImage
  | ClaraTwitterPlayer
  | ClaraTwitterApp;

// ── Verification ─────────────────────────────────────────────────

export interface ClaraVerification {
  google?: string | string[];
  yahoo?: string | string[];
  yandex?: string | string[];
  me?: string | string[];
  other?: Record<string, string | string[]>;
}

// ── Apple Web App ────────────────────────────────────────────────

export interface ClaraAppleImageDescriptor {
  url: string;
  media?: string;
}

export type ClaraAppleImage = string | ClaraAppleImageDescriptor;

export interface ClaraAppleWebApp {
  capable?: boolean;
  title?: string;
  startupImage?: ClaraAppleImage | ClaraAppleImage[];
  statusBarStyle?: 'default' | 'black' | 'black-translucent';
}

// ── Format Detection ─────────────────────────────────────────────

export interface ClaraFormatDetection {
  telephone?: boolean;
  date?: boolean;
  address?: boolean;
  email?: boolean;
  url?: boolean;
}

// ── iTunes App ───────────────────────────────────────────────────

export interface ClaraItunesApp {
  appId: string;
  appArgument?: string;
}

// ── Facebook ─────────────────────────────────────────────────────

export interface ClaraFacebook {
  appId?: string;
  admins?: string | string[];
}

// ── Pinterest ────────────────────────────────────────────────────

export interface ClaraPinterest {
  richPin?: string | boolean;
}

// ── App Links ────────────────────────────────────────────────────

export interface ClaraAppLinksApple {
  url: string;
  app_store_id?: string | number;
  app_name?: string;
}

export interface ClaraAppLinksAndroid {
  package: string;
  url?: string;
  class?: string;
  app_name?: string;
}

export interface ClaraAppLinksWindows {
  url: string;
  app_id?: string;
  app_name?: string;
}

export interface ClaraAppLinksWeb {
  url: string;
  should_fallback?: boolean;
}

export interface ClaraAppLinks {
  ios?: ClaraAppLinksApple | ClaraAppLinksApple[];
  iphone?: ClaraAppLinksApple | ClaraAppLinksApple[];
  ipad?: ClaraAppLinksApple | ClaraAppLinksApple[];
  android?: ClaraAppLinksAndroid | ClaraAppLinksAndroid[];
  windows_phone?: ClaraAppLinksWindows | ClaraAppLinksWindows[];
  windows?: ClaraAppLinksWindows | ClaraAppLinksWindows[];
  windows_universal?: ClaraAppLinksWindows | ClaraAppLinksWindows[];
  web?: ClaraAppLinksWeb | ClaraAppLinksWeb[];
}

// ── Main Metadata Interface ──────────────────────────────────────

/** Metadata returned by a route's metaDataGenerator function. */
export interface ClaraMetadata {
  // Basic metadata
  title: string;
  description?: string;
  applicationName?: string;
  authors?: ClaraAuthor | ClaraAuthor[];
  generator?: string;
  keywords?: string | string[];
  referrer?: ClaraReferrer;
  creator?: string;
  publisher?: string;
  category?: string;
  classification?: string;
  abstract?: string;

  // Robots
  robots?: ClaraRobots;

  // Alternates (canonical, hreflang, etc.)
  alternates?: ClaraAlternateURLs;

  // Icons
  icons?: string | ClaraIcon[] | ClaraIcons;

  // Open Graph
  openGraph?: ClaraOpenGraph;

  // Twitter
  twitter?: ClaraTwitter;

  // Verification
  verification?: ClaraVerification;

  // Apple
  appleWebApp?: boolean | ClaraAppleWebApp;

  // Format detection
  formatDetection?: ClaraFormatDetection;

  // iTunes
  itunes?: ClaraItunesApp;

  // Facebook
  facebook?: ClaraFacebook;

  // Pinterest
  pinterest?: ClaraPinterest;

  // App links
  appLinks?: ClaraAppLinks;

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
  /** Env var names to forward to the renderer Lambda (values read from process.env at build time) */
  env?: string[];
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
  /** Environment variables for the renderer Lambda (key-value pairs resolved at build time) */
  env?: Record<string, string>;
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
