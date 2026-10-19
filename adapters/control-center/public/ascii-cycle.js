/* Exact two-layer, 12-second museum fade from the user-supplied ASCII loop. */
const SEQUENCE = Object.freeze([0, 1, 2, 3, 2, 1]);
const FRAME_URLS = Object.freeze([1,2,3,4].map(n=>`/assets/ascii/${n}.png`));
const HOLD_MS=700;
const FADE_MS=1300;
const STEP_MS=HOLD_MS+FADE_MS;
const PERIOD_MS=SEQUENCE.length*STEP_MS;

export function sampleAsciiCycle(elapsedMs) {
  const ms=Number.isFinite(elapsedMs) && elapsedMs>=0 ? elapsedMs % PERIOD_MS : 0;
  const step=Math.floor(ms/STEP_MS);
  const within=ms-step*STEP_MS;
  const p=Math.max(0,Math.min(1,(within-HOLD_MS)/FADE_MS));
  return {
    baseIndex:SEQUENCE[step],
    overlayIndex:SEQUENCE[(step+1)%SEQUENCE.length],
    overlayOpacity: within<=HOLD_MS?0:0.5-0.5*Math.cos(Math.PI*p)
  };
}

/** Controls animation state only; application state and HTTP requests remain elsewhere. */
export function mountAsciiLoader({root,base,overlay,pauseButton,reduceMotion}) {
  const media=reduceMotion??window.matchMedia('(prefers-reduced-motion: reduce)');
  let visible=false, frozen=false, hidden=document.hidden, timeSpent=0;
  let lastTime=0, raf=0, baseFrame=-1, overlayFrame=-1;
  const status=root.querySelector('[data-loading-message]');
  const resetFrames=()=>{
    if(baseFrame!==0){base.src=FRAME_URLS[0];baseFrame=0;}
    overlay.style.opacity='0';
  };
  const draw=(elapsed)=>{
    const f=sampleAsciiCycle(elapsed);
    if(baseFrame!==f.baseIndex){base.src=FRAME_URLS[f.baseIndex];baseFrame=f.baseIndex;}
    if(overlayFrame!==f.overlayIndex){overlay.src=FRAME_URLS[f.overlayIndex];overlayFrame=f.overlayIndex;}
    overlay.style.opacity=String(f.overlayOpacity);
  };
  const tick=(now)=>{
    if(!visible)return;
    if(!lastTime)lastTime=now;
    if(!frozen&&!hidden&&!media.matches){
      timeSpent+=Math.min(1000,Math.max(0,now-lastTime));
      draw(timeSpent);
    }
    lastTime=now;
    raf=requestAnimationFrame(tick);
  };
  const updatePauseText=()=>{
    pauseButton.setAttribute('aria-pressed',String(frozen));
    pauseButton.textContent=frozen?'Resume animation':'Pause animation';
    pauseButton.hidden=media.matches;
  };
  const onVisibility=()=>{hidden=document.hidden;lastTime=0;};
  const onMotion=()=>{if(media.matches)resetFrames();lastTime=0;updatePauseText();};
  const onToggle=()=>{frozen=!frozen;lastTime=0;updatePauseText();};
  document.addEventListener('visibilitychange',onVisibility);
  media.addEventListener?.('change',onMotion);
  pauseButton.addEventListener('click',onToggle);
  updatePauseText();
  for(const url of FRAME_URLS){const img=new Image();img.src=url;}
  resetFrames();
  const show=(message)=>{
    if(status)status.textContent=message;
    root.hidden=false;
    root.setAttribute('aria-busy','true');
    timeSpent=0;lastTime=0;baseFrame=-1;overlayFrame=-1;
    resetFrames();
    if(!visible){visible=true;raf=requestAnimationFrame(tick);}
  };
  const hide=()=>{
    visible=false;cancelAnimationFrame(raf);raf=0;lastTime=0;
    root.hidden=true;root.removeAttribute('aria-busy');
    resetFrames();
  };
  const destroy=()=>{
    hide();pauseButton.removeEventListener('click',onToggle);
    media.removeEventListener?.('change',onMotion);
    document.removeEventListener('visibilitychange',onVisibility);
  };
  return {show,hide,destroy};
}
