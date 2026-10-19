/* Static, delayed status overlay. The backdrop is the same exact user-approved ASCII
 * image as the main interface; brief requests have no splash or animation.
 * The legacy module filename is retained to preserve existing static routing.
 */
export function mountStaticLoader({root}) {
  const status=root.querySelector('[data-loading-message]');
  let timer=null;
  const hide=()=>{
    if(timer!==null){clearTimeout(timer);timer=null;}
    root.hidden=true;
    root.removeAttribute('aria-busy');
  };
  const show=(message)=>{
    if(status)status.textContent=message;
    if(timer!==null){clearTimeout(timer);timer=null;}
    // Avoid a flash of a full-screen loading state for fast requests.
    timer=setTimeout(()=>{
      timer=null;root.hidden=false;root.setAttribute('aria-busy','true');
    },280);
  };
  return {show,hide,destroy:hide};
}
