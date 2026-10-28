import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, json, html, send, parseCookies, clientIp } from './http.js';
import { HttpError } from './errors.js';
import { Store } from './store.js';
import { AuthService } from './auth.js';
import { PackageService } from './packages.js';
import { registerApi } from './api.js';
import { registerWeb } from './web.js';
import { layout, errorPage } from './views.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');
const VERSION = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;
const MIME = { '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

export function createApp(config, { clock = Date.now } = {}) {
  const store = new Store(config.dataDir);
  const auth = new AuthService({ store, config, clock });
  const packages = new PackageService({ store, config, clock });
  const router = new Router();
  registerApi(router, { auth, packages, config, version: VERSION });
  registerWeb(router, { auth, packages, config });

  router.get('/static/:file', (ctx) => {
    const file = path.basename(ctx.params.file);
    const full = path.join(PUBLIC, file);
    if (!MIME[path.extname(file)] || !fs.existsSync(full)) throw new HttpError(404, 'not_found', 'Not found.');
    send(ctx.res, 200, fs.readFileSync(full), { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'public, max-age=3600' });
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const isApi = url.pathname.startsWith('/api/');
    const ctx = {
      req, res, url, ip: clientIp(req, config.trustProxy), cookies: parseCookies(req.headers.cookie), params: {}, outCookies: [],
    };
    ctx.setCookie = (c) => ctx.outCookies.push(c);
    const writeHead = res.writeHead.bind(res);
    res.writeHead = (status, headers = {}) => {
      if (ctx.outCookies.length && !headers['Set-Cookie']) headers = { ...headers, 'Set-Cookie': ctx.outCookies };
      return writeHead(status, headers);
    };
    try {
      // Cross-site browser requests to the JSON API are refused outright.
      if (isApi && req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'cross_site', 'Cross-site requests are not allowed.');
      const m = router.match(req.method, url.pathname);
      if (!m) throw new HttpError(404, 'not_found', 'Not found.');
      ctx.params = m.params;
      await m.handler(ctx);
    } catch (err) {
      if (res.headersSent) return res.destroy();
      const e = err instanceof HttpError ? err : new HttpError(500, 'internal', 'Something went wrong.');
      if (!(err instanceof HttpError)) console.error(err);
      if (isApi) json(res, e.status, { error: e.code, message: e.message, ...e.extra });
      else html(res, e.status, layout({ title: String(e.status), body: errorPage({ status: e.status, message: e.message }) }));
    }
  }

  const server = http.createServer(handle);
  return { server, store, auth, packages, config, version: VERSION };
}
