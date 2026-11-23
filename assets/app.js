
const $=(q,ctx=document)=>ctx.querySelector(q), $$=(q,ctx=document)=>[...ctx.querySelectorAll(q)];
// Site root, from where this script was loaded (…/assets/app.js), so a link
// built here is right from any page depth.
const SITE_ROOT=(()=>{try{return new URL('../',document.currentScript.src).href}catch(e){return location.origin+'/'}})();
// Public pages: the full-screen menu behind the ☰ button, which only shows on
// narrow screens (assets/site-common.css). Behaves as a modal dialog: focus
// moves in and stays in, Escape closes it, and focus returns to the button.
function navInit(){
 const btn=$('#menuOpen'), menu=$('#siteMenu'); if(!btn||!menu)return;
 const closeBtn=menu.querySelector('.siteMenu-close');
 const onKey=e=>{
  if(e.key==='Escape'){e.preventDefault();close();return}
  if(e.key!=='Tab')return;
  const f=$$('a[href],button',menu); if(!f.length)return;
  const first=f[0], last=f[f.length-1];
  if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}
  else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
 };
 const open=()=>{
  menu.hidden=false; menu.classList.add('isOpen');
  document.documentElement.classList.add('menuOpen');
  btn.setAttribute('aria-expanded','true');
  document.addEventListener('keydown',onKey,true);
  closeBtn?.focus();
 };
 const close=(restoreFocus=true)=>{
  if(menu.hidden)return;
  menu.hidden=true; menu.classList.remove('isOpen');
  document.documentElement.classList.remove('menuOpen');
  btn.setAttribute('aria-expanded','false');
  document.removeEventListener('keydown',onKey,true);
  if(restoreFocus)try{btn.focus()}catch(e){}
 };
 btn.addEventListener('click',open);
 closeBtn?.addEventListener('click',()=>close());
 // Following a link closes the menu, so Back does not land on it still open.
 $$('a',menu).forEach(a=>a.addEventListener('click',()=>close(false)));
 // Widening past the breakpoint hides the ☰ button; do not leave the sheet up.
 if(window.matchMedia){
  const mq=matchMedia('(max-width:900px)');
  const wide=()=>{ if(!mq.matches)close(false); };
  if(mq.addEventListener)mq.addEventListener('change',wide); else if(mq.addListener)mq.addListener(wide);
 }
 window.addEventListener('pageshow',e=>{ if(e.persisted)close(false); });
}
// Public pages ship with "Log in" / "Try free" in the header. For a visitor who
// is already signed in that reads as being logged out, so swap those links for
// a way back into the app. Runs on the marketing pages only; the member pages
// have their own nav.
async function publicNavInit(){
 if(document.body.classList.contains('appBody'))return;
 if(typeof RMAuth==='undefined')return;
 const u=await RMAuth.currentUser();
 if(!u)return;

 // lets-chat.html is the public gate for text conversation. A member who
 // already pays for it should not be asked to start a trial again — Call and
 // Text are one membership — so send them straight into the conversation.
 if(/lets-chat/.test(location.pathname)&&await RMAuth.isSubscribed()){
  location.href='app/chat.html';
  return;
 }

 // "Ask RavAI" rather than "Go to app": it names what the member gets, not
 // where the link goes.
 const label=(u.firstName&&u.firstName!=='Member')?('Ask RavAI · '+u.firstName):'Ask RavAI';
 const converted=[];
 $$('a').forEach(a=>{
  // Compare resolved paths, not raw hrefs: Netlify's pretty URLs serve these
  // pages with login.html rewritten to /login, which a match on the literal
  // 'login.html' never caught, so the live site kept showing "Log in".
  let path=''; try{path=new URL(a.getAttribute('href')||'',location.href).pathname.replace(/\.html$/,'')}catch(e){}
  const text=(a.textContent||'').trim().toLowerCase();
  const isAuthLink=/\/(login|signup)$/.test(path)||/\/trial\/free-trial$/.test(path);
  if(!isAuthLink)return;
  // Leave links that merely point at the app (e.g. "RavMizAI") alone unless
  // they are the sign-in / sign-up calls to action.
  if(!/log ?in|sign ?(up|in)|try free|7-day trial|try ravmizai/.test(text))return;
  a.setAttribute('href',new URL('app/home.html',SITE_ROOT).href);
  a.textContent=/try free|7-day trial|try ravmizai/.test(text)?label:'Ask RavAI';
  converted.push(a);
 });

 // "Log in" and "Try free" sit side by side in the header; once both say the
 // same thing, one of them is noise. Keep the primary and drop its neighbour.
 converted.forEach(a=>{
  if(!a.classList.contains('btn'))return;
  const sib=a.nextElementSibling;
  if(sib&&converted.includes(sib)&&sib.classList.contains('btn')&&a.parentElement===sib.parentElement){
   // a is the outline "Log in", sib is the primary CTA — remove the duplicate.
   a.remove();
  }
 });

 // Links that lead somewhere else for a signed-in member (the menu's
 // Membership goes to billing instead of the trial signup).
 $$('a[data-auth-href]').forEach(a=>a.setAttribute('href',a.dataset.authHref));
}
// Confirmation dialog. Resolves true when confirmed, false otherwise.
// Built here rather than in the page markup so every page gets it without
// repeating the same block seven times.
function confirmModal({title,message,confirmText='Confirm',cancelText='Cancel',danger=false}){
 return new Promise(resolve=>{
  const back=document.createElement('div');
  back.className='modalBackdrop';
  back.setAttribute('role','dialog');
  back.setAttribute('aria-modal','true');
  back.setAttribute('aria-labelledby','modalTitle');
  back.innerHTML=
   '<div class="modalCard">'+
    '<h2 id="modalTitle"></h2><p></p>'+
    '<div class="modalActions">'+
     '<button type="button" class="btn btn-outline" data-act="cancel"></button>'+
     '<button type="button" class="btn '+(danger?'btn-danger':'btn-primary')+'" data-act="ok"></button>'+
    '</div>'+
   '</div>';
  // Set text via textContent so a name or email can never inject markup.
  back.querySelector('h2').textContent=title;
  back.querySelector('p').textContent=message;
  back.querySelector('[data-act=cancel]').textContent=cancelText;
  back.querySelector('[data-act=ok]').textContent=confirmText;

  const prev=document.activeElement;
  let done=false;
  const close=val=>{
   if(done)return; done=true;
   document.removeEventListener('keydown',onKey,true);
   back.remove();
   document.body.style.overflow='';
   try{prev&&prev.focus()}catch(e){}
   resolve(val);
  };
  const onKey=e=>{
   if(e.key==='Escape'){e.preventDefault();close(false);return}
   if(e.key!=='Tab')return;
   // Keep focus inside the dialog.
   const f=[...back.querySelectorAll('button')];
   if(!f.length)return;
   const first=f[0], last=f[f.length-1];
   if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}
   else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
  };

  back.querySelector('[data-act=ok]').onclick=()=>close(true);
  back.querySelector('[data-act=cancel]').onclick=()=>close(false);
  back.onclick=e=>{ if(e.target===back)close(false); };   // click outside
  document.addEventListener('keydown',onKey,true);

  document.body.style.overflow='hidden';
  document.body.appendChild(back);
  requestAnimationFrame(()=>{
   back.classList.add('open');
   back.querySelector('[data-act=cancel]').focus();  // safer default
  });
 });
}
// Show/hide for password fields. The input keeps focus and the caret stays put,
// so toggling mid-typing does not interrupt anyone.
function setupPasswordToggles(){
 $$('.pwToggle').forEach(btn=>{
  const input=btn.parentElement?.querySelector('input'); if(!input)return;
  btn.onclick=()=>{
   const shown=input.type==='text';
   const pos=input.selectionStart;
   input.type=shown?'password':'text';
   btn.setAttribute('aria-pressed',String(!shown));
   btn.setAttribute('aria-label',shown?'Show password':'Hide password');
   try{ input.focus(); input.setSelectionRange(pos,pos); }catch(e){}
  };
 });
}
function showErr(msg,el='#formError'){const e=$(el);if(e){e.textContent=msg;e.style.display='block';}}
function showOk(msg,el='#formSuccess'){const e=$(el);if(e){e.textContent=msg;e.style.display='block';}}
function clearMsg(){['#formError','#formSuccess'].forEach(s=>{const e=$(s);if(e)e.style.display='none';});}
function storeUser(u){localStorage.setItem('rm_user',JSON.stringify(u))}
function getUser(){try{return JSON.parse(localStorage.getItem('rm_user')||'null')}catch(e){return null}}

