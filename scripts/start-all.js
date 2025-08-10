// C:\Users\Станислав\Desktop\code\taskboard\scripts\start-all.js
// Node.js 20+, CommonJS

const { spawn } = require('child_process');
const path = require('path');
const ngrok = require('ngrok');
const waitOn = require('wait-on');

const ROOT = path.resolve(__dirname, '..');
const SERVER_CWD = path.join(ROOT, 'server');
const CLIENT_CWD = path.join(ROOT, 'client');

const API_PORT = 4000;
const FRONT_PORT = 5173;

function run(cmd, args, opts = {}) {
  return spawn(cmd, args, { stdio: 'inherit', shell: true, ...opts });
}

async function waitTcp(port, timeout = 60000) {
  await waitOn({ resources: [`tcp:${port}`], timeout });
}

async function connectNgrokWithRetry(port, tries = 10, delayMs = 1200) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const url = await ngrok.connect({ addr: port, proto: 'http' });
      return url;
    } catch (err) {
      lastErr = err;
      console.log(`⏳ ngrok не готов (попытка ${i}/${tries}) — жду ${delayMs}мс`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr ?? new Error(`ngrok не стартовал на порту ${port}`);
}

(async () => {
  let serverProc, clientProc;
  try {
    // 1) server
    console.log('▶ Запускаю сервер…');
    serverProc = run('npm', ['run', 'dev'], { cwd: SERVER_CWD });

    await waitTcp(API_PORT);
    console.log(`✔ API поднят: tcp:${API_PORT}`);

    // 2) ngrok API
    console.log(`▶ Поднимаю ngrok для API (${API_PORT})…`);
    const apiUrl = await connectNgrokWithRetry(API_PORT);
    console.log('🌐 NGROK API URL:', apiUrl);

    // 3) client с пробросом VITE_API_URL
    console.log('▶ Запускаю фронт…');
    const clientEnv = { ...process.env, VITE_API_URL: apiUrl };
    // Скрипт в client/package.json: "dev": "vite --host --port 5173"
    clientProc = run('npm', ['run', 'dev'], { cwd: CLIENT_CWD, env: clientEnv });

    await waitTcp(FRONT_PORT);
    console.log(`✔ Front поднят: tcp:${FRONT_PORT}`);

    // 4) ngrok FRONT
    console.log(`▶ Поднимаю ngrok для фронта (${FRONT_PORT})…`);
    const webUrl = await connectNgrokWithRetry(FRONT_PORT);
    console.log('🌐 NGROK FRONT URL:', webUrl);

    console.log('\n================ READY ================');
    console.log('Отдай друзьям ссылку на ФРОНТ:', webUrl);
    console.log('Фронт ходит к API по:', apiUrl);
    console.log('Не закрывай это окно — пока оно открыто, ссылки работают.');
    console.log('=======================================\n');

    const shutdown = async () => {
      try { await ngrok.kill(); } catch {}
      try { serverProc && serverProc.kill(); } catch {}
      try { clientProc && clientProc.kill(); } catch {}
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error('❌ Ошибка старта:', err);
    try { await ngrok.kill(); } catch {}
    try { serverProc && serverProc.kill(); } catch {}
    try { clientProc && clientProc.kill(); } catch {}
    process.exit(1);
  }
})();
