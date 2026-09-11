// Starts a Stripe Checkout session for one premium cosmetic and returns its URL.
// The gateway verifies the caller's JWT. Requires an account with an e-mail
// address, so the purchase survives cleared browser data.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE_KEY = Deno.env.get('STRIPE_SECRET_KEY') || '';
const PRICES: Record<string, string | undefined> = { gold: Deno.env.get('STRIPE_PRICE_GOLD'), tophat: Deno.env.get('STRIPE_PRICE_TOPHAT') };
const SITE = 'https://snails.se';
const GAME = `${SITE}/snailmageddon`;
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
function b64urlDecode(str: string) { return atob(str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4)); }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer /i, '');
    const claims = JSON.parse(b64urlDecode(token.split('.')[1] || ''));
    const uid = claims.sub as string;
    if (!uid) return json({ error: 'not signed in' }, 401);
    const { item, lang } = await req.json();
    const price = PRICES[item];
    if (!price) return json({ error: 'unknown item' }, 400);
    if (!STRIPE_KEY) return json({ error: 'payments not enabled' }, 503);
    // the account must have an e-mail address
    const u = await (await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${uid}`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } })).json();
    if (!u?.email) return json({ error: 'email required' }, 403);
    const form = new URLSearchParams({
      mode: 'payment',
      'line_items[0][price]': price,
      'line_items[0][quantity]': '1',
      client_reference_id: uid,
      customer_email: u.email,
      'metadata[item]': item,
      'metadata[user]': uid,
      success_url: `${GAME}/?bought=${item}`,
      cancel_url: `${GAME}/?cancelled=${item}`,
      locale: lang === 'sv' ? 'sv' : 'en',
    });
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${STRIPE_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const session = await res.json();
    if (!res.ok) return json({ error: session.error?.message || 'stripe error' }, 502);
    return json({ url: session.url, id: session.id });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
