// Round-trips a push payload through the RFC 8291 encryption and checks the
// VAPID signature, using a fresh subscriber key pair as a browser would.
import assert from 'node:assert/strict';
import { encryptPayload, decryptPayload, vapidAuthorization, b64url, b64urlDecode } from '../supabase/functions/notify-turn/webpush.js';

const user = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const auth = crypto.getRandomValues(new Uint8Array(16));
const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: b64url(await crypto.subtle.exportKey('raw', user.publicKey)), auth: b64url(auth) } };
const text = JSON.stringify({ title: 'Snäckmageddon', body: 'Anna har spelat. Din tur!', url: 'https://snails.se/snailmageddon/?match=x' });
const body = await encryptPayload(sub, text);
assert.equal(body[20], 65, 'key id length');
assert.deepEqual([...body.slice(16, 20)], [0, 0, 16, 0], 'record size');
assert.equal(await decryptPayload(body, user, auth), text, 'payload did not round-trip');

const vk = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', vk.privateKey);
const pub = b64url(await crypto.subtle.exportKey('raw', vk.publicKey));
const header = await vapidAuthorization(sub.endpoint, { publicKey: pub, jwk }, 'https://snails.se');
const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
assert.ok(m, 'authorization header format');
assert.equal(m[2], pub);
const [h, c, s] = m[1].split('.');
const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(c)));
assert.equal(claims.aud, 'https://fcm.googleapis.com');
assert.equal(claims.sub, 'https://snails.se');
assert.ok(claims.exp > Date.now() / 1000 + 3600);
const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, vk.publicKey, b64urlDecode(s), new TextEncoder().encode(`${h}.${c}`));
assert.equal(ok, true, 'VAPID signature does not verify');
console.log('ok   web push encryption and VAPID signature');
