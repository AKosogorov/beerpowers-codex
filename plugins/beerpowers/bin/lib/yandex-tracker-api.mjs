// Читает настройки Яндекс Трекера и обращается к его API.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const issueKey = /^[A-Z][A-Z0-9_]*-[0-9]+$/;

export function connection() {
  const endpoint = new URL(process.env.YANDEX_TRACKER_API_HOST || 'https://api.tracker.yandex.net');
  const fixture = endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if ((!fixture && endpoint.origin !== 'https://api.tracker.yandex.net') ||
      endpoint.pathname !== '/' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error('Expected the Yandex Tracker API origin or a literal loopback fixture');
  const version = process.env.YANDEX_TRACKER_API_VERSION || 'v2';
  if (!/^v[23]$/.test(version)) throw new Error('Expected Tracker API v2 or v3');
  // Local stubs use fixed synthetic data, regardless of personal settings.
  const cfg = fixture ? {token:'fixture', orgId:'fixture', orgType:process.env.YANDEX_TRACKER_ORG_TYPE} :
    {token:process.env.YANDEX_TRACKER_TOKEN, orgId:process.env.YANDEX_TRACKER_ORG_ID,
      orgType:process.env.YANDEX_TRACKER_ORG_TYPE};
  if (!fixture) {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    for (const dir of [path.resolve('.codex'), home]) {
      if (cfg.token && cfg.orgId && cfg.orgType) break;
      const file = path.join(dir, 'yandex-tracker-settings.json');
      let local;
      try { local = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
      catch (err) { if (err.code === 'ENOENT') continue; throw new Error('Invalid Yandex Tracker settings'); }
      for (const key of Object.keys(cfg)) if (!cfg[key] && typeof local[key] === 'string') cfg[key] = local[key];
    }
  }
  if (cfg.orgType && !['cloud', 'yandex360'].includes(cfg.orgType)) throw new Error('Invalid Tracker orgType');
  let header = cfg.orgType === 'yandex360' ? 'X-Org-ID' : 'X-Cloud-Org-ID';
  let probed = Boolean(cfg.orgType);
  async function request(method, address, body, attachmentHop = false) {
    if (!cfg.token || !cfg.orgId) throw new Error('Tracker unavailable: configure YANDEX_TRACKER_TOKEN and YANDEX_TRACKER_ORG_ID');
    const url = new URL(address, endpoint);
    if (url.origin !== endpoint.origin || url.username || url.password)
      throw new Error('Unexpected attachment origin');
    const headers = {Authorization:'OAuth ' + cfg.token, [header]:cfg.orgId};
    const options = {method, headers, redirect:attachmentHop ? 'manual' : 'error', signal:AbortSignal.timeout(30000)};
    if (body instanceof FormData) options.body = body;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const res = await fetch(url, options);
    if (!probed && method === 'GET') {
      probed = true;
      if ([401,403].includes(res.status)) {
        await res.body?.cancel();
        header = 'X-Org-ID';
        return request(method, address, body, attachmentHop);
      }
    }
    if (!res.ok && !(attachmentHop && [301,302,303,307,308].includes(res.status))) {
      await res.body?.cancel();
      throw new Error('Tracker unavailable: HTTP ' + res.status + ' (' + method + ')');
    }
    return res;
  }
  async function api(method, route, body) {
    if (method !== 'GET' && !probed) await api('GET','/myself');
    const res = await request(method, '/' + version + route, body);
    const value = await res.text();
    if (!value) return null;
    try { return JSON.parse(value); }
    catch { throw new Error('Invalid JSON response from Yandex Tracker'); }
  }
  async function attachment(address) {
    let url = new URL(address, endpoint);
    for (let hop = 0; hop < 6; hop++) {
      if (url.username || url.password) throw new Error('Unexpected attachment URL');
      let response;
      if (url.origin === endpoint.origin) {
        response = await request('GET',url,undefined,true);
      } else {
        // OAuth belongs to Tracker. Signed storage links carry their own access.
        const storage = /(^|\.)(?:storage\.yandexcloud\.net|yandex\.net|yandex\.ru)$/i.test(url.hostname);
        if (fixture || !storage || url.protocol !== 'https:' || url.port) throw new Error('Unexpected attachment origin');
        response = await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(30000)});
      }
      if (response.ok) return response;
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (![301,302,303,307,308].includes(response.status) || !location)
        throw new Error('Tracker attachment unavailable: HTTP ' + response.status);
      url = new URL(location,url);
    }
    throw new Error('Too many Tracker attachment redirects');
  }
  return {api, endpoint:endpoint.origin, version, orgId:cfg.orgId || '', orgType:cfg.orgType || '',
    attachment};
}
