/**
 * Compatibility shim for the PATCHED Egidepage TV app.
 *
 * The app's compiled code is untouched except for one string constant
 * (CONFIG_URL, now pointing here instead of lik.maxcm.cc - see the patch
 * notes). Everything else - how it fetches, decrypts, and parses - is
 * still cricmad's own original logic, which we don't control and didn't
 * change. So this shim's job is narrow: speak EXACTLY the protocol that
 * logic already expects, sourced from our own cached/resilient data
 * instead of a live call to cricmad every time.
 *
 * Routes (mounted at the app's CONFIG_URL host, e.g. stream-api.egidepage.com):
 *   GET /k.enc  -> base64(AES-256-CBC(ourBaseUrl)) using cricmad's own
 *                  static key/IV (same one found in BuildConfig) - the
 *                  app's existing decryptUrl() reads this exactly like it
 *                  reads cricmad's real k.enc.
 *   GET /api    -> plain JSON, shaped exactly like cricmad's ApiResponse
 *                  ({"Last update time", "notice", "events": [...]}) -
 *                  the app's DecryptionInterceptor skips decryption
 *                  automatically whenever the body already starts with
 *                  "{" or "[", so this doesn't need to be encrypted.
 *
 * This is intentionally a *read replay* of cricmad's own last known-good
 * response (resolver.js refreshes it from them on a schedule) - not a
 * reimplementation of their event data. If cricmad is temporarily down,
 * this keeps serving the last cached response instead of failing.
 */
const express = require('express');
const cricmadSource = require('./cricmadSource');
const resolver = require('./resolver');

const router = express.Router();

// Advertised to the app as its own base URL. Must match wherever this
// compat router is actually mounted/reachable (CONFIG_URL in the patched
// app points at this same host's /k.enc).
const OUR_BASE_URL = process.env.COMPAT_BASE_URL || 'https://stream-api.egidepage.com/';

router.get('/k.enc', (req, res) => {
  const encrypted = cricmadSource.encrypt(OUR_BASE_URL);
  res.type('text/plain').send(encrypted);
});

router.get('/api', (req, res) => {
  const raw = cricmadSource.getLastRawEvents();
  if (!raw) {
    // Nothing cached yet (e.g. just started, first refresh hasn't landed).
    // Shaped as a valid-but-empty ApiResponse so the app's Gson parsing
    // doesn't choke - better than a 5xx on cold start.
    return res.json({ 'Last update time': new Date().toISOString(), notice: null, events: [] });
  }
  res.json(raw);
});

module.exports = router;