function emailFromUser(){const u=getUser();return u?.email||'member@ravmizai.com'}

function setupSignup(formId, next='verify.html'){
 const f=$(formId); if(!f)return;
 f.addEventListener('submit',async e=>{
  e.preventDefault(); clearMsg();
  const d=Object.fromEntries(new FormData(f));
  const first=String(d.first||'').trim(), last=String(d.last||'').trim(), email=String(d.email||'').trim();
  if(!first||!last||!email||!d.password)return showErr('Please complete all required fields.');
  const pwIssue=RMAuth.passwordProblem(d.password);
  if(pwIssue)return showErr(pwIssue);
  // Only enforced when the form actually has a confirm field.
  if(f.querySelector('[name=password2]')&&d.password!==d.password2)
   return showErr('Passwords do not match.');
  if(!f.querySelector('[name=agree]')?.checked)return showErr('Please agree to the Terms of Service and Privacy Policy.');
  localStorage.setItem('rm_next_after_verify',d.next||'app/home.html');
  busy(f,true,'Creating account…');
  try{
   const {needsVerification}=await RMAuth.signUp({first,last,email,password:d.password});
   if(needsVerification){location.href=next;return}
   await RMAuth.syncLegacyUser();
   // A card is required to sign up, so go straight to Stripe rather than
   // dropping the new member on a page they cannot use yet. The trial starts
   // at checkout and the first charge follows 7 days later.
   await goToCheckout(f,d.next||'app/home.html');
  }catch(err){
   showErr(RMAuth.friendly(err));
   busy(f,false);
  }
 });
}

// Sends a just-registered user into Stripe Checkout. If checkout cannot be
// started, fall back to `fallback` with an explanation instead of stranding
// them -- the account exists either way, and the gate still protects access.
async function goToCheckout(form,fallback){
 try{
  busy(form,true,'Opening secure checkout…');
  const url=await RMAuth.startCheckout();
  location.href=url||fallback;
 }catch(err){
  console.warn('[RavMizAI] checkout after signup failed:',err?.message);
  sessionStorage.setItem('rm_checkout_error',RMAuth.friendly(err));
  location.href=fallback;
 }
}
// Disables a form's submit button while a request is in flight, so a slow
// network can't produce duplicate signups or login attempts.
function busy(form,on,label){
 // Exclude .pwToggle: it is a type="button" inside the form and would
 // otherwise be picked up as the submit control.
 const b=form.querySelector('button[type=submit],button:not([type]):not(.pwToggle)');
 if(!b)return;
 if(on){b.dataset.busy='1';b.dataset.label??=b.textContent;b.disabled=true;b.style.opacity='.6';b.style.cursor='wait';if(label)b.textContent=label;}
 else{
  delete b.dataset.busy;
  b.disabled=false;b.style.opacity='';b.style.cursor='';if(b.dataset.label)b.textContent=b.dataset.label;
  // Re-enabling is unconditional, so anything that gates this button — the
  // Terms checkbox — has to reapply itself afterwards.
  form.dispatchEvent(new CustomEvent('rm:idle'));
 }
}
// "Remember me" was a checkbox with no name and no handler, so nothing was
// ever remembered. It now fills the email back in on the next visit.
//
// Only the email: the password belongs in the browser's own password manager
// (the "password for ravmizaii.netlify.app" prompt), which stores it in the
// OS keychain. Keeping a password in localStorage would put it in plain text
// on the device, readable by anything running on the page.
const REMEMBER_KEY='rm_remember_email';

function restoreRememberedEmail(f){
 const box=$('#rememberMe'); const input=f.querySelector('[name=email]');
 if(!box||!input)return;
 let saved=null; try{saved=localStorage.getItem(REMEMBER_KEY)}catch(e){}
 if(saved){
  input.value=saved;
  box.checked=true;
  // Send focus to the password, since the email is already filled.
  const pw=f.querySelector('[name=password]');
  if(pw)setTimeout(()=>{try{pw.focus()}catch(e){}},50);
 }else{
  // Unticking it should forget immediately, not at the next sign-in.
  box.checked=box.checked;
 }
 box.addEventListener('change',()=>{
  if(!box.checked){try{localStorage.removeItem(REMEMBER_KEY)}catch(e){}}
 });
}

function rememberEmail(f,email){
 const box=$('#rememberMe');
 try{
  if(box&&box.checked&&email)localStorage.setItem(REMEMBER_KEY,email);
  else localStorage.removeItem(REMEMBER_KEY);
 }catch(e){}
}

function setupLogin(){
 const f=$('#loginForm'); if(!f)return;
 // Sent back here from a failed Google sign-in (see appInit).
 let pending=null; try{pending=sessionStorage.getItem('rm_login_error');sessionStorage.removeItem('rm_login_error')}catch(e){}
 if(pending)showErr(pending);
 restoreRememberedEmail(f);
 f.addEventListener('submit',async e=>{
  e.preventDefault();clearMsg();
  const d=Object.fromEntries(new FormData(f));
  const email=String(d.email||'').trim();
  if(!email||!d.password)return showErr('Enter your email and password.');
  rememberEmail(f,email);
  busy(f,true,'Signing in…');
  try{
   const {needsVerification}=await RMAuth.signIn({email,password:d.password});
   if(needsVerification){localStorage.setItem('rm_verify_email',email);location.href='verify.html';return}
   await RMAuth.syncLegacyUser();
   location.href='app/home.html';
  }catch(err){
   showErr(RMAuth.friendly(err));
   busy(f,false);
  }
 });
}
// "Continue with Google" on the login and signup pages. Supabase sends the
// visitor to Google and back to the app, where auth.js picks the session up.
function setupGoogle(){
 $$('[data-google]').forEach(btn=>{
  const label=btn.querySelector('span'), text=label?.textContent;
  const reset=()=>{ btn.disabled=false; btn.removeAttribute('aria-busy'); if(label)label.textContent=text; };
  btn.addEventListener('click',async()=>{
   clearMsg();
   btn.disabled=true; btn.setAttribute('aria-busy','true'); if(label)label.textContent='Opening Google…';
   // From the signup page a new member goes on to checkout once Google sends
   // them back, as an email signup does. Remembered across the round trip.
   try{ if(btn.dataset.google==='signup')localStorage.setItem('rm_oauth_intent','signup'); else localStorage.removeItem('rm_oauth_intent'); }catch(e){}
   try{
    await RMAuth.signInWithGoogle({next:'app/home.html'});
    // Leaving for Google; the button stays busy until the page unloads.
   }catch(err){
    try{localStorage.removeItem('rm_oauth_intent')}catch(e){}
    showErr(RMAuth.friendly(err));
    reset();
   }
  });
  // Back from Google through the back/forward cache: no longer busy.
  window.addEventListener('pageshow',e=>{ if(e.persisted)reset(); });
  upgradeGoogleButton(btn);
 });
}

