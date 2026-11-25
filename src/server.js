const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { encryptResponse, signStreamToken, verifyStreamToken, verifyAppSignature } = require('./crypto');
const resolver = require('./resolver');
const compatRouter = require('./compatServer');

const app = express();
app.disable('x-powered-by');

/**
 * Compat routes for the PATCHED Egidepage TV app (see compatServer.js for
 * why these exist and why they're unauthenticated: the compiled app can't
 * be made to send our HMAC signature without further smali changes we
 * deliberately avoided - only CONFIG_URL was touched. These two routes
 * replay cricmad's own protocol shape, so they carry no more exposure than
 * cricmad's own equivalent endpoints already did.
 */
app.use('/', compatRouter);

/**
 * Protection #6: basic rate limiting. Stops a single source (scraper, clone
 * app, aggressive bot) from hammering your backend. Tune the numbers once
 * you know real traffic - this is a safe conservative default.
 */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60, // 60 req/min/IP
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

/**
 * Protection #6: require every /api/* request to carry a valid HMAC
 * signature from the app (X-App-Sig, X-App-Ts headers). Requests without
 * one are rejected before they ever reach real logic. This is what stops
 * someone from just replaying your app's captured API calls the way this
 * whole investigation replayed cricmad's.
 */
function requireAppSignature(req, res, next) {
  const sig = req.header('X-App-Sig');
  const ts = req.header('X-App-Ts');
  // Use originalUrl (minus query string), not req.path: Express rewrites
  // req.path relative to the app.use('/api/', ...) mount point, which would
  // silently mismatch the full path the client (app) actually signed.
  const fullPath = req.originalUrl.split('?')[0];
  if (!verifyAppSignature(fullPath, ts, sig)) {
    return res.status(401).json({ code: '1', error: 'bad_or_missing_signature' });
  }
  next();
}
app.use('/api/', requireAppSignature);

/**
 * Protection #1: the app asks THIS endpoint for config instead of having
 * anything hardcoded. Today it just returns static values, but you can
 * later make this backend itself re-fetch these from somewhere else
 * (another remote config), so even this backend's own behavior can be
 * changed without an app update.
 */
app.get('/api/config', (req, res) => {
  const payload = {
    userAgent: config.cdnSpoofHeaders['User-Agent'],
    minAppVersion: 1,
  };
  res.json(encryptResponse(payload)); // Protection #2
});

/**
 * Lists currently-cached channels (id + titles only, no links) so the app
 * can build its match list without needing to go through cricmad's API
 * directly. Encrypted like everything else under /api/.
 */
app.get('/api/channels', (req, res) => {
  const channels = resolver.listChannels().map((c) => ({
    channelId: c.channelId,
    title: c.title,
    eventTitle: c.eventTitle,
    type: c.type,
  }));
  res.json(encryptResponse({ channels }));
});

/**
 * Protection #2 + #3: the app calls this to get a channel's playable link.
 * It never gets the raw CDN URL - it gets a short-lived signed token that
 * must be redeemed at /stream/:token, PLUS the headers (Referer/User-Agent/
 * etc.) the player needs to attach to every request on that stream - not
 * just the redirect, the whole playback session, the same way Channel.
 * getHeaders()/getUserAgent() work in the original app. Setting these at
 * your player's DataSource/HTTP-client level (not per single request) is
 * what makes them survive the 302 redirect from /stream/:token to the real
 * CDN URL.
 */
app.get('/api/resolve/:channelId', (req, res) => {
  const { channelId } = req.params;
  const entry = resolver.resolveChannel(channelId);

  if (!entry) {
    return res.status(404).json(encryptResponse({ error: 'channel_unavailable' }));
  }

  const token = signStreamToken(channelId);
  const payload = {
    channelId,
    streamUrl: `/stream/${token}`, // relative - app prepends this backend's own host
    headers: entry.headers || {}, // attach at the player/DataSource level, see above
    type: entry.type,
    expiresInSeconds: config.streamTokenTtlSeconds,
  };
  res.json(encryptResponse(payload));
});

/**
 * Protection #3: redeem a signed token -> redirect to the real CDN URL.
 * Deliberately NOT under /api/ (no app-signature check here) because the
 * video player / HLS client hitting this URL isn't your app's JS layer,
 * it's the native media player following a redirect - it can't attach a
 * custom HMAC header. The token itself (signed + time-limited) is what
 * protects this route instead.
 */
const streamLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30 });
app.get('/stream/:token', streamLimiter, (req, res) => {
  const result = verifyStreamToken(req.params.token);
  if (!result.valid) {
    return res.status(403).send(`Invalid or expired link (${result.reason})`);
  }
  const entry = resolver.resolveChannel(result.channelId);
  if (!entry) {
    return res.status(404).send('Channel unavailable');
  }
  res.redirect(302, entry.url);
});

app.get('/healthz', (req, res) => res.send('ok'));

resolver.scheduleRefreshLoop();

app.listen(config.port, () => {
  console.log(`egidepage-backend listening on :${config.port}`);
});
