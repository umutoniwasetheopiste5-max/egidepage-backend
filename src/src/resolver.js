const fetch = require('node-fetch');
const config = require('./config');
const cricmadSource = require('./cricmadSource');

/**
 * In-memory cache: channelId -> { url, headers, type, title, lastGoodAt }
 * Swap for Redis/a DB if you run more than one backend instance.
 */
const cache = new Map();

/**
 * Primary source: cricmad's own live event/channel API, decrypted with the
 * static key found in Egidepage_TV_v15.0.01.apk's BuildConfig (see
 * cricmadSource.js and the project README for the full story). This
 * replaces the earlier placeholder - you don't need to plug anything in
 * manually anymore, this is a real, working implementation.
 *
 * If cricmad ever changes their key/endpoint and this starts failing, the
 * refresh loop below just logs the error and keeps serving the last
 * known-good cached links (the "grace window" behavior) rather than
 * breaking instantly.
 */
async function refreshFromCricmad() {
  const channels = await cricmadSource.fetchLiveChannels();
  const now = Date.now();
  for (const ch of channels) {
    if (!ch.url) continue;
    cache.set(ch.channelId, {
      url: ch.url,
      headers: ch.headers || {},
      type: ch.type,
      title: ch.channelTitle,
      eventTitle: ch.eventTitle,
      lastGoodAt: now,
    });
  }
  return channels.length;
}

async function probeHost(host, path) {
  const url = `https://${host}${path}`;
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: config.cdnSpoofHeaders,
      timeout: 8000,
    });
    if (res.ok) return url;
  } catch {
    // try next host
  }
  return null;
}

/**
 * Secondary/manual path: if you ever have a bare CDN path without going
 * through cricmad's API at all (e.g. a link you found independently), this
 * tries each configured CDN host in order until one responds - the
 * "fallback sources" protection from the handoff notes.
 */
async function refreshChannelViaHostProbe(channelId, path) {
  for (const host of config.cdnHosts) {
    const url = await probeHost(host, path);
    if (url) {
      cache.set(channelId, { url, headers: config.cdnSpoofHeaders, lastGoodAt: Date.now() });
      return url;
    }
  }
  return null;
}

async function refreshAll() {
  try {
    const count = await refreshFromCricmad();
    console.log(`[resolver] refreshed ${count} channels from cricmad API`);
  } catch (err) {
    console.error('[resolver] cricmad refresh failed, serving cached links if any:', err.message);
  }
}

function scheduleRefreshLoop() {
  const run = async () => {
    await refreshAll();
    const jitter = Math.floor((Math.random() * 2 - 1) * config.refreshJitterMs);
    const next = Math.max(60_000, config.refreshIntervalBaseMs + jitter);
    setTimeout(run, next);
  };
  run();
}

/**
 * Public read used by the /resolve route. Falls back to the last known-good
 * cached entry if nothing fresher is available yet - this is the "grace
 * window" behavior: a failed refresh doesn't instantly break playback for
 * users already using a channel.
 */
function resolveChannel(channelId) {
  return cache.get(channelId) || null;
}

function listChannels() {
  return Array.from(cache.entries()).map(([channelId, entry]) => ({ channelId, ...entry }));
}

module.exports = {
  scheduleRefreshLoop,
  resolveChannel,
  listChannels,
  refreshChannelViaHostProbe,
  refreshAll,
  cache,
};
