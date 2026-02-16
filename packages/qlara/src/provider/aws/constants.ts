/** Query parameter added by the renderer to prevent infinite edge handler loops */
export const QLARA_BYPASS_PARAM = '__qlara_bypass';

/** S3 key for the Qlara manifest file */
export const MANIFEST_KEY = 'qlara-manifest.json';

/** S3 key for the SPA fallback */
export const INDEX_HTML_KEY = 'index.html';

/** Prefix for CloudFormation stack names */
export const STACK_NAME_PREFIX = 'qlara';

/** Directory for Qlara local state */
export const QLARA_DIR = '.qlara';

/** File name for cached infrastructure resources */
export const RESOURCES_FILE = 'resources.json';