// Where Google allows it (RMAuth.googleClientId), swap in Google's own button.
// The redirect flow above goes through the Supabase project, so Google's screen
// said "Sign in to <project>.supabase.co"; with Google's button the page gets
// the ID token directly and the screen names this site. The redirect button
// stays until Google's is drawn, and remains if Google's script cannot load or
// Google sign-in is switched off.
async function upgradeGoogleButton(btn){
 const clientId=RMAuth.googleClientId; if(!clientId)return;
 const intent=btn.dataset.google;
 let nonce;
 try{
  if(!(await RMAuth.providerEnabled('google')))return;
  nonce=await RMAuth.googleNonce();
  await loadScript('https://accounts.google.com/gsi/client',8000);
 }catch(e){ return; }
 const gid=window.google&&google.accounts&&google.accounts.id; if(!gid)return;
 const slot=document.createElement('div'); slot.className='gsiSlot';
 gid.initialize({
  client_id:clientId, nonce:nonce.hashed, ux_mode:'popup', auto_select:false,
  context:intent==='signup'?'signup':'signin', itp_support:true,
  callback:async({credential})=>{
   clearMsg(); slot.setAttribute('aria-busy','true');
   try{
    await RMAuth.signInWithGoogleIdToken({token:credential,nonce:nonce.raw});
    // From the signup page a new member goes on to checkout, as an email
    // signup does (appInit reads this once on the member home page).
    try{ if(intent==='signup')localStorage.setItem('rm_oauth_intent','signup'); else localStorage.removeItem('rm_oauth_intent'); }catch(e){}
    await RMAuth.syncLegacyUser();
    location.href='app/home.html';
   }catch(err){
    // friendly() is tuned for email codes ("That code is not correct"), which
    // would mislead here; only a network failure gets its wording.
    console.warn('[RavMizAI] Google sign-in failed:',err?.message);
    const m=String(err?.message||'').toLowerCase();
    showErr(/failed to fetch|networkerror/.test(m)?RMAuth.friendly(err):'Google sign-in did not go through. Please try again, or continue with email.');
    slot.removeAttribute('aria-busy');
   }
  }
 });
 const width=Math.round(btn.getBoundingClientRect().width)||320;
 btn.before(slot);
 gid.renderButton(slot,{type:'standard',theme:'outline',size:'large',shape:'pill',text:'continue_with',logo_alignment:'center',locale:'en',width:Math.max(200,Math.min(400,width))});
 btn.hidden=true;
}

function loadScript(src,timeout=8000){
 return new Promise((resolve,reject)=>{
  const s=document.createElement('script'); s.src=src; s.async=true;
  const t=setTimeout(()=>reject(new Error('timed out loading '+src)),timeout);
  s.onload=()=>{clearTimeout(t);resolve()};
  s.onerror=()=>{clearTimeout(t);reject(new Error('could not load '+src))};
  document.head.appendChild(s);
 });
}

// Supabase reports a failed OAuth round trip in the URL (the fragment for the
// implicit flow, the query string for PKCE) instead of creating a session.
function oauthError(){
 const p=new URLSearchParams(location.hash.slice(1)+'&'+location.search.slice(1));
 const code=p.get('error'); if(!code)return '';
 if(code==='access_denied')return 'Google sign-in was cancelled.';
 return 'Google sign-in failed: '+(p.get('error_description')||code);
}

// "Forgot password" — request the reset email.
function setupForgot(){
 const f=$('#forgotForm'); if(!f)return;
 f.addEventListener('submit',async e=>{
  e.preventDefault();clearMsg();
  const email=String(new FormData(f).get('email')||'').trim();
  if(!email)return showErr('Enter your email address.');
  busy(f,true,'Sending…');
  try{
   await RMAuth.requestPasswordReset(email);
   // Deliberately the same message whether or not the address is registered,
   // so this page cannot be used to find out who has an account.
   showOk('If an account exists for '+email+', a reset link is on its way. Check your inbox and spam folder.');
   f.reset();
  }catch(err){ showErr(RMAuth.friendly(err)); }
  busy(f,false);
 });
}

// "Set a new password" — reached from the emailed link.
function setupReset(){
 const f=$('#resetForm'); if(!f)return;
 // Supabase puts the recovery token in the URL fragment and exchanges it for a
 // session. That is asynchronous, so check a moment later rather than at once.
 if(RMAuth.isLive){
  setTimeout(async()=>{
   const u=await RMAuth.currentUser();
   const note=$('#resetFor');
   if(u&&note)note.textContent='Setting a new password for '+u.email+'.';
   else if(!u)showErr('This reset link is invalid or has expired. Request a new one from the sign-in page.');
  },1200);
 }
 f.addEventListener('submit',async e=>{
  e.preventDefault();clearMsg();
  const d=Object.fromEntries(new FormData(f));
  const issue=RMAuth.passwordProblem(d.password);
  if(issue)return showErr(issue);
  if(d.password!==d.password2)return showErr('Passwords do not match.');
  busy(f,true,'Saving…');
  try{
   await RMAuth.updatePassword(d.password);
   showOk('Password updated. Redirecting you to sign in…');
   setTimeout(async()=>{ await RMAuth.signOut(); location.href='login.html'; },1600);
  }catch(err){
   showErr(RMAuth.friendly(err));
   busy(f,false);
  }
 });
}

