#!/usr/bin/env node
// RavMizAI: automated tests for sign-in, access control and the wallet.
//
// Runs against the LIVE site and Supabase project the way a visitor would,
// using throwaway accounts (autotest+<run>.<x>@example.com) that are deleted at
// the end, even if a test fails. See README.md for what each check proves and
// what it cannot.
//
//   cd tests && npm install
//   SUPABASE_ACCESS_TOKEN=sbp_... npm test
//
// The access token (supabase.com/dashboard/account/tokens) is used only to read
// settings, check results in the database, credit the test wallet, create
// one-time reset links and delete the test accounts. It is never printed.

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = (process.env.SITE_URL || 'https://ravmizaii.netlify.app').replace(/\/$/, '');
const REF = process.env.SUPABASE_REF || 'ujqrmjoklinyxbnvyswa';
const CHANNEL = process.env.BROWSER_CHANNEL || 'msedge';          // an installed Edge or Chrome ("chrome")
const DOMAIN = process.env.TEST_EMAIL_DOMAIN || 'example.com';
const PAT = process.env.SUPABASE_ACCESS_TOKEN || fromDotEnv('SUPABASE_ACCESS_TOKEN');
const RUN = Date.now().toString(36);
const mail = tag => `autotest+${RUN}.${tag}@${DOMAIN}`;
const NOBODY = `nobody-${RUN}@${DOMAIN}`;
const APP_PAGES = ['home', 'wallet', 'billing', 'preferences', 'subscribe', 'call-intro', 'chat'];
const ADMIN_FUNCTIONS = ['set_subscription', 'grant_credit', 'record_usage', 'start_trial', 'expire_trials',
  'apply_stripe_subscription', 'link_stripe_customer', 'set_card_summary', 'apply_allowance', 'apply_stripe_allowance'];

