/**
 * Decrypts and fetches cricmad's own live event/channel list.
 *
 * Found by decompiling Egidepage_TV_v15.0.01.apk (package com.cricmadbd.app):
 * this build's BuildConfig ships a STATIC AES-256-CBC key/IV (not native
 * code, not Firebase-gated - just a plain Java constant), used both to
 * decrypt a small encrypted config file (which contains today's live API
 * base URL - this is their equivalent of Firebase Remote Config) and,
 * conditionally, to decrypt the actual API response body.
 *
 * This is the piece that was missing in resolver.js's placeholder - it's
 * how your backend can get the real match list + direct stream links
 * automatically, on a schedule, without manual link-copying or Frida.
 *
 * NOTE: this is literally your own app's data (Egidepage TV / cricmad) -
 * you have as much right to call its own API as the app itself does.
 *
 * The actual key/IV/auth values are NOT hardcoded here - they're read from
 * config.js (which reads them from environment variables: CRICMAD_KEY,
 * CRICMAD_IV, CRICMAD_AUTH_VALUE). Keeping them out of the source file means
 * they're not sitting in plain text in a public git history. Set them as
 * real environment variables wherever you deploy (e.g. Render) - see
 * .env.example.
 */
const crypto = require('crypto');
const fetch = require('node-fetch');
const config = require('./config');

const KEY = Buffer.from(config.cricmadKey, 'utf8'); // 32 bytes
const IV = Buffer.from(config.cricmadIv, 'utf8'); // 16 bytes
const CONFIG_URL = 'https://lik.maxcm.cc/k.enc';
const AUTH_HEADER_KEY = 'X-Cricmad-Auth';
const AUTH_HEADER_VALUE = config.cricmadAuthHeaderValue;
const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36';

function decrypt(base64Text) {
  const decipher = crypto.createDecipheriv('aes-256-cbc', KEY, IV);
  return Buffer.concat([decipher.update(Buffer.from(base64Text, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * The reverse of decrypt() - same static key/IV. Used by the compat shim
 * (see compatServer.js) to produce a "k.enc"-shaped blob the patched app's
 * UNCHANGED, already-compiled decrypt logic can read, so no further app
 * code needed to change beyond the one CONFIG_URL string.
 */
function encrypt(plainText) {
  const cipher = crypto.createCipheriv('aes-256-cbc', KEY, IV);
  return Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]).toString('base64');
}

/**
 * Mirrors Channel.getCleanUrl()/getHeaders() from the decompiled app: the
 * "link" field is "<url>|key1=val1&key2=val2".
 */
function parseChannelLink(link) {
  const [url, headerPart] = link.split('|');
  const headers = {};
  if (headerPart) {
    for (const pair of headerPart.split('&')) {
      const [k, v] = pair.split('=');
      if (k && v) headers[k.trim()] = v.trim();
    }
  }
  return { cleanUrl: (url || '').trim(), headers };
}

async function resolveBaseUrl() {
  const res = await fetch(CONFIG_URL, {
    headers: { headers: { 'Cache-Control': 'no-cache', 'User-Agent': USER_AGENT },, 'User-Agent': USER_AGENT },
    timeout: 10000,
  });
  if (!res.ok) throw new Error(`config fetch failed: HTTP ${res.status}`);
  const body = (await res.text()).trim();
  let baseUrl = decrypt(body);
  if (baseUrl.endsWith('/api')) baseUrl = baseUrl.slice(0, -'/api'.length);
  if (!baseUrl.endsWith('/')) baseUrl += '/';
  return baseUrl;
}

// Last successfully-fetched raw ApiResponse-shaped object, kept so the
// compat shim (compatServer.js) can replay cricmad's own JSON shape
// verbatim to the patched app - we don't need to reconstruct it, just
// cache and re-serve it, which is also what makes the "grace window"
// (serve last known-good on a failed refresh) work for real clients.
let lastRawEvents = null;

function getLastRawEvents() {
  return lastRawEvents;
}

/**
 * Returns a flat list of { channelId, url, headers, type, eventTitle,
 * channelTitle }, one entry per channel across every live event. channelId
 * is synthesized as "<eventId>-<channelTitle-slug>" since the upstream API
 * doesn't give channels their own stable id.
 */
async function fetchLiveChannels() {
  const baseUrl = await resolveBaseUrl();
  const apiUrl = `${baseUrl}api`;

  const res = await fetch(apiUrl, {
    headers: { [AUTH_HEADER_KEY]: AUTH_HEADER_VALUE, 'User-Agent': USER_AGENT },
    timeout: 10000,
  });
  if (!res.ok) throw new Error(`events fetch failed: HTTP ${res.status}`);

  let text = (await res.text()).trim();
  if (!text.startsWith('{') && !text.startsWith('[')) {
    text = decrypt(text);
  }
  const data = JSON.parse(text);
  lastRawEvents = data;

  const out = [];
  for (const event of data.events || []) {
    const channels = event.channels_data || event.channelsData || [];
    for (const ch of channels) {
      const { cleanUrl, headers } = parseChannelLink(ch.link);
      const slug = (ch.title || 'channel').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      out.push({
        channelId: `${event.id}-${slug}`,
        url: cleanUrl,
        headers,
        type: ch.type, // "0" direct, "1" DRM, "2" web
        eventTitle: event.title,
        channelTitle: ch.title,
      });
    }
  }
  return out;
}

module.exports = { fetchLiveChannels, decrypt, encrypt, parseChannelLink, getLastRawEvents };