function setupVerify(){
 const f=$('#verifyForm'); if(!f)return;
 const stored=localStorage.getItem('rm_verify_email');
 const addr=stored||getUser()?.email||'your email';
 const email=$('#verifyEmail'); if(email)email.textContent=addr;
 // The fixed-code hint only applies to the offline prototype.
 if(RMAuth.isLive)$$('.protoHint').forEach(el=>el.remove());
 f.addEventListener('submit',async e=>{
  e.preventDefault();clearMsg();
  const code=$('#code').value.trim();
  if(!/^\d{6}$/.test(code))return showErr('Enter the 6-digit code from your email.');
  busy(f,true,'Verifying…');
  try{
   await RMAuth.verify({code,email:stored});
   await RMAuth.syncLegacyUser();
   const next=localStorage.getItem('rm_next_after_verify')||'app/home.html';
   // With email confirmation on, this is the first moment the user has a
   // session, so checkout happens here instead of at signup.
   if(await RMAuth.isSubscribed()){location.href=next;return}
   await goToCheckout(f,next);
  }catch(err){
   showErr(RMAuth.friendly(err));
   busy(f,false);
  }
 });
 const r=$('#resendCode');
 if(r)r.onclick=async e=>{
  e.preventDefault();clearMsg();
  try{
   await RMAuth.resend({email:stored});
   showOk(RMAuth.isLive?'A new code is on its way. Check your email.':'A new verification code was sent. For this prototype, use 111111.');
  }catch(err){showErr(RMAuth.friendly(err));}
 };
}
// The home page's "Start 7-day trial" email boxes. The address used to travel
// as ?email=…, which left it in browser history and the host's access logs.
// It is handed over in sessionStorage instead. The inputs have no name, so even
// a submit without this script reaches the trial page without the address.
function setupTrialHandoff(){
 $$('form.signup[action$="free-trial.html"],form.signup[action$="free-trial"]').forEach(f=>{
  f.addEventListener('submit',e=>{
   e.preventDefault();
   const email=String(f.querySelector('input[type=email]')?.value||'').trim();
   try{ if(email)sessionStorage.setItem('rm_trial_email',email.slice(0,254)); }catch(err){}
   location.href=f.getAttribute('action');
  });
 });
}
function setupTrial(){
 const f=$('#trialSignup'); if(!f)return;
 // Carry over the address typed on the home page (setupTrialHandoff). Older
 // links may still carry ?email=…: use it, then drop it from the address bar
 // so it does not stay in the history.
 let pre=null; try{pre=sessionStorage.getItem('rm_trial_email');sessionStorage.removeItem('rm_trial_email')}catch(e){}
 const qs=new URLSearchParams(location.search);
 if(qs.has('email')){
  pre=pre||qs.get('email'); qs.delete('email');
  const rest=qs.toString();
  try{ history.replaceState(history.state,'',location.pathname+(rest?'?'+rest:'')+location.hash); }catch(e){}
 }
 if(pre&&f.email&&!f.email.value)f.email.value=pre.trim().slice(0,254);
 f.addEventListener('submit',async e=>{
  e.preventDefault();clearMsg();const d=Object.fromEntries(new FormData(f));
  const first=String(d.first||'').trim(), last=String(d.last||'').trim(), email=String(d.email||'').trim();
  if(!first||!last||!email||!d.password)return showErr('Please complete all fields.');
  const pwIssue=RMAuth.passwordProblem(d.password);
  if(pwIssue)return showErr(pwIssue);
  if(f.querySelector('[name=password2]')&&d.password!==d.password2)
   return showErr('Passwords do not match.');
  if(!f.querySelector('[name=agree]')?.checked)return showErr('Please agree to the Terms and Privacy Policy.');
  localStorage.setItem('rm_next_after_verify','payment.html');
  busy(f,true,'Creating account…');
  try{
   const {needsVerification}=await RMAuth.signUp({first,last,email,password:d.password});
   location.href=needsVerification?'verify.html':'payment.html';
  }catch(err){showErr(RMAuth.friendly(err));busy(f,false);}
 });
}
// The trial page no longer collects card details -- it hands off to Stripe
// Checkout, which reports precise errors and keeps card data off this site.
// Guard the page so a signed-out visitor is not left on a dead end.
function setupPayment(){
 if(!$('#startCheckout')||!/trial\//.test(location.pathname))return;
 RMAuth.currentUser().then(cu=>{ if(!cu&&!getUser()?.verified)location.href='free-trial.html'; });
 // The trial page is not an appBody page, so appInit() never runs here and the
 // checkout button has to be wired explicitly.
 setupCheckoutButton();
}
// Pages that require an active membership, not just a login. Compared without
// the extension, since some hosts serve these as clean URLs (/app/chat).
const MEMBER_ONLY=['call-intro','chat'];
function pageName(){
 return (location.pathname.split('/').pop()||'home').replace(/\.html$/,'');
}

async function appInit(){
 if(!document.body.classList.contains('appBody'))return;
 const menu=$('#userMenu'); const btn=$('#userMenuBtn'); if(menu&&btn)btn.onclick=()=>menu.classList.toggle('open');
 // Under live auth the session is restored asynchronously, so check it before
 // deciding the visitor is signed out.
 const u=await RMAuth.currentUser();
 if(!u){
  // Back from Google with an error instead of a session: carry the reason to
  // the login page rather than dropping it.
  const why=oauthError(); if(why)try{sessionStorage.setItem('rm_login_error',why)}catch(e){}
  location.href='../login.html';return
 }
 await RMAuth.syncLegacyUser();
 $$('.userName').forEach(e=>e.textContent=u.firstName||'Member');
 $$('.userEmail').forEach(e=>e.textContent=u.email||'member@ravmizai.com');
 // Avatar shows the first name's initial, falling back to the email's.
 const initial=((u.firstName&&u.firstName!=='Member'?u.firstName:u.email)||'U').trim().charAt(0).toUpperCase();
 $$('.userInitial').forEach(e=>e.textContent=initial);
 $$('#userMenuBtn').forEach(btn=>{ if(!btn.querySelector('.userInitial'))btn.textContent=initial; });

 // Sign out. The markup ships as a plain link to index.html, which only
 // changed page while leaving the session intact — so the next member page
 // let the visitor straight back in.
 $$('#signOut').forEach(out=>{
  out.onclick=async e=>{
   e.preventDefault();
   const yes=await confirmModal({
    title:'Sign out?',
    message:'You will need to sign in again to continue your conversation with RavMizAI.',
    confirmText:'Sign out',
    cancelText:'Stay signed in',
    danger:true
   });
   if(!yes)return;
   try{ await RMAuth.signOut(); }
   catch(err){ console.warn('[RavMizAI] sign-out failed:',err?.message); }
   // Clear prototype leftovers too, so nothing claims a session afterwards.
   ['rm_user','rm_verify_code','rm_verify_email','rm_next_after_verify','rm_prefs','rm_activity']
     .forEach(k=>{try{localStorage.removeItem(k)}catch(_){}} );
   location.href='../login.html';
  };
 });

 const page=pageName();
 // Signed in, so the page can show (styles.css hides member pages until
 // .authReady) -- now, unless it may still redirect once membership is known:
 // the conversation pages, subscribe, and home right after a Google signup,
 // which goes on to checkout. Those show after the checks below.
 let pendingIntent=null; try{pendingIntent=localStorage.getItem('rm_oauth_intent')}catch(e){}
 if(!MEMBER_ONLY.includes(page)&&page!=='subscribe'&&pendingIntent!=='signup')document.body.classList.add('authReady');
 const subscribed=await RMAuth.isSubscribed();

 // Back from Stripe Checkout: confirm it with Stripe through the server, which
 // activates the membership now instead of waiting on Stripe's webhook.
 const qs=new URLSearchParams(location.search);
 if(page==='home'&&qs.get('checkout')==='success'){ await confirmCheckout(qs.get('session_id'),subscribed); return; }

 // Just signed up with Google from the signup page: go on to checkout, as an
 // email signup does. One-shot, so a later visit to home is not redirected.
 let intent=null; try{intent=localStorage.getItem('rm_oauth_intent');localStorage.removeItem('rm_oauth_intent')}catch(e){}
 if(intent==='signup'&&!subscribed){
  try{ const url=await RMAuth.startCheckout(); if(url){location.href=url;return} }
  catch(err){
   try{sessionStorage.setItem('rm_checkout_error',RMAuth.friendly(err))}catch(e){}
   location.href='subscribe.html';return
  }
 }

 // Gate the conversation pages. Landing on one directly must not bypass this.
 if(MEMBER_ONLY.includes(page)&&!subscribed){location.href='subscribe.html';return}

 // Already a member? Nothing to sell — send them to the conversation.
 if(page==='subscribe'&&subscribed){location.href='call-intro.html';return}

 document.body.classList.add('authReady');
 document.body.classList.toggle('isSubscribed',subscribed);
 setupSubscribeGate(subscribed);
 setupCheckoutButton();
 showWelcome(subscribed);

 // Checkout could not be opened right after signing up. Say so, rather than
 // leaving the new member wondering why nothing was charged.
 const pending=sessionStorage.getItem('rm_checkout_error');
 if(pending){
  sessionStorage.removeItem('rm_checkout_error');
  if(!subscribed)showErr(pending);
 }

 // Returning from a cancelled Stripe checkout.
 if(new URLSearchParams(location.search).get('checkout')==='cancelled'&&!subscribed){
  showErr('Checkout was cancelled. Your membership has not started yet.');
 }
 await setupBillingPage(subscribed);
 await setupBalances(subscribed);
 await setupActivity();
 await setupWalletMembership(subscribed);
}

// Call / Text buttons: send non-members to the subscription page instead of
// into the conversation.
function setupSubscribeGate(subscribed){
 if(subscribed)return;
 // Call and Text are the same membership — one subscription covers both, so
 // they gate identically. lets-chat.html stays listed because older markup
 // pointed Text at that public page.
 const targets=['call-intro.html','chat.html','../lets-chat.html','lets-chat.html'];
 $$('a.btn').forEach(a=>{
  const href=a.getAttribute('href')||'';
  if(!targets.includes(href))return;
  a.setAttribute('href','subscribe.html');
  a.setAttribute('data-gated','1');
 });
}

// Sends the visitor to Stripe Checkout. The button is disabled while the
// session is being created, so a double click cannot open two checkouts.
function setupCheckoutButton(){
 const btn=$('#startCheckout'); if(!btn)return;
 btn.onclick=async()=>{
  clearMsg();
  btn.disabled=true; btn.dataset.label??=btn.textContent;
  btn.textContent='Opening secure checkout…'; btn.style.opacity='.6'; btn.style.cursor='wait';
  try{
   const url=await RMAuth.startCheckout();
   // Live: Stripe's hosted page. Offline: null, trial already granted.
   location.href=url||'home.html';
  }catch(err){
   showErr(RMAuth.friendly(err));
   btn.disabled=false; btn.textContent=btn.dataset.label;
   btn.style.opacity=''; btn.style.cursor='';
  }
 };
}

// billing.html ships with a hardcoded "Membership active". Replace it with the
// real state so the page cannot claim a membership the account does not have.
// Real balances on the home and wallet pages. These were hardcoded ("0
// completed / 21 available", "240 chats") and showed the same numbers to every
// member regardless of what they actually had left.
// Seconds as a human duration. Keeps the seconds visible below an hour, so a
// short call is not rounded out of sight: "45s", "4m 20s", "1h 10m".
function fmtDuration(totalSeconds){
 const s=Math.max(0,Math.floor(Number(totalSeconds)||0));
 if(s<60)return s+'s';
 const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), rem=s%60;
 if(h)return h+'h'+(m?' '+m+'m':'');
 return m+'m'+(rem?' '+rem+'s':'');
}

