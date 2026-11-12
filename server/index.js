import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { openStore } from './store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  // No .env file: use the real environment, as in production.
}

const env = process.env;
const port = Number(env.PORT || 8787);
const store = openStore(env.DATABASE_PATH || path.join(root, 'data.sqlite'));
const server = createApp({
  store,
  appId: env.MOONETIX_APP_ID,
  linkSalt: env.MOONETIX_LINK_SALT,
  postbackKey: env.MOONETIX_POSTBACK_KEY,
  creditTestPostbacks: env.MOONETIX_CREDIT_TEST_POSTBACKS === 'true',
  secureCookies: env.COOKIE_SECURE !== 'false',
  staticDir: path.join(root, 'dist'),
});

for (const name of ['MOONETIX_APP_ID', 'MOONETIX_LINK_SALT', 'MOONETIX_POSTBACK_KEY']) {
  if (!env[name]) console.warn(`${name} is not set. See .env.example.`);
}

server.listen(port, env.HOST || '127.0.0.1', () => {
  console.log(`API and app on http://${env.HOST || '127.0.0.1'}:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => {
    store.close();
    process.exit(0);
  }));
}
