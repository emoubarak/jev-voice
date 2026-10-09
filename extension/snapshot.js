// Page snapshot: the actionable elements and visible text of the page, in the shape Jev expects.
// Derived from snapshot.js in browser-use/jev-ultrafast (MIT License, Copyright (c) 2026 Browser Use,
// https://github.com/browser-use/jev-ultrafast), extended with same-origin iframes, open shadow roots and
// design-system web components. panel.js checks the page key and element guards it returns before acting.
// See THIRD_PARTY_NOTICES.md.
(() => {
  if (!document.body) return null;
  const cache = window.__jevFast ||= {ids:new WeakMap(), nodes:new Map(), next:1};
  const identity = e => {
    if (!cache.ids.has(e)) cache.ids.set(e,cache.next++);
    const id=cache.ids.get(e); cache.nodes.set(id,e); return id;
  };
  for (const [id,e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  // Same-origin iframes join the snapshot; their rects are shifted into top-page coordinates.
  cache.frames = () => {
    const out=[{doc:document,win:window,el:null,ox:0,oy:0,clip:{l:0,t:0,r:innerWidth,b:innerHeight}}];
    for (const f of document.querySelectorAll('iframe')) {
      let d=null; try { d=f.contentDocument; } catch (err) {}
      if (!d?.body || !f.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) continue;
      const r=f.getBoundingClientRect();
      if (r.width<=0 || r.height<=0) continue;
      out.push({doc:d,win:f.contentWindow,el:f,ox:r.x+f.clientLeft,oy:r.y+f.clientTop,
        clip:{l:Math.max(0,r.x),t:Math.max(0,r.y),r:Math.min(innerWidth,r.right),b:Math.min(innerHeight,r.bottom)}});
    }
    return out;
  };
  cache.frameOf = e => cache.frames().find(f=>f.doc===e.ownerDocument);
  const frames=cache.frames();
  const safe = e => !['password','file','hidden'].includes(e.type);
  const visible = e => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const name = (e,seen=new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced=(e.getAttribute('aria-labelledby')||'').split(/\s+/)
      .map(id=>name(e.ownerDocument.getElementById(id),seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels||[])].map(l=>name(l,seen)).filter(Boolean).join(' ') ||
      (['button','submit','reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName==='INPUT' ? '' : [...e.childNodes].map(n=>n.nodeType===3 ? n.textContent :
        n.nodeType===1 && n.getAttribute('aria-hidden')!=='true' ? name(n,seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };
  const roles=['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio','treeitem',
    'option','gridcell','combobox','textbox','searchbox','spinbutton'];
  const selector='a[href],button,input,textarea,select,summary,[contenteditable="true"],[tabindex="0"],[href],'+
    roles.map(role=>'[role="'+role+'"]').join(',');
  const role = e => {
    const explicit=e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName==='BUTTON' || e.tagName==='SUMMARY') return 'button';
    if (e.tagName==='A') return 'link';
    if (e.tagName==='SELECT') return 'combobox';
    if (e.tagName==='TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName==='INPUT') {
      if (['checkbox','radio'].includes(e.type)) return e.type;
      if (['button','submit','reset','image'].includes(e.type)) return 'button';
      if (e.type==='search') return 'searchbox';
      if (e.type==='number') return 'spinbutton';
      if (['text','email','url','tel'].includes(e.type)) return 'textbox';
    }
    // Design-system web components (e.g. <ds-link>, <ds-select>, <ds-select-option>) carry no ARIA role.
    if (e.tagName.includes('-') && e.hasAttribute('href')) return 'link';
    if (e.tagName.includes('-') && e.tabIndex>=0) {
      const t=e.tagName.toLowerCase();
      return /option$/.test(t) ? 'option' : /select/.test(t) ? 'combobox' : 'button';
    }
    return null;
  };
  // A custom select shows its current choice inside its shadow root, not in its light DOM (the options).
  const customLabel = e => e.shadowRoot && e.tagName.includes('-') && role(e)==='combobox' ?
    (e.shadowRoot.querySelector('[class*="label"]')?.textContent||'').trim() : '';
  // Matching elements of a document and of every open shadow root inside it.
  const deep = (root,out=[]) => {
    for (const e of root.querySelectorAll(selector)) out.push(e);
    for (const h of root.querySelectorAll('*')) if (h.shadowRoot) deep(h.shadowRoot,out);
    return out;
  };
  cache.pageKey=()=>{ const fs=cache.frames();
    return [performance.timeOrigin,fs.map(f=>f.win.location.href).join(' | '),scrollX,
      fs.map(f=>f.win.scrollY).join(','),innerWidth,innerHeight,
      fs.flatMap(f=>[...f.doc.querySelectorAll('input,textarea,select')]).filter(safe)
        .map(e=>[identity(e),e.value,e.checked,e.selectedIndex,e.disabled,e.readOnly])]; };
  cache.guard=e=>{
    if (!e?.isConnected || !visible(e)) return null;
    const scope=e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [identity(e),role(e),name(e),e.value??null,e.checked??null,e.selectedIndex??null,
      e.readOnly??null,e.matches(':disabled'),e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'),e.getAttribute('aria-checked'),e.getAttribute('aria-selected'),
      e.getAttribute('href'),scope?.innerText?.slice(0,6000)||''];
  };
  const actions=[];
  for (const F of frames) for (const e of deep(F.doc)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r=e.getBoundingClientRect(), x=r.x+r.width/2+F.ox, y=r.y+r.height/2+F.oy, rname=role(e);
    if (!rname || r.width<=0 || r.height<=0 || x<F.clip.l || y<F.clip.t || x>=F.clip.r || y>=F.clip.b) continue;
    if (rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    // A menu row wrapping its own link/button: offer the inner control, whose centre is the clickable text.
    if (rname==='menuitem' && e.querySelector('a[href],button,[href],[role="button"],[role="link"],[role="treeitem"]')) continue;
    // Fallback: the visible text, even under aria-hidden (some menus hide their labels from ARIA).
    const shown=(e.innerText||'').trim().replace(/\s+/g,' ').slice(0,100);
    const base={node:identity(e),role:rname,label:customLabel(e)||name(e)||shown||rname,
      rect:{x:r.x+F.ox,y:r.y+F.oy,w:r.width,h:r.height}};
    for (const key of ['checked','selected','expanded']) {
      const value=e.getAttribute('aria-'+key);
      if (value!==null) base[key]=value;
    }
    if (['checkbox','radio'].includes(e.type)) base.checked=String(e.checked);
    if (e.tagName==='SELECT') {
      for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
        actions.push({...base,kind:'select',value:o.value,
          current_value:[...e.selectedOptions].map(o=>o.label).join(', '),label:base.label+' → '+o.label});
    } else {
      const editable=!e.readOnly && e.getAttribute('aria-readonly')!=='true' &&
        (['textbox','searchbox','spinbutton'].includes(rname) ||
          (rname==='combobox' && ['INPUT','TEXTAREA'].includes(e.tagName)));
      const value='value' in e ? String(e.value) :
        e.isContentEditable || rname==='combobox' ? e.innerText.trim() : '';
      actions.push({...base,kind:editable?'fill':'click',value});
      if (editable) actions.push({...base,kind:'click',value,label:'Open '+base.label});
    }
  }
  const words=[]; let length=0;
  for (const F of frames) {
    const walker=F.doc.createTreeWalker(F.doc.body,NodeFilter.SHOW_TEXT), range=F.doc.createRange(); let node;
    while ((node=walker.nextNode()) && length<6000) {
      const value=node.textContent.trim(), parent=node.parentElement;
      if (!value || !parent || parent.closest('script,style,noscript,template') ||
          !parent.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) continue;
      range.selectNodeContents(node); const r=range.getBoundingClientRect();
      const t=r.top+F.oy, b=r.bottom+F.oy, l=r.left+F.ox, rr=r.right+F.ox;
      if (r.width>0 && r.height>0 && b>F.clip.t && t<F.clip.b && rr>F.clip.l && l<F.clip.r) {
        words.push(value); length+=value.length;
      }
    }
  }
  const text=words.join('\n').slice(0,6000), height=document.documentElement.scrollHeight;
  const frameMore=frames.slice(1).some(F=>F.win.scrollY+F.win.innerHeight<F.doc.documentElement.scrollHeight-2);
  const frameBack=frames.slice(1).some(F=>F.win.scrollY>0);
  const page_key=cache.pageKey(), guards={};
  for (const a of actions) if (!(a.node in guards)) guards[a.node]=cache.guard(cache.nodes.get(a.node));
  // Compare meaning and identity. Geometry is always resolved and hit-tested just before input.
  const semantics=actions.map(({rect,...action})=>action);
  const marker=[performance.timeOrigin,page_key[1],scrollX,page_key[3],innerWidth,innerHeight,
    document.title,text,semantics,page_key[6]];
  const omitted_actions=Math.max(0,actions.length-250);
  actions.splice(250);
  actions.forEach((a,i)=>a.id='e'+(i+1));
  if (scrollY+innerHeight<height-2 || frameMore) actions.push({id:'scroll_down',kind:'scroll',label:'Scroll down',delta:560});
  if (scrollY>0 || frameBack) actions.push({id:'scroll_up',kind:'scroll',label:'Scroll up',delta:-560});
  actions.push({id:'wait',kind:'wait',label:'Wait for the page to update'});
  return {url:location.href,title:document.title,w:innerWidth,h:innerHeight,text,
    scroll:{y:scrollY,height},actions,marker,page_key,guards,omitted_actions};
})()