// Wallet limits are OFF for now: the client asked for no voice or chat limits
// at launch ("we will add it after"). Members see "Unlimited" and no allowance
// is granted. To turn limits on, set this to true AND WALLET_LIMITS in
// supabase/functions/_shared/membership.ts, then redeploy those functions.
const WALLET_LIMITS=false;

async function setupBalances(subscribed){
 const slots=['#homeMinutes','#homeChats','#walletMinutes','#walletChats'].filter(s=>$(s));
 if(!slots.length)return;

 if(!WALLET_LIMITS){
  // Value, plus the small label under it ("voice minutes", "left", "chats").
  const set=(sel,val,label)=>{
   const e=$(sel); if(!e)return; e.textContent=val;
   const sub=e.parentElement&&e.parentElement.querySelector('.appSub');
   if(sub&&label!==undefined)sub.textContent=label;
  };
  if(subscribed){
   set('#homeMinutes','Unlimited','voice'); set('#homeChats','Unlimited','text');
   set('#walletMinutes','Unlimited',''); set('#walletChats','Unlimited','');
  }else{
   ['#homeMinutes','#homeChats','#walletMinutes','#walletChats'].forEach(s=>set(s,'—'));
  }
  const note=subscribed
   ? 'Voice and text conversations are unlimited for members right now.'
   : 'Start a membership to use voice calls and text conversations.';
  ['#homeBalanceNote','#walletNote'].forEach(s=>{const e=$(s);if(e)e.textContent=note;});
  return;
 }

 const w=await RMAuth.wallet();
 // A failed read must not read as "you have nothing left".
 if(!w){
  ['#homeMinutes','#homeChats','#walletMinutes','#walletChats'].forEach(s=>{const e=$(s);if(e)e.textContent='—';});
  const note='Balance unavailable right now. Please refresh.';
  ['#homeBalanceNote','#walletNote'].forEach(s=>{const e=$(s);if(e)e.textContent=note;});
  return;
 }

 // Seconds are the source of truth; minutes are derived and kept only for
 // anything still reading the old column.
 const secs=Number(w.seconds_balance ?? (Number(w.minutes_balance)||0)*60)||0;
 const chats=Number(w.chats_balance)||0;

 const set=(sel,val)=>{const e=$(sel);if(e)e.textContent=val;};
 set('#homeMinutes',fmtDuration(secs));
 set('#homeChats',String(chats));
 set('#walletMinutes',fmtDuration(secs));
 set('#walletChats',String(chats));

 const empty=secs===0&&chats===0;
 const note=empty
  ? 'No balance yet. Voice time and messages are added when your membership starts.'
  : 'Updated '+(w.updated_at?new Date(w.updated_at).toLocaleDateString():'just now')+'.';
 set('#homeBalanceNote',note);
 if($('#walletNote'))$('#walletNote').textContent=
   empty?note:'Voice time and text chats are independent balances.';
}

// Membership block on the wallet page. It read "Member · Active" for everyone,
// including lapsed accounts — the same contradiction the billing page had.
async function setupWalletMembership(subscribed){
 const label=$('#walletMemberLabel'); if(!label)return;
 const chip=$('#walletMemberChip'), note=$('#walletMemberNote');
 const p=await RMAuth.profile();
 const until=p?.subscribed_until?new Date(p.subscribed_until):null;

 label.textContent=subscribed?'Member':'Not a member';
 if(chip){
  chip.textContent=subscribed?'Active':'Inactive';
  chip.style.display='';
  chip.style.color=subscribed?'':'#B4232A';
  chip.style.borderColor=subscribed?'':'#E7B9BC';
 }
 if(note){
  note.textContent=subscribed
   ? (until?'Renews '+until.toLocaleDateString()+'.':'Active with no expiry set.')
   : 'Start a membership to use voice calls and text conversations.';
 }
}

// Recent activity on the wallet page, from wallet_ledger. These rows were
// hardcoded ("-4m 10s", "+1h"), so they showed movements to a member whose
// balance was zero — the list and the balance contradicted each other.
async function setupActivity(){
 const box=$('#walletActivity'); if(!box)return;
 if(!WALLET_LIMITS){
  box.innerHTML='<p class="appSub">Nothing to track yet: voice and text have no limits right now.</p>';
  return;
 }

 const rows=await RMAuth.ledger(6);
 if(rows===null){
  box.innerHTML='<p class="appSub">Activity unavailable right now. Please refresh.</p>';
  return;
 }
 if(!rows.length){
  box.innerHTML='<p class="appSub">No activity yet. Grants and usage will appear here.</p>';
  return;
 }

 // 'debit' spends and 'expire' is allowance that lapsed at renewal; everything
 // else adds. The ledger stores magnitudes, so the sign comes from the kind.
 const neg=k=>k==='debit'||k==='expire';
 const fmt=r=>{
  const parts=[];
  // Prefer seconds; fall back to the legacy minutes column on older rows.
  const secs=Number(r.seconds)||((Number(r.minutes)||0)*60);
  if(secs)parts.push(fmtDuration(secs));
  if(r.chats)parts.push(r.chats+(r.chats===1?' chat':' chats'));
  if(!parts.length)return '—';
  return (neg(r.kind)?'-':'+')+parts.join(' · ');
 };
 const when=t=>{
  const d=new Date(t); if(isNaN(d))return '';
  const mins=(Date.now()-d)/60000;
  if(mins<2)return 'Just now';
  if(mins<60)return Math.round(mins)+'m ago';
  if(mins<1440)return Math.round(mins/60)+'h ago';
  return d.toLocaleDateString(undefined,{month:'short',day:'numeric'});
 };

 box.innerHTML='';
 for(const r of rows){
  const row=document.createElement('div');
  row.className='activityRow';
  const left=document.createElement('div');
  const b=document.createElement('b');
  // textContent, never innerHTML: description is stored data.
  b.textContent=r.description||r.kind;
  const s=document.createElement('small');
  s.textContent=when(r.created_at);
  left.append(b,s);
  const amt=document.createElement('span');
  amt.className=neg(r.kind)?'red':'green';
  amt.textContent=fmt(r);
  row.append(left,amt);
  box.appendChild(row);
 }
}

