import { Telegraf } from 'telegraf';
import https from 'https';
import { config } from '../config.js';

// Force IPv4 to avoid ETIMEDOUT on systems where IPv6 is blocked/unreachable
const agent = new https.Agent({ family: 4 });

/** Singleton Telegraf bot instance shared across the app. */
export const tgBot = new Telegraf(config.telegram.token, {
  telegram: { agent },
});

// Implement an automatic retry mechanism for Telegram API's 429 Rate Limit errors.
// This prevents message drops when Zalo forwards multiple items concurrently.
const originalCallApi = tgBot.telegram.callApi.bind(tgBot.telegram);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
tgBot.telegram.callApi = async function (method: string, payload?: object, options?: any) {
  let attempt = 0;
  while (true) {
    try {
      return await originalCallApi(method, payload, options);
    } catch (err: any) {
      if (err.code === 429 && err.parameters?.retry_after && attempt < 3) {
        attempt++;
        // Telegram retry_after is in seconds
        const waitTime = err.parameters.retry_after * 1000;
        console.warn(`[Telegram API] 429 Rate limit on ${method}. Waiting ${waitTime}ms... (Attempt ${attempt}/3)`);
        await new Promise(r => setTimeout(r, waitTime));
        continue;
      }
      throw err;
    }
  }
};

