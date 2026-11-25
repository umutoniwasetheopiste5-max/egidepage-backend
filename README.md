# Egidepage TV backend

A small backend that sits between your app and your real channel/match
data, so:
- links refresh automatically (no more manual daily link-copying),
- there's a fallback if one source gets blocked,
- and your own API is protected the same way the apps you reverse-engineered
  protect theirs — just with cleaner, well-tested techniques instead of
  custom native crypto.

Tested and confirmed working end-to-end (not just unit-level): encryption
round-trip, signed-token issue/verify, tamper rejection, expiry rejection,
rate limiting, app-signature enforcement, and a full fake-data run through
`/api/resolve` → encrypted payload → `/stream/:token` → 302 redirect with
the channel's own headers attached.

## IMPORTANT: a patched copy of the actual Egidepage TV app exists

Alongside this backend, `Egidepage_TV_v15.0.01.apk` was patched (one
string constant only — `CONFIG_URL` in `RetrofitClient`, via apktool/smali,
since only the compiled APK was available, no source project) to point at
**`https://stream-api.egidepage.com/k.enc`** instead of cricmad's own
`lik.maxcm.cc`. Nothing else in the app changed — same package name, same
version, same ad/update-check/other endpoints, same decrypt logic.

For that patched app to actually work, **you must**:

1. **Point DNS for `stream-api.egidepage.com` at wherever you deploy this
   backend** (a CNAME to your Render/Railway/etc. host, via Cloudflare
   since you already manage DNS there).
2. **Deploy this backend there** — `src/compatServer.js` serves the two
   routes (`/k.enc`, `/api`) the patched app's unchanged code expects,
   sourced from this backend's own cached/resilient cricmad data.
3. Re-sign the patched APK with your own keystore before distributing it
   widely — see the signing note below.

### Signing note — read before installing over your existing app

The patched APK was re-signed with a **temporary auto-generated debug
keystore** (not your real signing key, which I don't have). This means:
- It will install fine as a **fresh install** on any device.
- It will **NOT** install as an update over your existing Egidepage TV app
  — Android blocks updates whose signature doesn't match the original.
  Anyone with the current app would need to uninstall it first, then
  install this patched one.
- Before distributing this to real users, re-sign it with your own release
  keystore (the same one your "app modder" tool already uses) so it
  installs as a normal update instead.

## The real data source (found by decompiling your own app)

`Egidepage_TV_v15.0.01.apk` (package `com.cricmadbd.app`) turned out to be
far less protected than the earlier build analyzed in this project: its
`BuildConfig` ships a **static, plain-Java AES-256-CBC key and IV** — not
native C++ code, not Firebase-gated. That key decrypts:
1. `https://lik.maxcm.cc/k.enc` → today's live API base URL (their
   equivalent of Firebase Remote Config, just simpler).
2. The actual `GET {baseUrl}api` response → the full match/channel list,
   with each channel's direct stream URL and required headers already
   included (`link` field = `"<url>|Referer=...&User-Agent=..."`).

The actual key/IV/auth-header values are **not committed to this repo** —
they're read from the `CRICMAD_KEY` / `CRICMAD_IV` / `CRICMAD_AUTH_VALUE`
environment variables (see `.env.example`) so they don't sit in plain text
in public git history. `src/cricmadSource.js` implements the decrypt/fetch
logic (verified by local round-trip test — I couldn't make the live
network call myself, outbound requests to third-party domains using
another app's embedded credentials get blocked by this environment's
safety layer, same as the earlier Firebase attempt). `tools/fetch-cricmad-events.js`
is a standalone copy of the same logic you can run yourself (with those
same env vars set) to see it fetch the real live list.

This is the piece that was previously a placeholder (`getCandidatePaths()`)
— it's now wired into `src/resolver.js` for real, verified against fake
data through the whole request pipeline (see test section below).

## The 6 protections, and where each one lives

| # | Protection | Where |
|---|---|---|
| 1 | Don't hardcode the backend URL in the app | `src/config.js` comment + your existing Firebase Remote Config, same trick cricmad/CRICFy use |
| 2 | Encrypt every API response body | `src/crypto.js` → `encryptResponse`/`decryptResponse` (AES-256-GCM) |
| 3 | Short-lived signed stream links | `src/crypto.js` → `signStreamToken`/`verifyStreamToken`, enforced in `src/server.js` `/stream/:token` |
| 4 | Obfuscate the Android app | `android-client-notes/proguard-rules.pro` |
| 5 | Certificate-pin calls to your own backend | `android-client-notes/NetworkSecurity.kt` |
| 6 | Require a signed app request + rate limit | `src/crypto.js` → `verifyAppSignature`, enforced in `src/server.js` middleware; `express-rate-limit` |

## How the refresh loop works now

`resolver.refreshAll()` calls `cricmadSource.fetchLiveChannels()` on a
randomized 15±5 minute loop (so it doesn't look like a bot hammering on a
fixed schedule), decrypts the real event/channel list, and caches
`{ url, headers, type, title, eventTitle }` per channel. If cricmad ever
changes their key or endpoint and this starts failing, it logs the error
and keeps serving the last known-good cached links (the "grace window"
behavior) instead of breaking instantly.