// Money and dates the way the member's browser writes them.
const fmtMoney=(cents,cur)=>{
 const n=(Number(cents)||0)/100;
 try{return new Intl.NumberFormat(undefined,{style:'currency',currency:String(cur||'usd').toUpperCase()}).format(n)}
 catch(e){return '$'+n.toFixed(2)}
};
const fmtDate=d=>{const t=d?new Date(d):null;return t&&!isNaN(t)?t.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):''};

// A message across the top of the page.
function pageBanner(text,kind){
 let el=$('#pageBanner');
 if(!el){
  el=document.createElement('div'); el.id='pageBanner'; el.setAttribute('role','status');
  el.style.margin='0 0 18px'; ($('main')||document.body).prepend(el);
 }
 el.className=kind; el.style.display='block'; el.textContent=text;
 return el;
}

// Back from Stripe Checkout (home.html?checkout=success&session_id=...). The
// server checks the session with Stripe and applies the membership; then the
// page loads again as a member, with Call and Text open.
async function confirmCheckout(sessionId,subscribed){
 document.body.classList.add('authReady');
 const banner=pageBanner('Confirming your membership with Stripe…','success');
 let state=null;
 for(const wait of [0,2500,5000,10000]){
  if(wait)await new Promise(r=>setTimeout(r,wait));
  try{ state=await RMAuth.syncMembership(sessionId||undefined); }
  catch(e){ console.warn('[RavMizAI] membership check failed:',e?.message); }
  if(state?.is_member)break;
 }
 if(state?.is_member||subscribed){
  try{sessionStorage.setItem('rm_welcome',JSON.stringify(state||{}))}catch(e){}
  location.replace('home.html');
  return;
 }
 banner.className='error';
 banner.textContent='We could not confirm your membership yet. If your payment went through, wait a minute and refresh this page, or open Membership & Billing.';
}

// After a confirmed checkout: say plainly what the member now has.
function showWelcome(subscribed){
 let s=null;
 try{ s=JSON.parse(sessionStorage.getItem('rm_welcome')||'null'); sessionStorage.removeItem('rm_welcome'); }catch(e){}
 if(!s||!subscribed)return;
 const charge=s.next_charge, money=charge?fmtMoney(charge.amount,charge.currency):'';
 let text='Welcome, your membership is active. Call and Text are open.';
 if(s.status==='trialing'){
  text='Welcome, your 7-day free trial is active. Call and Text are open.'+(charge
   ? ` Your first charge of ${money} is on ${fmtDate(charge.date)}; cancel before then and you won’t be charged.`
   : (s.trial_end?` Your trial ends on ${fmtDate(s.trial_end)}.`:''));
 }else if(charge){
  text+=` Next charge: ${money} on ${fmtDate(charge.date)}.`;
 }
 pageBanner(text,'success');
}

// Membership & Billing. First from our own records, so nothing sits on
// "Checking…"; then from Stripe through the server, which also repairs a
// membership that a lost webhook never applied.
async function setupBillingPage(subscribed){
 if(!$('#billingStatus'))return;
 setupBillingButtons();
 let p=null; try{ p=await RMAuth.profile(); }catch(e){}
 const st=p?.subscription_status||'none';
 renderBilling({
  status:st, is_member:subscribed, period_end:p?.subscribed_until,
  trial_end:st==='trialing'?p?.subscribed_until:null,
  card:p?.card_last4?{brand:p.card_brand,last4:p.card_last4}:null
 },false);

 let s=null;
 try{ s=await RMAuth.syncMembership(); }
 catch(e){
  const h=$('#billingHistory');
  if(h)h.innerHTML='<p class="appSub">Billing details are unavailable right now. Please refresh in a moment.</p>';
  return;
 }
 // The server just applied a membership our records had missed: load once
 // more so every part of the app agrees.
 let reloaded=null; try{ reloaded=sessionStorage.getItem('rm_billing_reloaded'); }catch(e){}
 if(s.is_member!==subscribed&&!reloaded){
  try{ sessionStorage.setItem('rm_billing_reloaded','1'); }catch(e){}
  location.reload(); return;
 }
 try{ sessionStorage.removeItem('rm_billing_reloaded'); }catch(e){}
 renderBilling(s,true);
}

function renderBilling(s,fromStripe){
 const head=$('#billingStatus'), note=$('#billingNote'), cta=$('#billingCta');
 const st=s.status||'none', charge=s.next_charge, money=charge?fmtMoney(charge.amount,charge.currency):'';
 const ends=fmtDate(s.period_end), trialEnds=fmtDate(s.trial_end||s.period_end);
 let title='No active membership', text='Start a membership to use voice calls and text conversations.', ok=false, cta1=true;
 if(st==='trialing'&&s.is_member){
  title='Free trial active'; ok=true; cta1=false;
  text=s.cancel_at_period_end ? `Your trial ends on ${trialEnds} and won’t renew. You won’t be charged.`
   : charge ? `Your trial ends on ${fmtDate(charge.date)}. Your first charge of ${money} is on that day; cancel before then and you won’t be charged.`
   : (trialEnds?`Your trial ends on ${trialEnds}.`:'Your trial is active.');
 }else if(s.is_member){
  title='Membership active'; ok=true; cta1=false;
  text=s.cancel_at_period_end ? `Cancelled. Your access continues until ${ends}, and you won’t be charged again.`
   : charge ? `Next charge: ${money} on ${fmtDate(charge.date)}.`
   : (ends?`Renews ${ends}.`:'Active.');
 }else if(st==='past_due'||st==='unpaid'){
  title='Payment problem'; cta1=false;
  text='Your last payment didn’t go through. Update your card to keep your membership.';
 }else if(st==='incomplete'){
  title='Payment not completed';
  text='Your checkout wasn’t completed, so your membership hasn’t started.';
 }
 head.textContent=title; head.style.color=ok?'':'#B4232A';
 if(note)note.textContent=text;
 if(cta)cta.style.display=cta1?'':'none';

 const card=$('#cardSummary');
 if(card)card.textContent=s.card?.last4
  ? `${String(s.card.brand||'card').replace(/^./,c=>c.toUpperCase())} ending in ${s.card.last4}`
  : 'No card on file';
 if(!fromStripe)return;

 // Only a Stripe customer has a billing portal to open.
 const customer=st!=='none'||(s.invoices||[]).length>0||!!s.card;
 const manage=$('#manageSection'), upd=$('#updateCard');
 if(manage)manage.style.display=customer?'':'none';
 if(upd)upd.style.display=customer?'':'none';

 const box=$('#billingHistory'); if(!box)return;
 const rows=s.invoices||[];
 if(!rows.length){ box.innerHTML='<p class="appSub">No charges yet.</p>'; return; }
 const label={paid:'Paid',open:'Due',void:'Voided',uncollectible:'Unpaid',draft:'Upcoming'};
 box.innerHTML='';
 for(const i of rows){
  const row=document.createElement('div'); row.className='activityRow';
  const left=document.createElement('div');
  const b=document.createElement('b'); b.textContent=i.description||'RavMizAI Membership';
  const sm=document.createElement('small'); sm.textContent=[fmtDate(i.date),label[i.status]||i.status].filter(Boolean).join(' · ');
  left.append(b,sm);
  const amt=document.createElement(i.url?'a':'span');
  amt.textContent=fmtMoney(i.amount,i.currency);
  if(i.url){ amt.href=i.url; amt.target='_blank'; amt.rel='noopener'; amt.title='View invoice'; }
  row.append(left,amt); box.appendChild(row);
 }
}
function setupBillingButtons(){
 const open=async()=>{
  clearMsg();
  try{
   const url=await RMAuth.billingPortal();
   location.href=url;
  }catch(err){ showErr(RMAuth.friendly(err)); }
 };
 const btn=$('#manageBilling');
 if(btn)btn.onclick=open;
 const upd=$('#updateCard');
 if(upd)upd.onclick=e=>{e.preventDefault();open();};
}

