/* OAuth behavior only. No CSS, artwork, canvas, theme or original HTML changes. */
(function(){
  'use strict';
  const render=window.renderPortalPage,show=window.showPortalView,logout=window.portalSignOut;
  let configured=false,loaded=false,busy=false;
  const $=id=>document.getElementById(id);
  tpPageInfo.auth=['ACCOUNT ACCESS','Your devices. One quiet place.','Sign in through the existing approved identity provider. Device-local authority is unchanged.'];
  async function request(path,method='GET') {
    const response=await fetch(path,{method,credentials:'same-origin',mode:'same-origin',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000),headers:{accept:'application/json',...(method==='POST'?{'content-type':'application/json','x-tetherplane-intent':'oauth'}:{})},...(method==='POST'?{body:'{}'}:{})});
    const data=await response.json();if(!response.ok)throw new Error(data?.error?.message||'Browser sign-in unavailable.');return data;
  }
  window.renderPortalPage=function(view) {
    if(view!=='auth')return render.call(window,view);
    return tpGrid([
      tpCard('SIGN-IN // PKCE','Use approved identity infrastructure',
        'Your browser opens the existing identity provider. The local server keeps access credentials out of browser storage.',
        `<button id="tp-oauth-signin" class="mono-btn rounded-xl tp-action" onclick="portalOAuthSignIn()" ${!configured||busy?'disabled':''}>[ Sign in ]</button>${tpButton('Back to Plane','home')}<p class="tp-error" id="tp-auth-error" hidden></p>`),
      tpCard('RELAY AUTHORITY','Account access is explicit.',
        !loaded?'Checking local sign-in configuration.':configured?'A local client configuration is loaded. The identity provider and relay must independently authorize your account.':'Sign-in is disabled until an approved portal client and exact loopback callback are configured. No replacement client is created.',
        tpButton('Security guidance','security'))
    ]);
  };
  window.showPortalView=function(view){return show.call(window,view==='auth'&&tpDemo.session?'control':view);};
  window.portalOAuthSignIn=async function() {
    if(!configured||busy)return;busy=true;const button=$('tp-oauth-signin');if(button)button.disabled=true;
    try {
      const data=await request('/api/oauth/start','POST');const target=new URL(data.authorizationUrl);
      if(target.protocol!=='https:'||target.username||target.password)throw new Error('Sign-in destination was rejected.');
      window.location.assign(target.href);
    } catch(e) {
      const error=$('tp-auth-error');if(error){error.textContent=e.message;error.hidden=false;}
      busy=false;if(button)button.disabled=false;
    }
  };
  window.tpSignInUnavailable=window.portalOAuthSignIn;
  window.portalLogin=function(e){e?.preventDefault();return window.portalOAuthSignIn();};
  window.portalSignOut=async function(){try{await request('/api/oauth/cancel','POST');}catch{}return logout.call(window);};
  request('/api/oauth/config').then(data=>{configured=data.configured===true;loaded=true;if(tpCurrentView==='auth')window.renderActivePortalPage();}).catch(()=>{loaded=true;configured=false;if(tpCurrentView==='auth')window.renderActivePortalPage();});
})();
