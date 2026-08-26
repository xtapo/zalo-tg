import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Root của project (src/../) */
const PROJECT_ROOT = path.resolve(__dirname, '..');

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function resolvePath(envVal: string | undefined, defaultRelative: string): string {
  const raw = envVal ?? defaultRelative;
  // Already absolute → use as-is, otherwise resolve from project root
  return path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
}

export const config = {
  telegram: {
    token:   requireEnv('TG_TOKEN'),
    groupId: Number(requireEnv('TG_GROUP_ID')),
  },
  zalo: {
    credentialsPath: resolvePath(process.env.ZALO_CREDENTIALS_PATH, 'credentials.json'),
  },
  dataDir: resolvePath(process.env.DATA_DIR, 'data'),
  web: {
    /** Port for the management dashboard. Set WEB_PORT to override (default 3000). */
    port: Number(process.env.WEB_PORT ?? 3002),
  },
} as const;