function setupPrefs(){
 const form=$('#prefsForm'); if(!form)return;
 const saved=JSON.parse(localStorage.getItem('rm_prefs')||'{}');
 $$('[data-group]').forEach(el=>{
  const group=el.dataset.group, val=el.dataset.value;
  if((saved[group]||[]).includes(val))el.classList.add('active');
  el.onclick=()=>{ if(el.classList.contains('single')) $$(`[data-group="${group}"]`).forEach(x=>x.classList.remove('active')); el.classList.toggle('active');};
 });
 if(saved.callme)$('#callme').value=saved.callme;
 form.addEventListener('submit',e=>{
  e.preventDefault();const out={callme:$('#callme').value};
  $$('[data-group].active').forEach(el=>{(out[el.dataset.group]??=[]).push(el.dataset.value)});
  localStorage.setItem('rm_prefs',JSON.stringify(out));showOk('Preferences saved.','#prefSuccess');window.scrollTo({top:0,behavior:'smooth'});
 });
}
// Close the account (Preferences). The server cancels any Stripe subscription
// first and deletes the account only if that worked, so a failure leaves
// everything as it was.
function setupDeleteAccount(){
 const open=$('#deleteAccountBtn'), form=$('#deleteAccountForm'); if(!open||!form)return;
 const input=$('#deleteConfirm'), go=$('#deleteAccountGo');
 const hideErr=()=>{const e=$('#deleteError');if(e)e.style.display='none';};
 open.onclick=()=>{ form.hidden=false; open.hidden=true; hideErr(); input.focus(); };
 $('#deleteAccountCancel').onclick=()=>{ form.hidden=true; open.hidden=false; input.value=''; hideErr(); open.focus(); };
 form.addEventListener('submit',async e=>{
  e.preventDefault(); hideErr();
  const typed=input.value.trim();
  if(!typed){ showErr('Type your email address to confirm.','#deleteError'); input.focus(); return; }
  const yes=await confirmModal({
   title:'Delete your account?',
   message:'Your membership ends now, and your profile, wallet and history are deleted for good.',
   confirmText:'Delete account',
   cancelText:'Cancel',
   danger:true
  });
  if(!yes)return;
  go.disabled=true; go.setAttribute('aria-busy','true');
  try{
   await RMAuth.deleteAccount(typed);
   ['rm_user','rm_prefs','rm_activity','rm_verify_code','rm_verify_email','rm_next_after_verify','rm_oauth_intent']
     .forEach(k=>{try{localStorage.removeItem(k)}catch(_){}});
   $('#deleteAccount').innerHTML='<h3>Account deleted</h3><p class="appSub" role="status">Your account and its data have been deleted. Taking you to the home page…</p>';
   setTimeout(()=>{location.href='../index.html'},2500);
  }catch(ex){
   showErr(ex?.message||'The account could not be deleted. Please try again.','#deleteError');
   go.disabled=false; go.removeAttribute('aria-busy');
  }
 });
}
// Call controls on chat.html. The call itself is still a prototype, so these
// drive the on-screen state rather than real audio.
function setupCallControls(){
 const mute=$('#btnMute'), pause=$('#btnPause'), text=$('#btnText'), end=$('#btnEnd');
 if(!mute&&!pause&&!text&&!end)return;
 const status=$('#callStatus');
 const setStatus=s=>{ if(status)status.textContent=s; };

 const toggle=(btn,onLabel,offLabel)=>{
  if(!btn)return;
  btn.onclick=()=>{
   const on=btn.getAttribute('aria-pressed')==='true';
   btn.setAttribute('aria-pressed',String(!on));
   btn.setAttribute('aria-label',!on?onLabel:offLabel);
  };
 };
 toggle(mute,'Unmute microphone','Mute microphone');
 toggle(pause,'Resume call','Pause call');

 // Reflect combined state in the status line.
 const sync=()=>{
  if(pause?.getAttribute('aria-pressed')==='true')setStatus('Paused');
  else if(mute?.getAttribute('aria-pressed')==='true')setStatus('Muted');
  else setStatus('Listening…');
 };
 [mute,pause].forEach(b=>b&&b.addEventListener('click',sync));

 if(text)text.onclick=()=>{ const t=$('#transcript'); if(t)t.scrollIntoView({behavior:'smooth',block:'center'}); };

 if(end)end.onclick=async()=>{
  const yes=await confirmModal({
   title:'End this call?',
   message:'Your conversation will close and the remaining time stays on your wallet.',
   confirmText:'End call',
   cancelText:'Keep talking',
   danger:true
  });
  if(yes)location.href='home.html';
 };
}
function setupTranscript(){
 const transcript=$('#transcript'); if(!transcript)return;
 const sample=[
 ['RavMizAI',"Shalom. Good to have you back. What's on your mind today?"],
 ['You',"I wanted to talk about how heavy the world feels right now."],
 ['RavMizAI',"I hear that. When the world feels heavy, it can affect emunah, focus, and your sense of safety. What part is weighing on you most?"],
 ['You',"I feel like I should be doing more."],
 ['RavMizAI',"That desire can be meaningful. Before deciding what action to take, it helps to separate clear responsibility from fear or pressure. What is one concrete area where you already have influence?"]
 ];
 transcript.innerHTML=sample.map(([who,msg])=>`<div class="msg ${who==='You'?'you':''}"><b>${who}</b><div class="bubble">${msg}</div></div>`).join('');
}
/* ---------------------------------------------------------------------------
   Cookie consent banner
   ---------------------------------------------------------------------------
   Shown once to a first-time visitor, then remembered in LocalStorage. The
   markup is built here rather than pasted into every page, so one change
   reaches the whole site.

   window.ravmizConsent is set before anything else on the page runs, so a
   deferred analytics script can gate itself:

       if (window.ravmizConsent === 'all') { ...load GA... }

   Values: 'all' | 'essential' | 'none'.
   --------------------------------------------------------------------------- */

const COOKIE_KEY='rm_cookie_consent';

