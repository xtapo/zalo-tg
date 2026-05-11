import { Telegraf } from 'telegraf';
import https from 'https';
import { config } from '../config.js';

// Force IPv4 to avoid ETIMEDOUT on systems where IPv6 is blocked/unreachable
const agent = new https.Agent({ family: 4 });

/** Singleton Telegraf bot instance shared across the app. */
export const tgBot = new Telegraf(config.telegram.token, {
  telegram: { agent },
});

// Automatic retry for Telegram API errors:
// - 429 Rate Limit: wait the requested retry_after duration
// - Network errors (ETIMEDOUT, ECONNRESET, etc.): exponential backoff
const RETRYABLE_NETWORK_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND',
  'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
]);
const MAX_RETRIES = 3;

const originalCallApi = tgBot.telegram.callApi.bind(tgBot.telegram);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
tgBot.telegram.callApi = async function (method: string, payload?: object, options?: any) {
  let attempt = 0;
  while (true) {
    try {
      return await originalCallApi(method, payload, options);
    } catch (err: any) {
      const code: string | undefined = err.code ?? err.errno;

      // 429 Rate Limit — use Telegram's retry_after
      if (err.code === 429 && err.parameters?.retry_after && attempt < MAX_RETRIES) {
        attempt++;
        const waitTime = err.parameters.retry_after * 1000;
        console.warn(`[Telegram API] 429 Rate limit on ${method}. Waiting ${waitTime}ms... (Attempt ${attempt}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, waitTime));
        continue;
      }

      // Network errors — exponential backoff (2s, 4s, 8s)
      const isNetworkError =
        (code && RETRYABLE_NETWORK_CODES.has(code)) ||
        /socket hang up|network/.test(err.message ?? '');

      if (isNetworkError && attempt < MAX_RETRIES) {
        attempt++;
        const waitTime = 2000 * Math.pow(2, attempt - 1); // 2s, 4s, 8s
        console.warn(`[Telegram API] Network error (${code ?? 'unknown'}) on ${method}. Retrying in ${waitTime}ms... (Attempt ${attempt}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, waitTime));
        continue;
      }

      throw err;
    }
  }
};

