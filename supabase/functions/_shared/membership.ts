// RavMizAI — shared by stripe-webhook and sync-membership.
//
// One way to turn a Stripe subscription into membership and wallet state, so
// the webhook (Stripe calling us) and sync-membership (the member's app asking
// right after checkout) can never disagree.

// Wallet limits are OFF for now: the client asked for no voice or chat limits
// at launch ("we will add it after"). While off, members are not credited an
// allowance and the app shows "Unlimited". To turn limits on, set this to true
// AND set WALLET_LIMITS in assets/app.js, then redeploy stripe-webhook and
// sync-membership. The amounts live in apply_stripe_allowance (sql/010).
export const WALLET_LIMITS = false;

export const iso = (unix: unknown) =>
  typeof unix === 'number' && unix > 0 ? new Date(unix * 1000).toISOString() : null;

// The current billing period. Newer Stripe API versions moved
// current_period_start/end from the subscription onto its items, so read both.
export const periodStart = (sub: any) =>
  iso(sub?.current_period_start ?? sub?.items?.data?.[0]?.current_period_start);
export const periodEnd = (sub: any) =>
  iso(sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end);

// When access ends: the trial end while trialing, otherwise the paid period's
// end. trial_end stays on the subscription after the trial converts, so using
// it for a paying member would end their access at their first charge
// (is_subscribed() requires subscribed_until to be in the future).
export const accessEnd = (sub: any, status: string) =>
  status === 'trialing' ? iso(sub?.trial_end) : periodEnd(sub);

// supabase-js returns errors instead of throwing. Throw, so a webhook answers
// 500 and Stripe retries instead of the event being lost.
export async function call(admin: any, fn: string, args: Record<string, unknown>) {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}

// Membership first, then (when limits are on) the allowance. Both are keyed so
// that repeating them for the same subscription and period changes nothing.
export async function applySubscription(admin: any, sub: any, status: string, userId: string | null) {
  await call(admin, 'apply_stripe_subscription', {
    p_customer_id: sub.customer,
    p_subscription_id: sub.id,
    p_status: status,
    p_period_end: accessEnd(sub, status),
    p_user_id: userId,
  });
  if (!WALLET_LIMITS || status === 'canceled') return;
  const rows = await call(admin, 'apply_stripe_allowance', {
    p_customer_id: sub.customer,
    p_subscription_id: sub.id,
    p_status: status,
    p_period_start: periodStart(sub),
    p_user_id: userId,
  });
  const r = Array.isArray(rows) ? rows[0] : rows;
  if (r?.out_applied) console.log('wallet funded:', r.out_what, sub.id);
}

// GET from Stripe's REST API. Throws with Stripe's own message on failure.
export async function stripeGet(key: string, path: string) {
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    headers: { 'Authorization': 'Bearer ' + key },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `Stripe ${path.split('?')[0]} failed`);
  return body;
}