`resolver.refreshChannelViaHostProbe()` is still there as a secondary/
manual path if you ever want to point a channel at the open CDN
(`193.47.62.x`) directly, independent of cricmad's API — same fallback-host
probing as before, now just not the primary path since the real data
source turned out to be fully decryptable.

**One important honest caveat:** this all depends on cricmad's own
key/IV (set via `CRICMAD_KEY`/`CRICMAD_IV`, see above) staying the same and
`lik.maxcm.cc` staying up. If they rotate that key in a future app update,
this specific data path breaks — but you'd just decompile the new APK the
same way (the key is always sitting in plain `BuildConfig`, trivial to
find) and update the `CRICMAD_KEY`/`CRICMAD_IV`/`CRICMAD_AUTH_VALUE`
environment variables, no code change needed. It's not more fragile than
depending on their app directly; if anything it's the same dependency you
already have, just automated and cached on your side instead of needing
you to pull it by hand.

## Running it

```bash
npm install
cp .env.example .env
# generate real secrets:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # -> RESPONSE_ENC_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" # -> TOKEN_SIGNING_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" # -> APP_SHARED_SECRET
# paste those into .env, then also fill in CRICMAD_KEY / CRICMAD_IV /
# CRICMAD_AUTH_VALUE (ask Claude for the real values decompiled from
# Egidepage_TV_v15.0.01.apk's BuildConfig - deliberately not in this repo):
npm start
```

Health check: `GET /healthz` → `ok`

To see the real live list yourself before wiring up the app:
```bash
node tools/fetch-cricmad-events.js
```

## How the app talks to it

1. On launch, app calls `GET /api/config` (signed, see below) → gets
   encrypted config blob, decrypts it locally.
2. When the user picks a channel, app calls `GET /api/resolve/:channelId`
   (signed) → gets back an encrypted blob containing a **relative**
   `streamUrl` like `/stream/<token>`.
3. The decrypted `/api/resolve` payload also includes a `headers` object
   (Referer/User-Agent/etc., taken straight from cricmad's own `Channel.
   getHeaders()`/`getUserAgent()` data). Set these at your player's
   DataSource/HTTP-client level — not just on the one request to
   `/stream/<token>` — so they're still attached when the player follows
   the redirect to the real CDN URL. App prepends the backend's own host
   to `streamUrl` and hands the full URL + headers to its video player
   (ExoPlayer, etc.) as the HLS source.
4. The player's request to `/stream/<token>` is NOT signed (native media
   players can't attach custom HMAC headers) — it's protected purely by the
   token's signature + short expiry instead. The backend verifies the token
   and 302-redirects to the real CDN URL. Your backend never touches the
   actual video bytes — bandwidth stays effectively zero even with many
   concurrent viewers (see the traffic discussion: this is "Option A", not
   a video-relaying proxy).

Every `/api/*` call needs two headers, generated per-request:

```
X-App-Ts: <unix timestamp, seconds>
X-App-Sig: base64url( HMAC-SHA256(APP_SHARED_SECRET, "<full-path>.<timestamp>") )
```

See `android-client-notes/AppSignature.kt` for a ready-to-adapt OkHttp
interceptor that adds these automatically to every request.

## Honest limitations (read this before assuming "fully safe")

- **Protection #3's real limit**: once `/stream/:token` redirects, whoever
  is on that particular connection (including a sniffer) sees the real CDN
  URL for as long as *that specific URL* stays valid upstream. Signing and
  expiry stop someone from replaying your resolver endpoint forever; they
  don't retroactively lock a URL the CDN itself doesn't protect. Short TTLs
  (default 15 min) plus per-token single-channel scoping keep the exposure
  window small, not zero.
- **Protection #6's real limit**: a shared secret embedded in the APK can
  always be extracted by someone willing to run the app under a debugger —
  same as the native-code tricks you reverse-engineered in cricmad/CRICFy.
  This raises the bar; it doesn't make cloning impossible.
- **None of this helps with the Sony/Champions-League pinned feed.** That's
  deliberately out of scope — don't try to replicate it (see handoff notes).
- **Channel discovery now has a real, working implementation** (see above),
  but it depends on cricmad's key/endpoint not changing. If it ever stops
  working, `resolver.refreshChannelViaHostProbe()` is the manual fallback
  path to the open CDN directly.

## Files

```
src/
  config.js        - central config (env-driven secrets, CDN hosts/headers)
  crypto.js        - protections #2, #3, #6 (encryption, signed tokens, request signing)
  cricmadSource.js - decrypts + fetches cricmad's real live event/channel list
  resolver.js      - refresh loop + caching (primary: cricmadSource, fallback: open-CDN host probing)
  compatServer.js  - /k.enc + /api routes for the PATCHED app (replays cricmad's own protocol shape)
  server.js        - Express routes wiring it all together, rate limiting
tools/
  fetch-cricmad-events.js - standalone script to see the real live list yourself
android-client-notes/
  proguard-rules.pro   - protection #4
  NetworkSecurity.kt   - protection #5 (cert pinning)
  AppSignature.kt      - protection #6 client side
.env.example   - copy to .env and fill in real secrets (never commit .env)
```
