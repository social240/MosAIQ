// RavMizAI — delete-account
//
// Lets a signed-in member close their account from Preferences (Terms s.18,
// Privacy s.9). In order:
//
//   1. Identify the member from their own JWT, never from the request body.
//   2. Check they typed their own email address, so one stray click or a
//      script on a shared computer cannot delete an account.
//   3. Cancel every live Stripe subscription they have, immediately, so a
//      deleted account can never be charged again. If Stripe refuses, stop
//      there: nothing is deleted.
//   4. Delete the auth user. Profile, wallet, history and trials go with it
//      (on delete cascade).
//
// Stripe keeps its own invoices and payment records (Privacy s.8.3); this does
// not touch them.
//
//   POST /functions/v1/delete-account
//   Authorization: Bearer <member JWT>
//   { "confirm": "<the member's email>" }      -> { ok: true }
//
// Deploy:
//   npx supabase functions deploy delete-account

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

// Subscriptions in these states can still charge or still give access.
const LIVE = ['trialing', 'active', 'past_due', 'unpaid', 'incomplete', 'paused'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
  if (!url || !anonKey || !serviceKey) {
    console.error('missing env: SUPABASE_URL / ANON / SERVICE_ROLE');
    return json({ error: 'Server is not configured.' }, 500);
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

  // 2. Did they confirm with their own email?
  let body: any = {};
  try { body = await req.json(); } catch { /* checked below */ }
  const typed = String(body?.confirm ?? '').trim().toLowerCase();
  if (!user.email || typed !== user.email.toLowerCase()) {
    return json({ error: 'Type the email address of this account to confirm.' }, 400);
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // 3. Stop all billing first.
  const { data: profile } = await admin
    .from('profiles').select('stripe_customer_id').eq('id', user.id).maybeSingle();
  const customer = profile?.stripe_customer_id;
  if (customer) {
    if (!stripeKey) {
      console.error('delete-account: STRIPE_SECRET_KEY missing; refusing to delete a billed account');
      return json({ error: 'Account deletion is unavailable right now. Please try again later.' }, 500);
    }
    const stripe = (path: string, method = 'GET') =>
      fetch('https://api.stripe.com/v1/' + path, {
        method,
        headers: { 'Authorization': 'Bearer ' + stripeKey },
      }).then(async r => ({ ok: r.ok, body: await r.json().catch(() => ({})) }));

    // Second safeguard (RLS already stops a member editing their customer id):
    // only cancel subscriptions of a Stripe customer stamped with this member.
    const owner = await stripe(`customers/${encodeURIComponent(customer)}`);
    const stamped = owner.body?.metadata?.supabase_user_id;
    if (!owner.ok || (stamped && stamped !== user.id)) {
      console.error('delete-account: customer check failed for', user.id);
      return json({ error: 'We could not verify your billing record, so nothing was deleted. Please contact support.' }, 409);
    }
    const list = await stripe(`subscriptions?customer=${encodeURIComponent(customer)}&status=all&limit=100`);
    if (!list.ok) {
      console.error('delete-account: listing subscriptions failed:', list.body?.error?.message);
      return json({ error: 'We could not reach our billing provider, so nothing was deleted. Please try again.' }, 502);
    }
    for (const sub of list.body?.data ?? []) {
      if (!LIVE.includes(sub.status)) continue;
      const cancel = await stripe('subscriptions/' + encodeURIComponent(sub.id), 'DELETE');
      if (!cancel.ok) {
        console.error('delete-account: cancel failed:', sub.id, cancel.body?.error?.message);
        return json({ error: 'We could not cancel your membership, so nothing was deleted. Please try again.' }, 502);
      }
      console.log('delete-account: canceled', sub.id);
    }
  }

  // 4. Delete the account; its data goes with it.
  const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
  if (delErr) {
    console.error('delete-account: deleteUser failed:', delErr.message);
    return json({
      error: customer
        ? 'Your membership was canceled, but the account could not be deleted. Please try again.'
        : 'The account could not be deleted. Please try again.',
    }, 500);
  }
  console.log('delete-account: deleted', user.id);
  return json({ ok: true });
});
