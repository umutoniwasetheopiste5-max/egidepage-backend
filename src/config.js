/**
 * Central config. In production, consider having this file itself be
 * re-fetched periodically from a remote JSON you control (Protection #1 -
 * "don't hardcode, fetch at runtime"), the same trick both cricmad and
 * CRICFy use with Firebase Remote Config. For a first version, env vars +
 * this file are enough; you can add a remote-fetch wrapper later without
 * changing anything else.
 */
require('dotenv').config();

module.exports = {
  port: process.env.PORT || 8080,

  // Protection #2
  responseEncKey: process.env.RESPONSE_ENC_KEY,

  // Protection #3
  tokenSigningSecret: process.env.TOKEN_SIGNING_SECRET,
  streamTokenTtlSeconds: parseInt(process.env.STREAM_TOKEN_TTL_SECONDS || '900', 10),

  // Protection #6
  appSharedSecret: process.env.APP_SHARED_SECRET,

  // Upstream (cricmad) decryption material - found by decompiling
  // Egidepage_TV_v15.0.01.apk's BuildConfig. Kept out of the public repo on
  // purpose: set these as real environment variables (e.g. in Render), never
  // commit them. See cricmadSource.js for how they're used.
  cricmadKey: process.env.CRICMAD_KEY,
  cricmadIv: process.env.CRICMAD_IV,
  cricmadAuthHeaderValue: process.env.CRICMAD_AUTH_VALUE,

  // How often the background resolver re-checks each channel's upstream link.
  // Deliberately randomized around this base (see resolver.js) so requests
  // don't look like a metronome to the upstream CDN.
  refreshIntervalBaseMs: 15 * 60 * 1000, // 15 min
  refreshJitterMs: 5 * 60 * 1000,        // +/- up to 5 min

  // Headers the open CDN currently accepts in place of real auth.
  // (Found via AppSniffer capture - see handoff notes.)
  cdnSpoofHeaders: {
    Referer: 'http://www.fawanews.sc/',
    Origin: 'http://www.fawanews.sc',
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36',
  },

  // Candidate open-CDN hosts. First one that responds wins; keeping more
  // than one here is what gives you fallback instead of a single point of
  // failure (see handoff notes, item "multiple fallback sources").
  cdnHosts: [
    'otte.live.fly.ww.aiv-cdn.net',
    'otte.cache.aiv-cdn.net',
  ],
};
