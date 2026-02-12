/** Query parameter added by the renderer to prevent infinite edge handler loops */
export const CLARA_BYPASS_PARAM = '__clara_bypass';

/** S3 key for the Clara manifest file */
export const MANIFEST_KEY = 'clara-manifest.json';

/** S3 key for the SPA fallback */
export const INDEX_HTML_KEY = 'index.html';

/** Prefix for CloudFormation stack names */
export const STACK_NAME_PREFIX = 'clara';

/** Directory for Clara local state */
export const CLARA_DIR = '.clara';

/** File name for cached infrastructure resources */
export const RESOURCES_FILE = 'resources.json';