function fromDotEnv(key) {
  try {
    const m = fs.readFileSync(path.join(HERE, '..', '.env'), 'utf8').match(new RegExp('^' + key + '=(.+)$', 'm'));
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

// --- reporting ---------------------------------------------------------------
const results = [];
function record(id, name, status, detail) {
  results.push({ id, name, status, detail });
  console.log(`${status.padEnd(8)}${id.padEnd(5)}${name}\n${' '.repeat(13)}${detail}`);
}
// Run only some steps: npm test -- 5 A3   (or TESTS=5,A3). Default: all.
const ONLY = (process.env.TESTS || process.argv.slice(2).join(',')).split(/[\s,]+/).filter(Boolean);
async function step(id, name, fn) {
  if (ONLY.length && !ONLY.includes(id)) return;
  try { await fn(); } catch (e) { record(id, name, 'ERROR', String(e && e.message || e).slice(0, 240)); }
}

// --- Supabase, as the browser talks to it ------------------------------------
let SB = '', ANON = '';
async function loadSiteConfig() {
  const js = await (await fetch(`${SITE}/assets/supabase-config.js`)).text();
  SB = (js.match(/https:\/\/[a-z0-9]+\.supabase\.co/) || [])[0] || '';
  ANON = (js.match(/eyJ[A-Za-z0-9._-]+/) || [])[0] || '';
  if (!SB || !ANON) throw new Error('could not read the Supabase URL and public key from the live site');
}
async function api(p, { method = 'GET', token, body, key } = {}) {
  const r = await fetch(SB + p, {
    method,
    headers: { apikey: key || ANON, Authorization: 'Bearer ' + (token || key || ANON), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
const msg = d => String((d && (d.msg || d.message || d.error_description || d.error_code || d.error)) || (typeof d === 'string' ? d : '')).slice(0, 90);
const ok2xx = r => r.status >= 200 && r.status < 300;
const signUp = (email, password, meta) => api('/auth/v1/signup', { method: 'POST', body: { email, password, data: meta } });
const signIn = (email, password) => api('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
const recover = email => api('/auth/v1/recover', { method: 'POST', body: { email } });
const rest = (p, o) => api('/rest/v1/' + p, o);
const rpc = (name, args, token) => api('/rest/v1/rpc/' + name, { method: 'POST', body: args || {}, token });
const edge = (slug, token, body) => api('/functions/v1/' + slug, { method: 'POST', token, body: body || {} });

// --- Supabase Management API (owner access, for checks and cleanup) ----------
async function mgmt(p, init = {}) {
  const r = await fetch('https://api.supabase.com/v1' + p, { ...init, headers: { Authorization: 'Bearer ' + PAT, 'Content-Type': 'application/json' } });
  const t = await r.text();
  if (!r.ok) throw new Error(`management API ${p.split('?')[0]}: HTTP ${r.status} ${t.slice(0, 160)}`);
  return t ? JSON.parse(t) : null;
}
const sql = q => mgmt(`/projects/${REF}/database/query`, { method: 'POST', body: JSON.stringify({ query: q }) });
const one = async q => (await sql(q))[0] || {};
const uuid = s => { if (!/^[0-9a-f-]{36}$/.test(String(s))) throw new Error('unexpected id ' + s); return s; };
const wallet = async id => one(`select seconds_balance::int as s, chats_balance::int as c from public.wallets where user_id = '${uuid(id)}'`);
const ledgerRows = async id => (await one(`select count(*)::int as n from public.wallet_ledger where user_id = '${uuid(id)}'`)).n;
const credit = (id, secs) => sql(`select * from public.grant_credit('${uuid(id)}'::uuid, ${Number(secs) | 0}, 0, 'autotest credit')`);
// The service-role key: what the backend uses. Fetched for this run only, never printed.
let SERVICE = '';
async function serviceKey() {
  if (!SERVICE) {
    const keys = await mgmt(`/projects/${REF}/api-keys?reveal=true`);
    SERVICE = (keys.find(k => k.name === 'service_role') || {}).api_key || '';
    if (!SERVICE) throw new Error('could not read the service-role key');
  }
  return SERVICE;
}
// Reports usage the way the backend (the voice provider's server) would.
const reportUsage = async (user, callId, seconds, description) =>
  edge('record-usage', await serviceKey(), { user_id: user, call_id: `autotest-${RUN}-${callId}`, seconds, description });
// Voice and chats should add up: grants minus charges and expiries = balance.
const ledgerTotal = async id => (await one(`select coalesce(sum(case when kind in ('debit','expire') then -seconds else seconds end), 0)::int as s from public.wallet_ledger where user_id = '${uuid(id)}'`)).s;
// What the Stripe webhook calls for each subscription event (sql/010).
const stripeAllowance = (id, sub, status, periodStart) => sql(`select * from public.apply_stripe_allowance(null, '${sub}', '${status}', ${periodStart ? `'${periodStart}'::timestamptz` : 'null'}, '${uuid(id)}'::uuid)`);
async function resetLink(email) {
  await serviceKey();
  const r = await api('/auth/v1/admin/generate_link', { method: 'POST', key: SERVICE, body: { type: 'recovery', email, redirect_to: `${SITE}/reset-password.html` } });
  const p = (r.data && (r.data.properties || r.data)) || {};
  return { status: r.status, action: p.action_link, hash: p.hashed_token };
}

const strongPw = () => 'Aa1!' + crypto.randomBytes(12).toString('base64url');
const fmtDuration = s => { s = Math.max(0, Math.floor(s)); if (s < 60) return s + 's'; const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60; return h ? h + 'h' + (m ? ' ' + m + 'm' : '') : m + 'm' + (r ? ' ' + r + 's' : ''); };

// Counts animation frames in which a member page was painted visible.
const FLASH_SAMPLER = () => {
  if (!location.pathname.startsWith('/app/')) return;
  const log = []; const tick = () => { if (document.body) log.push(getComputedStyle(document.body).visibility); if (log.length < 2000) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  addEventListener('pagehide', () => { try { sessionStorage.setItem('__flash', String(log.filter(v => v === 'visible').length)); } catch (e) {} });
};

// ---------------------------------------------------------------------------
(async () => {
  if (!PAT) { console.error('Set SUPABASE_ACCESS_TOKEN (environment or ../.env). See README.md.'); process.exit(2); }
  await loadSiteConfig();
  const cfg = await mgmt(`/projects/${REF}/config/auth`);
  const browser = await chromium.launch({ channel: CHANNEL });
  const A = mail('a'), B = mail('b');
  let pwA = strongPw(); const pwB = strongPw();
  let idA = '', idB = '', tokA = '', tokB = '';
  console.log(`RavMizAI tests: run ${RUN} against ${SITE}\n`);

  try {
    // Test account A. With "Confirm email" off, sign-up returns a session at once.
    const first = await signUp(A, pwA, { first_name: 'Autotest', last_name: 'Alpha' });
    idA = first.data?.user?.id || first.data?.id || '';
    tokA = first.data?.access_token || '';
    if (!idA) throw new Error(`could not create test account A: HTTP ${first.status} ${msg(first.data)}`);
    if (!tokA) tokA = (await signIn(A, pwA)).data?.access_token || '';

    // 1. Duplicate registration -------------------------------------------------
    let dup;
    await step('1', 'Duplicate registration', async () => {
      dup = await signUp(A, strongPw(), { first_name: 'Dup', last_name: 'Dup' });
      const n = (await one(`select count(*)::int as n from auth.users where lower(email) = lower('${A}')`)).n;
      const original = await signIn(A, pwA);
      record('1', 'Duplicate registration', n === 1 && original.status === 200 ? 'PASS' : 'FAIL',
        `second sign-up with the same email -> HTTP ${dup.status} "${msg(dup.data)}"; accounts with that email: ${n}; original password still works: ${original.status === 200}`);
    });

    // 9a/9b. Enumeration at sign-up and log-in ---------------------------------
    await step('9a', 'Enumeration: sign-up page', async () => {
      const ctx = await browser.newContext(); const p = await ctx.newPage();
      await p.goto(`${SITE}/signup`);
      await p.fill('#signupForm [name=first]', 'Auto'); await p.fill('#signupForm [name=last]', 'Test');
      await p.fill('#signupForm [name=email]', A);
      const pw = strongPw();
      await p.fill('#signupForm [name=password]', pw);
      if (await p.$('#signupForm [name=password2]')) await p.fill('#signupForm [name=password2]', pw);
      await p.check('#signupForm [name=agree]');
      await p.click('#signupForm button[type=submit]');
      await p.waitForFunction(() => { const e = document.querySelector('#formError'); return e && e.style.display === 'block' && e.textContent.trim(); }, null, { timeout: 15000 });
      const text = (await p.textContent('#formError')).trim();
      await ctx.close();
      const reveals = /already exists|already registered/i.test(text);
      record('9a', 'Enumeration: sign-up page', reveals ? 'FAIL' : 'PASS',
        `signing up with an email that has an account shows: "${text}"${reveals ? ' (tells anyone the address has an account)' : ''}; the API itself answered HTTP ${dup && dup.status} "${dup && msg(dup.data)}"`);
    });
    await step('9b', 'Enumeration: log-in', async () => {
      const bad = 'Wrong!' + RUN + 'x9';
      const a = await signIn(A, bad), n = await signIn(NOBODY, bad);
      const same = a.status === n.status && msg(a.data) === msg(n.data);
      record('9b', 'Enumeration: log-in', same ? 'PASS' : 'FAIL',
        `wrong password for a real account -> HTTP ${a.status} "${msg(a.data)}"; unknown email -> HTTP ${n.status} "${msg(n.data)}"`);
    });

    // 3 + 9c. Password reset -----------------------------------------------------
    const forgot = async email => {
      const ctx = await browser.newContext(); const p = await ctx.newPage();
      let apiRes = null;
      p.on('response', async r => { if (r.url().includes('/auth/v1/recover')) { try { apiRes = { status: r.status(), body: msg(await r.json()) }; } catch { apiRes = { status: r.status(), body: '' }; } } });
      await p.goto(`${SITE}/forgot-password`);
      await p.fill('#forgotForm [name=email]', email);
      await p.click('#forgotForm button[type=submit]');
      await p.waitForFunction(() => [...document.querySelectorAll('#formSuccess,#formError')].some(e => e.style.display === 'block' && e.textContent.trim()), null, { timeout: 15000 });
      const text = await p.evaluate(() => [...document.querySelectorAll('#formSuccess,#formError')].filter(e => e.style.display === 'block').map(e => e.textContent.trim()).join(' '));
      await ctx.close();
      return { text, api: apiRes };
    };
    let resetUiA, resetUiN, repeat;
    await step('9c', 'Enumeration: password reset', async () => {
      resetUiN = await forgot(NOBODY);
      resetUiA = await forgot(A);
      repeat = await recover(A);
      const shown = t => t.replace(A, '<email>').replace(NOBODY, '<email>');
      const same = shown(resetUiA.text) === shown(resetUiN.text);
      record('9c', 'Enumeration: password reset', same ? 'PASS' : 'FAIL',
        `unknown email shows "${resetUiN.text}" (API ${resetUiN.api && resetUiN.api.status}); real account shows "${resetUiA.text}" (API ${resetUiA.api && resetUiA.api.status} ${resetUiA.api && resetUiA.api.body})`);
    });
    await step('3a', 'Password reset: email reaches the customer', async () => {
      const refused = resetUiA && resetUiA.api && resetUiA.api.status >= 400;
      record('3a', 'Password reset: email reaches the customer', refused ? 'FAIL' : 'WARN',
        refused ? `Supabase refused to send the reset email to the account's address ("${resetUiA.api.body}"). With no email service set up (SMTP: ${cfg.smtp_host ? 'set' : 'not set'}), Supabase's built-in sender only delivers to project team members, so customers cannot reset their password.`
                : `request accepted (API ${resetUiA && resetUiA.api && resetUiA.api.status}); delivery to an inbox is not checked by this suite.`);
    });
    await step('3b', 'Password reset: repeated requests', async () => {
      record('3b', 'Password reset: repeated requests', repeat.status === 429 ? 'PASS' : 'WARN',
        `a second request for the same address straight away -> HTTP ${repeat.status} "${msg(repeat.data)}" (Supabase allows one email per address every ${cfg.smtp_max_frequency}s and ${cfg.rate_limit_email_sent} emails an hour in total)`);
    });
    await step('3c', 'Password reset: link works once, then is rejected', async () => {
      const link = await resetLink(A);
      if (!link.hash) throw new Error(`could not create a reset link: HTTP ${link.status}`);
      const v1 = await api('/auth/v1/verify', { method: 'POST', body: { type: 'recovery', token_hash: link.hash } });
      const v2 = await api('/auth/v1/verify', { method: 'POST', body: { type: 'recovery', token_hash: link.hash } });
      record('3c', 'Password reset: link works once, then is rejected', ok2xx(v1) && !ok2xx(v2) ? 'PASS' : 'FAIL',
        `first use -> HTTP ${v1.status}; same link again -> HTTP ${v2.status} "${msg(v2.data)}"; links expire after ${cfg.mailer_otp_exp / 60} minutes (setting; waiting out the hour is not part of this run)`);
    });
    await step('3d', 'Password reset: reset page end to end', async () => {
      const link = await resetLink(A);
      const ctx = await browser.newContext(); const p = await ctx.newPage();
      await p.goto(link.action);
      await p.waitForURL(/reset-password/, { timeout: 20000 });
      await p.waitForSelector('#resetForm [name=password]', { timeout: 15000 });
      const next = strongPw();
      await p.fill('#resetForm [name=password]', next); await p.fill('#resetForm [name=password2]', next);
      await p.click('#resetForm button[type=submit]');
      await p.waitForFunction(() => { const e = document.querySelector('#formSuccess'); return e && e.style.display === 'block'; }, null, { timeout: 15000 });
      await ctx.close();
      const newWorks = (await signIn(A, next)).status === 200, oldFails = (await signIn(A, pwA)).status !== 200;
      if (newWorks) pwA = next;
      record('3d', 'Password reset: reset page end to end', newWorks && oldFails ? 'PASS' : 'FAIL',
        `opened a reset link, set a new password on /reset-password: new password works: ${newWorks}; old password rejected: ${oldFails}`);
    });

    // 2. Email verification -------------------------------------------------------
    await step('2', 'Email verification', async () => {
      record('2', 'Email verification', cfg.mailer_autoconfirm ? 'FAIL' : 'PASS',
        cfg.mailer_autoconfirm
          ? `"Confirm email" is OFF: the test sign-up was given a session immediately and no confirmation email is sent. It cannot simply be switched on yet: with no email service, confirmation emails would not reach customers (see 3a). One-time email links are single-use (see 3c).`
          : `"Confirm email" is on.`);
    });

    // 4. Google: no second account for an existing customer ---------------------
    await step('4', 'Google sign-in joins the existing account', async () => {
      const d = await one(`select
        (select count(*) from (select lower(email) from auth.users group by 1 having count(*) > 1) x)::int as dup_emails,
        (select count(distinct user_id) from auth.identities where provider = 'google')::int as google_users,
        (select count(*) from (select user_id from auth.identities group by user_id having count(distinct provider) > 1) x)::int as linked`);
      record('4', 'Google sign-in joins the existing account', d.dup_emails === 0 && !cfg.security_manual_linking_enabled ? 'PASS' : 'FAIL',
        `emails with more than one account: ${d.dup_emails}; ${d.google_users} people have used Google, ${d.linked} of them on an account that already existed (joined, not duplicated). Supabase links Google to the account with the same email automatically. Not exercised with a live Google login (needs a real Google account). Risk: with "Confirm email" off, someone could register a customer's email first and keep access after the real owner signs in with Google.`);
    });

    // 6. Unauthorized access (signed out) -----------------------------------------
    await step('6', 'Member-only access while signed out', async () => {
      const leaks = [];
      for (const t of ['profiles', 'wallets', 'wallet_ledger', 'trials', 'stripe_events']) {
        const r = await rest(`${t}?select=*&limit=5`);
        if (ok2xx(r) && Array.isArray(r.data) && r.data.length) leaks.push(`${t} returned ${r.data.length} rows`);
      }
      for (const f of ADMIN_FUNCTIONS) { const r = await rpc(f, {}); if (ok2xx(r)) leaks.push(`rpc ${f} ran`); }
      for (const f of ['create-checkout', 'billing-portal', 'record-usage', 'activate-trial']) { const r = await edge(f); if (ok2xx(r)) leaks.push(`function ${f} answered ${r.status}`); }
      const pages = [];
      for (const pg of APP_PAGES) {
        const ctx = await browser.newContext(); await ctx.addInitScript(FLASH_SAMPLER); const p = await ctx.newPage();
        await p.goto(`${SITE}/app/${pg}.html`);
        await p.waitForURL(/\/login/, { timeout: 15000 }).catch(() => {});
        const flash = Number(await p.evaluate(() => sessionStorage.getItem('__flash')).catch(() => 'NaN'));
        const atLogin = /\/login/.test(p.url());
        if (!atLogin || flash) pages.push(`${pg}: ${atLogin ? 'shown ' + flash + ' frames' : 'not redirected'}`);
        await ctx.close();
      }
      record('6', 'Member-only access while signed out', !leaks.length && !pages.length ? 'PASS' : 'FAIL',
        `${APP_PAGES.length} member pages -> all sent to login without showing member content${pages.length ? ' EXCEPT ' + pages.join(', ') : ''}; data tables, ${ADMIN_FUNCTIONS.length} admin functions and 4 server functions refused a signed-out visitor${leaks.length ? ' EXCEPT ' + leaks.join(', ') : ''}`);
    });

    // Test account B, for cross-account checks and the trial loophole.
    const second = await signUp(B, pwB, { first_name: 'Autotest', last_name: 'Bravo' });
    idB = second.data?.user?.id || ''; tokB = second.data?.access_token || (await signIn(B, pwB)).data?.access_token || '';
    if (!idB) throw new Error(`could not create test account B: HTTP ${second.status} ${msg(second.data)}`);
    tokA = (await signIn(A, pwA)).data?.access_token || tokA;

    // 7. Admin authorization (signed in as a regular member) ----------------------
    await step('7a', 'Members cannot change billing or wallet data', async () => {
      const findings = [];
      const elevate = await rest(`profiles?id=eq.${idA}`, { method: 'PATCH', token: tokA, body: { is_member: true, subscription_status: 'active', subscribed_until: '2099-01-01T00:00:00Z' } });
      const prof = await one(`select is_member, subscription_status from public.profiles where id = '${uuid(idA)}'`);
      if (prof.is_member) findings.push('made itself a member');
      const rename = await rest(`profiles?id=eq.${idA}`, { method: 'PATCH', token: tokA, body: { first_name: 'Autotest2' } });
      const before = await wallet(idA);
      await rest(`wallets?user_id=eq.${idA}`, { method: 'PATCH', token: tokA, body: { seconds_balance: 999999, chats_balance: 9999 } });
      const ins = await rest('wallet_ledger', { method: 'POST', token: tokA, body: { user_id: idA, kind: 'grant', seconds: 999999, description: 'self-credit' } });
      const tri = await rest('trials', { method: 'POST', token: tokA, body: { user_id: idA, status: 'active', started_at: new Date().toISOString(), ends_at: '2099-01-01T00:00:00Z' } });
      const after = await wallet(idA);
      if (after.s !== before.s || after.c !== before.c) findings.push('changed its wallet');
      if (ok2xx(ins)) findings.push('wrote its own ledger');
      if (ok2xx(tri)) findings.push('gave itself a trial');
      const fnRan = [];
      for (const f of ADMIN_FUNCTIONS) { const r = await rpc(f, {}, tokA); if (ok2xx(r)) fnRan.push(f); }
      if (fnRan.length) findings.push('ran ' + fnRan.join(', '));
      const others = await rest('profiles?select=id', { token: tokA });
      const seen = Array.isArray(others.data) ? others.data.filter(r => r.id !== idA).length : 0;
      const bWallet = await rest(`wallets?user_id=eq.${idB}`, { token: tokA });
      if (seen || (Array.isArray(bWallet.data) && bWallet.data.length)) findings.push("read another member's data");
      record('7a', 'Members cannot change billing or wallet data', findings.length ? 'FAIL' : 'PASS',
        findings.length ? 'a regular member ' + findings.join('; ') :
          `as a signed-in member: making itself a paid member -> HTTP ${elevate.status} (refused, still not a member); editing its own name -> HTTP ${rename.status} (allowed, as intended); writing its wallet, ledger or trials -> no effect; all ${ADMIN_FUNCTIONS.length} admin functions refused; could see only its own profile and none of member B's data`);
    });
    await step('7b', 'Old "activate-trial" function', async () => {
      const r = await edge('activate-trial', tokB);
      const sub = await rpc('is_subscribed', {}, tokB);
      const d = await one(`select is_member, subscribed_until, (select count(*) from public.trials t where t.user_id = p.id)::int as trials from public.profiles p where id = '${uuid(idB)}'`);
      const loophole = sub.data === true || d.is_member;
      record('7b', 'Old "activate-trial" function', loophole ? 'FAIL' : 'PASS',
        loophole ? `CRITICAL: a brand-new member with no card called it (HTTP ${r.status}) and became a member until ${String(d.subscribed_until).slice(0, 10)} (member access: ${sub.data}). It is still deployed; deleting it closes this.`
                 : `calling it as a new member -> HTTP ${r.status} "${msg(r.data)}"; no membership granted`);
    });

    // A. Wallet integrity -----------------------------------------------------------
    await step('A1', 'Wallet: initial balance', async () => {
      const mine = await rest(`wallets?select=seconds_balance,chats_balance&user_id=eq.${idA}`, { token: tokA });
      const w = Array.isArray(mine.data) ? mine.data[0] : null;
      record('A1', 'Wallet: initial balance', w && w.seconds_balance === 0 ? 'PASS' : 'FAIL',
        `new account gets a wallet automatically: ${w ? `${w.seconds_balance}s voice, ${w.chats_balance} chats` : 'none found'}`);
    });
    await step('A2', 'Wallet: funding', async () => {
      // The webhook must fund the wallet, and the plan must apply exactly once
      // per trial and per paid period. The SQL is what the webhook calls.
      const shared = fs.readFileSync(path.join(HERE, '..', 'supabase', 'functions', '_shared', 'membership.ts'), 'utf8');
      const hook = fs.readFileSync(path.join(HERE, '..', 'supabase', 'functions', 'stripe-webhook', 'index.ts'), 'utf8');
      const wired = /apply_stripe_allowance/.test(shared) && /applySubscription/.test(hook);
      const limitsOn = /export const WALLET_LIMITS = true/.test(shared);
      const sub = `sub_autotest_${RUN}`;
      const w0 = await wallet(idA);
      await stripeAllowance(idA, sub, 'trialing'); const trial = await wallet(idA);
      await stripeAllowance(idA, sub, 'trialing'); const trialAgain = await wallet(idA);
      await reportUsage(idA, 'a2-use', 600, 'autotest trial call');              // use 10 minutes of the trial
      await stripeAllowance(idA, sub, 'active', '2026-12-01T00:00:00Z'); const paid = await wallet(idA);
      await stripeAllowance(idA, sub, 'active', '2026-12-01T00:00:00Z'); const paidAgain = await wallet(idA);
      await reportUsage(idA, 'a2-use2', 3600, 'autotest paid call');            // use an hour, then renew
      await stripeAllowance(idA, sub, 'active', '2027-01-01T00:00:00Z'); const renewed = await wallet(idA);
      await stripeAllowance(idA, sub, 'past_due', '2027-02-01T00:00:00Z'); const unpaid = await wallet(idA);
      const reconciles = (await ledgerTotal(idA)) === renewed.s;
      const okTrial = trial.s - w0.s === 3600 && trial.c - w0.c === 120 && trialAgain.s === trial.s;
      const okPaid = paid.s === 10800 && paidAgain.s === 10800 && renewed.s === 10800 && unpaid.s === 10800;
      record('A2', 'Wallet: funding', wired && okTrial && okPaid && reconciles ? 'PASS' : 'FAIL',
        `${!wired ? 'the Stripe webhook does NOT call apply_stripe_allowance' : limitsOn ? 'the Stripe webhook funds the wallet' : 'voice and chat limits are OFF at the client\'s request (members are unlimited and no allowance is granted); the funding logic below is ready for when they are switched on'}; trial start -> +${fmtDuration(trial.s - w0.s)} voice, +${trial.c - w0.c} chats (repeat event: no change ${trialAgain.s === trial.s}); first paid month -> ${fmtDuration(paid.s)} (unused trial time expired; repeat event: no change ${paidAgain.s === paid.s}); renewal after using 1h -> ${fmtDuration(renewed.s)} (reset, no roll-over); payment failed -> nothing added (${fmtDuration(unpaid.s)}); history adds up to the balance: ${reconciles}`);
    });
    await step('A3', 'Wallet: deductions', async () => {
      const before = await wallet(idA);
      const r = await reportUsage(idA, 'a3', 40, 'autotest call');
      const w = await wallet(idA);
      record('A3', 'Wallet: deductions', ok2xx(r) && before.s - w.s === 40 && r.data?.charged_seconds === 40 ? 'PASS' : 'FAIL',
        `a 40-second call reported by the server -> HTTP ${r.status}, balance ${fmtDuration(before.s)} -> ${fmtDuration(w.s)}, recorded in the history`);
    });
    await step('A4', 'Wallet: balance controlled by the backend', async () => {
      const before = await wallet(idA);
      const self = await edge('record-usage', tokA, { user_id: idA, call_id: `autotest-${RUN}-a4`, seconds: 1 });
      const other = await edge('record-usage', tokA, { user_id: idB, call_id: `autotest-${RUN}-a4b`, seconds: 1 });
      const anon = await edge('record-usage', undefined, { user_id: idA, call_id: `autotest-${RUN}-a4c`, seconds: 1 });
      const after = await wallet(idA);
      const refused = [self, other, anon].every(r => r.status === 401 || r.status === 403);
      record('A4', 'Wallet: balance controlled by the backend', refused && after.s === before.s ? 'PASS' : 'FAIL',
        `a member reporting its own usage -> HTTP ${self.status}; charging another member -> HTTP ${other.status}; signed out -> HTTP ${anon.status}; balance unchanged: ${after.s === before.s}. Balances are written only by the database (7a), and usage only by the server with the service key. The call length must come from the voice provider's server (Delphi), which does not report it yet.`);
    });
    await step('A5', 'Wallet: transaction history', async () => {
      const mine = await rest(`wallet_ledger?select=kind,seconds&user_id=eq.${idA}&order=id`, { token: tokA });
      const theirs = await rest(`wallet_ledger?select=kind&user_id=eq.${idA}`, { token: tokB });
      const rows = Array.isArray(mine.data) ? mine.data : [];
      const ok = rows.some(r => r.kind === 'credit' || r.kind === 'grant') && rows.some(r => r.kind === 'debit') && Array.isArray(theirs.data) && theirs.data.length === 0;
      record('A5', 'Wallet: transaction history', ok ? 'PASS' : 'FAIL',
        `member sees its own ${rows.length} entries (${rows.map(r => r.kind + ' ' + r.seconds + 's').join(', ')}); another member sees none of them`);
    });
    await step('A6', 'Wallet: duplicate transactions', async () => {
      const before = await wallet(idA);
      const first = await reportUsage(idA, 'a6', 20, 'autotest duplicate');
      const again = await reportUsage(idA, 'a6', 20, 'autotest duplicate');
      const after = await wallet(idA);
      const charged = before.s - after.s;
      record('A6', 'Wallet: duplicate transactions', charged === 20 && again.data?.duplicate === true ? 'PASS' : 'FAIL',
        `the same 20-second call reported twice (same call id) -> charged ${charged}s in total; the second report answered HTTP ${again.status} as a duplicate: ${again.data?.duplicate === true}. Stripe events are protected against duplicates as well.`);
    });
    await step('A7', 'Wallet: insufficient funds', async () => {
      const before = await wallet(idA); const rowsBefore = await ledgerRows(idA);
      const r = await reportUsage(idA, 'a7', before.s + 1000, 'autotest overrun');
      const after = await wallet(idA); const rowsAfter = await ledgerRows(idA);
      const total = await ledgerTotal(idA);
      const ok = ok2xx(r) && after.s === 0 && r.data?.charged_seconds === before.s && r.data?.overage_seconds === 1000 && total === after.s;
      record('A7', 'Wallet: insufficient funds', ok ? 'PASS' : 'FAIL',
        `a call ${fmtDuration(before.s + 1000)} long with only ${fmtDuration(before.s)} left -> charged ${fmtDuration(r.data?.charged_seconds ?? 0)}, ${fmtDuration(r.data?.overage_seconds ?? 0)} reported as over the balance and not charged; balance ${after.s}s (never negative); ${rowsAfter - rowsBefore} history entry, and the history adds up to the balance: ${total === after.s}`);
    });
    await step('A8', 'Wallet: concurrent calls', async () => {
      await credit(idA, 600 - (await wallet(idA)).s);
      const rowsBefore = await ledgerRows(idA);
      const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => reportUsage(idA, 'a8-' + i, 30, 'autotest concurrent')));
      const w = await wallet(idA); const added = (await ledgerRows(idA)) - rowsBefore;
      record('A8', 'Wallet: concurrent calls', w.s === 300 && added === 10 ? 'PASS' : 'FAIL',
        `10 simultaneous 30-second calls on 600s (${rs.filter(ok2xx).length} accepted) -> balance ${w.s}s, ${added} history entries (expected 300s and 10)`);
    });
    await step('A9', 'Wallet: failed payments, refunds, cancellation', async () => {
      const hook = fs.readFileSync(path.join(HERE, '..', 'supabase', 'functions', 'stripe-webhook', 'index.ts'), 'utf8');
      const has = e => hook.includes(`'${e}'`);
      const refunds = has('charge.refunded') || has('refund.created');
      record('A9', 'Wallet: failed payments, refunds, cancellation', refunds ? 'PASS' : 'WARN',
        `from the Stripe webhook code (not run against Stripe here): failed payment ${has('invoice.payment_failed') ? 'handled (membership paused at once)' : 'NOT handled'}; cancellation ${has('customer.subscription.deleted') ? 'handled (membership ends)' : 'NOT handled'}; duplicate Stripe events ignored; refunds ${refunds ? 'handled' : 'NOT handled: a refund in Stripe changes neither access nor the wallet unless the subscription is also cancelled'}. Run with the Stripe CLI against test mode to exercise these.`);
    });

    // 5. Authentication persistence (+ wallet page after refresh) -------------------
    await step('5', 'Staying signed in (refresh, close, reopen)', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-persist-'));
      const open = () => chromium.launchPersistentContext(dir, { channel: CHANNEL, viewport: { width: 1280, height: 860 } });
      const who = p => p.evaluate(async () => (await window.RMAuth.currentUser())?.email || null).catch(() => null);
      let ctx = null, p;
      let afterRefresh, shown1, shown2, db, afterReopen, outAfterSignOut;
      try {
        ctx = await open(); p = ctx.pages()[0] || await ctx.newPage();
        await p.goto(`${SITE}/login`);
        await p.fill('#loginForm [name=email]', A); await p.fill('#loginForm [name=password]', pwA);
        await p.click('#loginForm button[type=submit]');
        await p.waitForURL(/\/app\/home/, { timeout: 20000 });
        await p.reload(); await p.waitForTimeout(2500);
        afterRefresh = await who(p);
        await p.goto(`${SITE}/app/wallet.html`);
        await p.waitForFunction(() => { const e = document.querySelector('#walletMinutes'); return e && /\d/.test(e.textContent); }, null, { timeout: 15000 });
        shown1 = (await p.textContent('#walletMinutes')).trim();
        await p.reload();
        await p.waitForFunction(() => { const e = document.querySelector('#walletMinutes'); return e && /\d/.test(e.textContent); }, null, { timeout: 15000 });
        shown2 = (await p.textContent('#walletMinutes')).trim();
        db = fmtDuration((await wallet(idA)).s);
        await ctx.close(); ctx = null;
        ctx = await open(); p = ctx.pages()[0] || await ctx.newPage();
        await p.goto(`${SITE}/app/home.html`); await p.waitForTimeout(3000);
        afterReopen = /\/app\/home/.test(p.url()) ? await who(p) : null;
        // "Sign out" sits in the account menu behind the initial button.
        await p.click('#userMenuBtn');
        await p.click('#signOut');
        await p.getByRole('button', { name: 'Sign out', exact: true }).click();
        await p.waitForURL(/\/login/, { timeout: 15000 });
        await ctx.close(); ctx = null;
        ctx = await open(); p = ctx.pages()[0] || await ctx.newPage();
        await p.goto(`${SITE}/app/home.html`);
        await p.waitForURL(/\/login/, { timeout: 15000 }).catch(() => {});
        outAfterSignOut = /\/login/.test(p.url());
      } finally {
        // Always release the browser profile, or node never exits.
        if (ctx) await ctx.close().catch(() => {});
        fs.rmSync(dir, { recursive: true, force: true });
      }
      record('5', 'Staying signed in (refresh, close, reopen)', afterRefresh === A && afterReopen === A && outAfterSignOut ? 'PASS' : 'FAIL',
        `signed in -> after refresh: ${afterRefresh === A ? 'still signed in' : 'signed out'}; after closing and reopening the browser: ${afterReopen === A ? 'still signed in' : 'signed out'}; after "Sign out" and reopening: ${outAfterSignOut ? 'signed out' : 'STILL SIGNED IN'}. Sessions have no time limit (${cfg.sessions_timebox ? 'timebox set' : 'no timebox'}, ${cfg.sessions_inactivity_timeout ? 'inactivity timeout set' : 'no inactivity timeout'}).`);
      record('A10', 'Wallet: balance after refresh', shown1 === db && shown2 === db ? 'PASS' : 'FAIL',
        `wallet page shows ${shown1}, after refresh ${shown2}; database holds ${db}`);
    });

    // S1. Security headers and third-party code ---------------------------------------
    await step('S1', 'Security headers and third-party scripts', async () => {
      const res = await fetch(`${SITE}/?cb=${RUN}`);
      const html = await res.text();
      const csp = res.headers.get('content-security-policy') || '';
      const scriptSrc = (csp.match(/script-src([^;]*)/) || [])[1] || '';
      const external = [...html.matchAll(/<script[^>]+src=['"]?(https?:\/\/[^'" >]+)/g)].map(m => new URL(m[1]).host);
      const inline = (html.match(/<script(?![^>]*\bsrc=)[^>]*>/g) || []).length;
      const ok = csp && !/unsafe-inline|unsafe-eval/.test(scriptSrc) && /frame-ancestors/.test(csp) && !external.includes('cdn.jsdelivr.net') && inline === 0;
      record('S1', 'Security headers and third-party scripts', ok ? 'PASS' : 'FAIL',
        `Content-Security-Policy ${csp ? 'set' : 'MISSING'}; scripts allowed from: ${scriptSrc.trim() || '—'}; inline scripts on the home page: ${inline}; supabase-js ${external.includes('cdn.jsdelivr.net') ? 'still loaded from a CDN with a floating version' : 'served from this site, pinned'}; framing: ${/frame-ancestors 'self'/.test(csp) ? 'this site only' : 'not restricted'}`);
    });

    // 10. Rate limiting ---------------------------------------------------------------
    await step('10', 'Rate limiting on sign-in', async () => {
      const codes = [];
      for (let i = 0; i < 40; i++) { codes.push((await signIn(B, 'Wrong!' + i + RUN)).status); if (codes[codes.length - 1] === 429) break; }
      const firstLimited = codes.indexOf(429) + 1;
      record('10', 'Rate limiting on sign-in', firstLimited ? 'PASS' : 'FAIL',
        `${firstLimited ? `wrong-password attempts were blocked (HTTP 429) after ${firstLimited - 1} tries` : `40 wrong-password attempts in a row were all answered (no limit hit)`}; reset emails limited (3b); CAPTCHA on sign-up/log-in: ${cfg.security_captcha_enabled ? 'on' : 'off'}`);
    });

    // 8. Account deletion: member B deletes its own account from Preferences, in
    //    the browser; cleanup (8b) checks the remaining test account's data goes too.
    await step('8a', 'Account deletion: members can request it', async () => {
      // Confirming with someone else's email must delete nothing.
      const wrong = await edge('delete-account', tokB, { confirm: `someone-else-${RUN}@${DOMAIN}` });
      const stillThere = (await one(`select count(*)::int as n from auth.users where id = '${uuid(idB)}'`)).n === 1;
      const ctx = await browser.newContext(); const p = await ctx.newPage();
      let confirmed = false;
      try {
        await p.goto(`${SITE}/login`);
        await p.fill('#loginForm [name=email]', B); await p.fill('#loginForm [name=password]', pwB);
        await p.click('#loginForm button[type=submit]');
        await p.waitForURL(/\/app\//, { timeout: 20000 });
        await p.goto(`${SITE}/app/preferences.html`);
        await p.click('#deleteAccountBtn');
        await p.fill('#deleteConfirm', B);
        await p.click('#deleteAccountGo');
        await p.getByRole('button', { name: 'Delete account', exact: true }).click();
        await p.waitForFunction(() => /Account deleted/.test(document.querySelector('#deleteAccount')?.textContent || ''), null, { timeout: 30000 });
        confirmed = true;
      } finally { await ctx.close(); }
      const left = await one(`select
        (select count(*) from auth.users where id = '${uuid(idB)}')::int as users,
        (select count(*) from public.profiles where id = '${uuid(idB)}')::int as profiles,
        (select count(*) from public.wallets where user_id = '${uuid(idB)}')::int as wallets,
        (select count(*) from public.wallet_ledger where user_id = '${uuid(idB)}')::int as ledger,
        (select count(*) from public.trials where user_id = '${uuid(idB)}')::int as trials`);
      const gone = left.users + left.profiles + left.wallets + left.ledger + left.trials === 0;
      record('8a', 'Account deletion: members can request it', wrong.status === 400 && stillThere && confirmed && gone ? 'PASS' : 'FAIL',
        `a member deleted its own account from Preferences (typed its email, confirmed): ${confirmed ? 'done message shown' : 'NO done message'}; account and all its data gone: ${gone}; confirming with another email first -> HTTP ${wrong.status}, nothing deleted: ${stillThere}. A member with a Stripe subscription has it cancelled before anything is deleted.`);
    });
  } finally {
    // Cleanup: delete every account this run created; their data must go with them.
    try {
      const gone = await sql(`delete from auth.users where email like 'autotest+${RUN}.%@${DOMAIN}' returning id::text as id`);
      const ids = gone.map(r => uuid(r.id));
      if (ids.length) {
        const list = ids.map(i => `'${i}'`).join(',');
        const left = await one(`select
          (select count(*) from public.profiles where id in (${list}))::int as profiles,
          (select count(*) from public.wallets where user_id in (${list}))::int as wallets,
          (select count(*) from public.wallet_ledger where user_id in (${list}))::int as ledger,
          (select count(*) from public.trials where user_id in (${list}))::int as trials`);
        const rest = left.profiles + left.wallets + left.ledger + left.trials;
        record('8b', 'Account deletion: personal data removed', rest ? 'FAIL' : 'PASS',
          `deleting the remaining ${ids.length} test account${ids.length === 1 ? '' : 's'} removed profile, wallet, history and trials (left behind: ${rest} rows). Records held by Stripe are separate and not covered here.`);
      }
    } catch (e) { record('8b', 'Account deletion: personal data removed', 'ERROR', 'cleanup failed: ' + e.message + ` (delete autotest+${RUN}.* users by hand)`); }
    await browser.close().catch(() => {});

    const count = s => results.filter(r => r.status === s).length;
    console.log(`\nSummary: ${count('PASS')} passed, ${count('FAIL')} failed, ${count('WARN')} warnings, ${count('ERROR')} errors`);
    const dir = path.join(HERE, 'reports'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `run-${new Date().toISOString().slice(0, 10)}-${RUN}.json`);
    fs.writeFileSync(file, JSON.stringify({ run: RUN, site: SITE, at: new Date().toISOString(), only: ONLY.length ? ONLY : undefined, results }, null, 2));
    console.log('Report: ' + file);
  }
  // Exit code 1 when anything failed, so a scheduler or CI can flag the run.
  process.exit(results.some(r => r.status === 'FAIL' || r.status === 'ERROR') ? 1 : 0);
})().catch(e => { console.error('Stopped:', e.message); process.exit(1); });