function cookieConsentRead(){
 try{return localStorage.getItem(COOKIE_KEY);}catch(e){return null;}
}
function cookieConsentWrite(v){
 try{localStorage.setItem(COOKIE_KEY,v);}catch(e){}
 window.ravmizConsent=v;
}

// Read the stored answer immediately, before DOMContentLoaded, so scripts that
// check window.ravmizConsent do not see undefined.
window.ravmizConsent=cookieConsentRead()||'none';

// Analytics hook. Nothing is wired yet — when a provider is added, load it
// here and nowhere else, so consent genuinely gates it.
function cookieFireAnalytics(){
 // Example, once a provider exists:
 //   const s=document.createElement('script');
 //   s.src='https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXX';
 //   s.async=true; document.head.appendChild(s);
}

function cookieBannerHtml(){
 return `
  <div class="cbRow">
   <div class="cbText">
    <b>We use cookies</b>
    Essential cookies keep you signed in and the service running. Optional
    cookies help us understand how RavMizAI is used so we can improve it. See
    our <a href="${location.pathname.includes('/app/')||location.pathname.includes('/trial/')?'../privacy.html':'privacy.html'}">Privacy Policy</a>.
   </div>
   <div class="cbActions">
    <button type="button" class="cbBtn cbBtnPrimary" id="cbAcceptAll">Accept all</button>
    <button type="button" class="cbBtn cbBtnOutline" id="cbEssential">Essentials only</button>
    <button type="button" class="cbManage" id="cbManage" aria-expanded="false" aria-controls="cbPanel">Manage preferences</button>
   </div>
  </div>
  <div class="cbPanel" id="cbPanel">
   <div class="cbToggleRow">
    <div class="cbLabel">Strictly necessary
     <span>Sign-in sessions, security, core functionality. Always on.</span></div>
    <label class="cbSwitch"><input type="checkbox" checked disabled aria-label="Strictly necessary cookies, always on"><span class="cbSlider"></span></label>
   </div>
   <div class="cbToggleRow">
    <div class="cbLabel">Analytics and performance
     <span>How visitors use the site — page views, session length.</span></div>
    <label class="cbSwitch"><input type="checkbox" id="cbAnalytics" checked aria-label="Analytics and performance cookies"><span class="cbSlider"></span></label>
   </div>
   <div class="cbToggleRow">
    <div class="cbLabel">Personalisation
     <span>Remember your preferences and tailor your experience.</span></div>
    <label class="cbSwitch"><input type="checkbox" id="cbPersonal" checked aria-label="Personalisation cookies"><span class="cbSlider"></span></label>
   </div>
   <button type="button" class="cbBtn cbBtnBlue" id="cbSave" style="margin-top:14px">Save my preferences</button>
  </div>`;
}

function cookieBannerShow(){
 if($('#cookieBanner'))return;
 const el=document.createElement('div');
 el.id='cookieBanner';
 el.setAttribute('role','dialog');
 el.setAttribute('aria-label','Cookie consent');
 el.innerHTML=cookieBannerHtml();
 document.body.appendChild(el);
 document.documentElement.classList.add('cbShown');

 const dismiss=()=>{
  el.style.transition='opacity .25s';
  el.style.opacity='0';
  document.documentElement.classList.remove('cbShown');
  setTimeout(()=>el.remove(),260);
 };
 const settle=(level,analyticsOn)=>{
  cookieConsentWrite(level);
  if(analyticsOn)cookieFireAnalytics();
  dismiss();
 };

 $('#cbAcceptAll',el).addEventListener('click',()=>settle('all',true));
 $('#cbEssential',el).addEventListener('click',()=>settle('essential',false));
 $('#cbManage',el).addEventListener('click',()=>{
  const panel=$('#cbPanel',el),btn=$('#cbManage',el);
  const open=panel.classList.toggle('open');
  btn.setAttribute('aria-expanded',String(open));
 });
 $('#cbSave',el).addEventListener('click',()=>{
  const analytics=$('#cbAnalytics',el).checked;
  const personal=$('#cbPersonal',el).checked;
  settle(analytics||personal?'all':'essential',analytics);
 });
}

// Footer / policy-page link so a visitor can change their mind later.
window.openCookiePrefs=function(){
 try{localStorage.removeItem(COOKIE_KEY);}catch(e){}
 window.ravmizConsent='none';
 const existing=$('#cookieBanner');
 if(existing)existing.remove();
 cookieBannerShow();
 const panel=$('#cbPanel');
 if(panel){
  panel.classList.add('open');
  const btn=$('#cbManage');
  if(btn)btn.setAttribute('aria-expanded','true');
 }
};

function setupCookieBanner(){
 // Any link marked up as a cookie-preferences link reopens the banner.
 $$('#cookiePrefsLink,[data-cookie-prefs]').forEach(a=>{
  a.addEventListener('click',e=>{e.preventDefault();window.openCookiePrefs();});
 });
 if(!cookieConsentRead())cookieBannerShow();
}

// The Terms checkbox was validated only on submit, so the visitor filled the
// whole form, pressed Continue, and only then learned they had missed a box.
// The submit button now stays disabled until the box is ticked, which is what
// the state of the form actually is.
//
// The submit-time check in setupSignup/setupTrial stays: a disabled button is
// a convenience, not a control — it can be re-enabled from the console.
function setupAgreeGate(){
 $$('form').forEach(f=>{
  const box=f.querySelector('[name=agree]');
  if(!box)return;
  const btn=f.querySelector('button[type=submit],button:not([type]):not(.pwToggle)');
  if(!btn)return;

  const sync=()=>{
   // Never fight busy(): while a submit is in flight it owns the button.
   if(btn.dataset.busy==='1')return;
   const okNow=box.checked;
   btn.disabled=!okNow;
   btn.style.opacity=okNow?'':'.45';
   btn.style.cursor=okNow?'':'not-allowed';
   btn.setAttribute('aria-disabled',String(!okNow));
  };

  box.addEventListener('change',()=>{
   sync();
   // Clear the nag once they comply. Deferred, so a submit handler that wrote
   // the message in the same tick does not immediately write it back.
   if(box.checked)setTimeout(()=>{
    const e=$('#formError');
    if(e&&/agree/i.test(e.textContent||''))e.style.display='none';
   },0);
  });
  sync();
  // busy(false) re-enables the button on error; re-apply the gate after it.
  f.addEventListener('rm:idle',sync);
  // A submit handler that bails out early never reaches busy(), so there is no
  // rm:idle to hook. Re-apply the gate after every submit attempt instead,
  // once the handlers ahead of this one have had their turn.
  f.addEventListener('submit',()=>setTimeout(sync,0));
 });
}

document.addEventListener('DOMContentLoaded',()=>{
 navInit();setupPrefs();setupDeleteAccount();setupTranscript();setupCallControls();setupPasswordToggles();
 setupCookieBanner();
 setupAgreeGate();
 // The auth-aware pages need assets/auth.js. Fail loudly rather than silently
 // leaving a form that looks live but does nothing.
 if(typeof RMAuth==='undefined'){
  if($('#loginForm')||$('#signupForm')||$('#verifyForm')||$('#trialSignup')||document.body.classList.contains('appBody')){
   showErr('Authentication failed to load. Please refresh the page.');
   console.error('[RavMizAI] assets/auth.js did not load — auth pages require it.');
  }
  return;
 }
 setupForgot();setupReset();setupLogin();setupGoogle();setupSignup('#signupForm');setupVerify();setupTrialHandoff();setupTrial();setupPayment();appInit();publicNavInit();
});
