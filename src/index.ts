import { getZaloApi } from './zalo/client.js';
import { setupZaloHandler } from './zalo/handler.js';
import { tgBot } from './telegram/bot.js';
import { setupTelegramHandler } from './telegram/handler.js';
import { config } from './config.js';
import { startWebServer, type BridgeStatus } from './web/server.js';

// ── Live bridge status (surfaced by the management dashboard) ────────────────

const bridgeStatus: BridgeStatus = {
  zaloConnected: false,
  telegramConnected: false,
  zaloName: undefined,
  startedAt: Date.now(),
};

// ── Boot Zalo (also used when /login swaps in a fresh API) ───────────────────

async function startZalo(api: Awaited<ReturnType<typeof getZaloApi>>): Promise<void> {
  setupZaloHandler(api);
  api.listener.start();
  bridgeStatus.zaloConnected = true;
  // Best-effort: capture the logged-in account's display name for the dashboard.
  try {
    const info = await api.fetchAccountInfo?.();
    const name = info?.profile?.displayName ?? info?.displayName;
    if (name) bridgeStatus.zaloName = String(name);
  } catch { /* non-fatal */ }
  console.log('[Boot] Zalo listener started ✓');
}

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   Zalo ↔ Telegram Bridge  v1.0.0    ║');
  console.log('╚══════════════════════════════════════╝');

  // ── Wire up Telegram handler BEFORE launching the bot ─────────────────────
  // setupTelegramHandler returns a setter to inject the Zalo API after auto-login.
  const setZaloApi = setupTelegramHandler(null, async (newApi) => {
    await startZalo(newApi);
  });

  // ── Register bot commands for Telegram menu ───────────────────────────────
  tgBot.telegram.setMyCommands([
    { command: 'login',          description: 'Đăng nhập Zalo qua QR code' },
    { command: 'search',         description: 'Tìm bạn bè / nhóm Zalo để tạo topic' },
    { command: 'addfriend',      description: 'Tìm & kết bạn Zalo theo số điện thoại' },
    { command: 'addgroup',       description: 'Tạo topic cho nhóm Zalo chưa có topic' },
    { command: 'joingroup',      description: 'Tham gia nhóm Zalo qua link' },
    { command: 'friendrequests', description: 'Xem lời mời kết bạn & lời mời nhóm' },
    { command: 'topic',          description: 'Quản lý topic: list / info / delete' },
    { command: 'recall',         description: 'Thu hồi tin nhắn (reply vào tin đã gửi)' },
  ]).catch(() => undefined);

  // ── Start Telegram bot so /login can be received immediately ───────────────
  let launchAttempts = 0;
  const maxLaunchRetries = 5;
  const retryDelayMs = 2000;
  let isZaloLoginStarted = false;

  const launchTelegramBot = () => {
    launchAttempts++;
    
    // NOTE: tgBot.launch() runs the polling loop forever, so we must NOT await it.
    // The second argument callback fires once getMe() + deleteWebhook() succeed.
    tgBot.launch({ allowedUpdates: ['message', 'callback_query', 'message_reaction', 'poll_answer', 'poll'] }, () => {
      if (!isZaloLoginStarted) {
        isZaloLoginStarted = true;
        bridgeStatus.telegramConnected = true;
        console.log('[Boot] Telegram bot started ✓');

        // ── Attempt Zalo login in background ────────────────────────────────────
        // If credentials.json exists → connects automatically and updates currentApi.
        // If not → notifies the user to run /login.
        getZaloApi()
          .then(async (api) => {
            setZaloApi(api);   // ← inject into Telegram handler so TG→Zalo works
            await startZalo(api);
          })
          .catch((err: unknown) => {
            console.warn('[Boot] Zalo auto-login failed:', err);
            tgBot.telegram
              .sendMessage(
                config.telegram.groupId,
                '⚠️ Chưa đăng nhập Zalo. Gửi <b>/login</b> để đăng nhập.',
                { parse_mode: 'HTML' },
              )
              .catch(() => undefined);
          });
      } else {
        console.log(`[Boot] Telegram bot re-started (after conflict retry) ✓`);
      }
    }).catch(async (err: any) => {
      const isConflict = err?.code === 409 || err?.response?.error_code === 409 || String(err).includes('409') || String(err).includes('Conflict');
      if (isConflict) {
        const hasPolled = (tgBot as any).hasPolledSuccessfully === true;
        if (!hasPolled && launchAttempts <= maxLaunchRetries) {
          console.warn(`\n⚠️ [Boot] Telegram bot polling conflict (409) during startup. Retrying in ${retryDelayMs}ms... (Attempt ${launchAttempts}/${maxLaunchRetries})`);
          await new Promise(resolve => setTimeout(resolve, retryDelayMs));
          launchTelegramBot();
        } else {
          console.warn('\n⚠️ [Boot] Telegram bot polling terminated: 409 Conflict (another instance is running). Exiting gracefully.');
          process.exit(0);
        }
      } else {
        console.error('\n❌ [Boot] Telegram bot polling failed:', err);
        process.exit(1);
      }
    });
  };

  launchTelegramBot();

  // ── Start the management dashboard ─────────────────────────────────────────
  startWebServer({ getStatus: () => bridgeStatus }, config.web.port);

  console.log('[Boot] Bridge is running 🚀  (Ctrl+C to stop)');

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = (signal: string) => {
    console.log(`\n[Boot] Received ${signal}, shutting down...`);
    try { getZaloApi().then(api => api.listener.stop()).catch(() => undefined); } catch { /* ignore */ }
    tgBot.stop(signal);
    process.exit(0);
  };

  process.once('SIGINT',  () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('[Boot] Fatal error:', err);
  process.exit(1);
});

