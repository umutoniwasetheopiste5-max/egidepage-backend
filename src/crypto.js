const crypto = require('crypto');
const config = require('./config');

/**
 * Protection #2: encrypt every API response body.
 *
 * Mirrors the shape cricmad's own app uses - {"code":"0","data":"<blob>"} -
 * but with a normal, well-reviewed cipher (AES-256-GCM) instead of custom
 * native code. The point isn't to be unbreakable, it's to make a casual
 * MITM capture (AppSniffer, etc.) show ciphertext instead of your plain
 * match list / links, same as what you ran into analyzing their app.
 */
function encryptResponse(plainObject) {
  const key = Buffer.from(config.responseEncKey, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const json = JSON.stringify(plainObject);
  const ciphertext = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // pack iv + authTag + ciphertext together, base64, so the client only
  // needs one field to decrypt.
  const packed = Buffer.concat([iv, authTag, ciphertext]).toString('base64');

  return { code: '0', data: packed };
}

function decryptResponse(packedBase64) {
  const key = Buffer.from(config.responseEncKey, 'hex');
  const packed = Buffer.from(packedBase64, 'base64');
  const iv = packed.subarray(0, 12);
  const authTag = packed.subarray(12, 28);
  const ciphertext = packed.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

/**
 * Protection #3: short-lived, signed stream tokens.
 *
 * The app never receives the raw CDN URL directly from /resolve. It gets a
 * token that encodes (channelId, expiry) and is HMAC-signed. The token is
 * only redeemable at /stream/:token, which checks the signature and expiry
 * before redirecting to the real CDN URL. A captured token is useless after
 * it expires (default 15 min, see .env STREAM_TOKEN_TTL_SECONDS).
 *
 * Note on the actual limit of this: once /stream/:token issues the 302
 * redirect, the final CDN URL itself is visible to whoever is sniffing that
 * one request, for as long as that particular CDN URL is itself valid
 * upstream. Signing/expiry stops someone from replaying your OWN resolver
 * endpoint forever; it does not retroactively lock a URL the CDN itself
 * doesn't protect. Combine with short TTLs and channel-level rate limiting
 * (protection #6) to keep the exposure window small.
 */
function signStreamToken(channelId) {
  const expiresAt = Math.floor(Date.now() / 1000) + config.streamTokenTtlSeconds;
  const payload = `${channelId}.${expiresAt}`;
  const sig = crypto
    .createHmac('sha256', config.tokenSigningSecret)
    .update(payload)
    .digest('base64url');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

function verifyStreamToken(token) {
  let decoded;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  const parts = decoded.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed' };
  const [channelId, expiresAtStr, sig] = parts;
  const payload = `${channelId}.${expiresAtStr}`;
  const expectedSig = crypto
    .createHmac('sha256', config.tokenSigningSecret)
    .update(payload)
    .digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return { valid: false, reason: 'bad_signature' };
  }
  const expiresAt = parseInt(expiresAtStr, 10);
  if (Date.now() / 1000 > expiresAt) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true, channelId };
}

/**
 * Protection #6 helper: verify the app's request signature.
 * The app computes HMAC-SHA256(sharedSecret, `${path}.${timestamp}`) and
 * sends it as `X-App-Sig` + `X-App-Ts` headers. Backend rejects anything
 * without a valid, recent signature - stops someone from just copy-pasting
 * your API calls into their own clone, the same way this whole investigation
 * started by sniffing cricmad's traffic.
 */
function verifyAppSignature(path, timestamp, signature) {
  if (!timestamp || !signature) return false;
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  // reject requests signed more than 2 minutes in the past/future - narrows
  // the window for replaying a captured request.
  if (Math.abs(Date.now() / 1000 - ts) > 120) return false;

  const expected = crypto
    .createHmac('sha256', config.appSharedSecret)
    .update(`${path}.${ts}`)
    .digest('base64url');

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
}

module.exports = {
  encryptResponse,
  decryptResponse,
  signStreamToken,
  verifyStreamToken,
  verifyAppSignature,
};
