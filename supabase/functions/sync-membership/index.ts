// RavMizAI — sync-membership
//
// The member's app asks Stripe, through us, for the truth about their
// subscription, and we apply it. Called:
//
//   - on return from Checkout (/app/home.html?checkout=success&session_id=...),
//     so a member is active the moment they land, even if Stripe's webhook is
//     late or never arrives;
//   - by the Billing page, so it shows what Stripe says instead of a guess.
//
// The member is identified from their own JWT. A checkout session id is only
// honoured if that session belongs to them. Applying uses the same code as the
// webhook (_shared/membership.ts), and repeating it changes nothing.
//
//   POST /functions/v1/sync-membership
//   Authorization: Bearer <member JWT>
//   { "session_id": "cs_..." }                     (optional)
//
//   -> { ok, status, is_member, trial_end, period_end, cancel_at_period_end,
//        next_charge: { amount, currency, date } | null,
//        card: { brand, last4 } | null,
//        invoices: [{ date, amount, currency, status, description, url }] }
//
// Deploy:
//   npx supabase functions deploy sync-membership

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { applySubscription, iso, periodEnd, stripeGet } from '../_shared/membership.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Statuses in which a subscription still matters (gives access or can charge).
const LIVE = ['trialing', 'active', 'past_due', 'unpaid', 'incomplete', 'paused'];

async function stripePost(key: string, path: string, params: Record<string, string>) {
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `Stripe ${path} failed`);
  return body;
}

// What the next invoice will charge, discounts included. Newer API versions
// use invoices/create_preview, older ones invoices/upcoming; fall back to the
// plan's list price if neither answers.
async function nextAmount(key: string, sub: any): Promise<number | null> {
  try { return (await stripePost(key, 'invoices/create_preview', { subscription: sub.id })).amount_due; } catch { /* older API */ }
  try { return (await stripeGet(key, `invoices/upcoming?subscription=${encodeURIComponent(sub.id)}`)).amount_due; } catch { /* none */ }
  return sub?.items?.data?.[0]?.price?.unit_amount ?? null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
  if (!url || !anonKey || !serviceKey || !stripeKey) {
    console.error('missing env: SUPABASE_*, STRIPE_SECRET_KEY');
    return json({ error: 'Billing is not configured.' }, 500);
  }

  // 1. Who is asking?
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Not signed in.' }, 401);
  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: who, error: whoErr } = await asCaller.auth.getUser();
  const user = who?.user;
  if (whoErr || !user) return json({ error: 'Your session has expired. Please sign in again.' }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* optional */ }
  const sessionId = typeof body?.session_id === 'string' && /^cs_[A-Za-z0-9_]+$/.test(body.session_id) ? body.session_id : '';

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: profile } = await admin
    .from('profiles').select('stripe_customer_id').eq('id', user.id).maybeSingle();

  try {
    // 2. Which customer and subscription?
    let customer: string | null = profile?.stripe_customer_id ?? null;
    let subId: string | null = null;
    if (sessionId) {
      const session = await stripeGet(stripeKey, `checkout/sessions/${sessionId}`);
      const owner = session.client_reference_id || session.metadata?.supabase_user_id;
      if (owner !== user.id) return json({ error: 'That checkout belongs to another account.' }, 403);
      customer = session.customer || customer;
      subId = session.subscription || null;
    }
    if (!customer) {
      return json({ ok: true, status: 'none', is_member: false, next_charge: null, card: null, invoices: [] });
    }

    // Second safeguard (RLS already stops a member editing their customer id):
    // the Stripe customer must be this member's, per the id create-checkout
    // stamped on it.
    const cust = await stripeGet(stripeKey, `customers/${encodeURIComponent(customer)}?expand[]=invoice_settings.default_payment_method`);
    const stamped = cust?.metadata?.supabase_user_id;
    if (cust?.deleted || (stamped && stamped !== user.id)) {
      console.warn('sync-membership: customer does not belong to caller', user.id);
      return json({ error: 'This billing record does not belong to your account.' }, 403);
    }

    let sub: any = null;
    if (subId) {
      sub = await stripeGet(stripeKey, `subscriptions/${subId}?expand[]=default_payment_method`);
    } else {
      const list = await stripeGet(stripeKey,
        `subscriptions?customer=${encodeURIComponent(customer)}&status=all&limit=10&expand[]=data.default_payment_method`);
      const subs: any[] = (list.data ?? []).sort((a: any, b: any) => b.created - a.created);
      sub = subs.find(s => LIVE.includes(s.status)) ?? subs[0] ?? null;
    }

    // 3. Apply what Stripe says (same code as the webhook; repeat-safe).
    if (sub) await applySubscription(admin, sub, sub.status, user.id);

    // 4. Card on file: the subscription's, else the customer's default.
    let card = sub?.default_payment_method?.card ?? null;
    if (!card?.last4) card = cust?.invoice_settings?.default_payment_method?.card ?? null;
    if (card?.last4) {
      await admin.rpc('set_card_summary', { p_customer_id: customer, p_brand: card.brand ?? null, p_last4: card.last4 });
    }

    // 5. Billing history and the next charge.
    const inv = await stripeGet(stripeKey, `invoices?customer=${encodeURIComponent(customer)}&limit=6`);
    const invoices = (inv.data ?? []).map((i: any) => ({
      date: iso(i.status_transitions?.paid_at ?? i.created),
      amount: i.amount_paid || i.amount_due || i.total || 0,
      currency: i.currency,
      status: i.status,
      description: i.lines?.data?.[0]?.description || 'RavMizAI Membership',
      url: i.hosted_invoice_url ?? null,
    }));

    const status = sub?.status ?? 'none';
    const renews = sub && ['trialing', 'active'].includes(status) && !sub.cancel_at_period_end;
    const next_charge = renews
      ? { amount: await nextAmount(stripeKey, sub), currency: sub.currency || 'usd',
          date: status === 'trialing' ? iso(sub.trial_end) : periodEnd(sub) }
      : null;

    const { data: member } = await admin.from('profiles').select('is_member').eq('id', user.id).maybeSingle();
    return json({
      ok: true,
      status,
      is_member: !!member?.is_member,
      trial_end: status === 'trialing' ? iso(sub?.trial_end) : null,
      period_end: sub ? periodEnd(sub) : null,
      cancel_at_period_end: !!sub?.cancel_at_period_end,
      next_charge,
      card: card?.last4 ? { brand: card.brand ?? 'card', last4: card.last4 } : null,
      invoices,
    });
  } catch (e) {
    console.error('sync-membership failed:', (e as Error).message);
    return json({ error: 'We could not reach our billing provider. Please refresh in a moment.' }, 502);
  }
});
