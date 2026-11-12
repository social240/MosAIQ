// RavMizAI — home page video. Was inline in index.html; moved here so the
// Content-Security-Policy can forbid inline scripts entirely.
//
// Loaded right after the hero <video>, so the hero part runs at once; the About
// video sits further down the page, so its part waits for the DOM.

// Hero footage: load one cut, keep it playing while it is on screen, and pause
// it once the visitor scrolls past (saves battery and data on phones).
(function(){
 try{
  var v=document.querySelector('.hero-bg'); if(!v)return;
  var mq=window.matchMedia?matchMedia('(max-width:900px)'):null;
  var narrow=function(){ return !!(mq&&mq.matches); };
  // A still of the opening frame, matched to the cut, so there is a picture
  // while the video loads -- and when it never plays at all.
  var poster=function(){ v.poster=narrow()?'assets/hero-poster-portrait.jpg':'assets/hero-poster.jpg'; };
  poster();
  // Reduced motion, Data Saver or a 2G connection: keep the still, no video.
  var net=navigator.connection||{};
  if((window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches)||net.saveData===true||/2g$/.test(net.effectiveType||'')){
   if(mq&&mq.addEventListener)mq.addEventListener('change',poster);
   return;
  }
  var cut=function(){ return narrow()?'assets/portrait.mp4':'assets/jerusalem-dawn.mp4'; };
  v.preload='auto';
  v.src=cut();
  var onScreen=true;
  var play=function(){ if(!onScreen||document.hidden)return; var p=v.play(); if(p&&p.catch)p.catch(function(){}); };
  play();
  v.addEventListener('loadeddata',play);
  v.addEventListener('canplay',play);
  // Browsers suspend background video on a hidden tab; resume on return.
  document.addEventListener('visibilitychange',function(){ if(!document.hidden)play(); });
  // Pause while the hero is scrolled out of view; resume when it comes back.
  if('IntersectionObserver' in window){
   new IntersectionObserver(function(es){ onScreen=es[es.length-1].isIntersecting; if(onScreen)play(); else v.pause(); }).observe(v);
  }

  // iOS Low Power Mode refuses autoplay but allows play() inside a user
  // gesture, so start the footage on the first tap, click or key.
  var gestures=['touchend','click','keydown'];
  var stop=function(){ gestures.forEach(function(t){ window.removeEventListener(t,kick,true); }); };
  var kick=function(){ if(v.paused)play(); else stop(); };
  gestures.forEach(function(t){ window.addEventListener(t,kick,true); });
  v.addEventListener('playing',stop);

  // A resize or a device rotation can call for the other cut. Re-pick on change.
  if(mq){
   var swap=function(){
    var want=cut();
    if(v.currentSrc && v.currentSrc.indexOf(want)>-1)return;
    var at=v.currentTime||0;
    poster();
    v.src=want;
    v.addEventListener('loadeddata',function once(){
     v.removeEventListener('loadeddata',once);
     try{ v.currentTime=at % (v.duration||1); }catch(e){}
     play();
    });
   };
   if(mq.addEventListener)mq.addEventListener('change',swap);
   else if(mq.addListener)mq.addListener(swap);
  }
 }catch(e){}
})();

document.addEventListener('DOMContentLoaded',function(){
// Background lecture video. It is faint, so it loads only when the About
// section is about to scroll into view, plays slightly slowed, and pauses when
// it leaves the screen. Reduced motion, Data Saver and 2G keep the poster.
(function(){
 var v=document.querySelector('#about video.bgphoto'); if(!v)return;
 var net=navigator.connection||{};
 if((window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches)||net.saveData===true||/2g$/.test(net.effectiveType||''))return;
 var slow=function(){v.defaultPlaybackRate=0.7;v.playbackRate=0.7};
 v.addEventListener('loadedmetadata',slow); v.addEventListener('play',slow);
 var play=function(){
  if(!v.getAttribute('src')){ v.preload='auto'; v.src=v.getAttribute('data-src'); }
  slow(); var p=v.play(); if(p&&p.catch)p.catch(function(){});
 };
 if(!('IntersectionObserver' in window)){ play(); return; }
 new IntersectionObserver(function(es){
  if(es[es.length-1].isIntersecting)play(); else if(v.getAttribute('src'))v.pause();
 },{rootMargin:'300px 0px'}).observe(v);
})();
});
