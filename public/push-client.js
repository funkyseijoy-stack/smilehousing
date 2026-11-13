// おうちノート（/note/）・お打合せの記録ページ（/kiroku/）の「🔔 更新のお知らせを受け取る」（プッシュ通知、2026年11月〜）。
// 使い方：SumaiPush.init({p, t, page:"note"|"kiroku"}) → SumaiPush.mount(要素, {dismissKey, onHowTo, hideWhenDone})
// 登録は /api/push（netlify/functions/push.mts）、通知の受け取りは /push-sw.js。
(function(){
  var cfg = null, swReg = null, pubKey = null, lastState = null, mounts = [];
  var ua = navigator.userAgent || "";
  var inLine = /\bLine\//i.test(ua);
  var isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  function standalone(){ try{ return !!(navigator.standalone || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)); }catch(e){ return false; } }
  function supported(){ return ("serviceWorker" in navigator) && ("PushManager" in window) && ("Notification" in window); }
  function lsKey(){ return "sumaiPush:" + (cfg && cfg.p); }
  function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
  function lsSet(k, v){ try{ if(v==null) localStorage.removeItem(k); else localStorage.setItem(k, v); }catch(e){} }
  function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]; }); }
  function b64ToBytes(b64){
    var pad = "=".repeat((4 - b64.length % 4) % 4);
    var s = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    var a = new Uint8Array(s.length); for(var i=0;i<s.length;i++) a[i] = s.charCodeAt(i); return a;
  }
  function addHead(){
    if(!cfg) return;
    if(!document.querySelector('link[rel="manifest"]')){
      var l = document.createElement("link"); l.rel = "manifest";
      l.href = "/api/web-manifest?page=" + cfg.page + "&p=" + encodeURIComponent(cfg.p) + "&t=" + encodeURIComponent(cfg.t);
      document.head.appendChild(l);
    }
    [["apple-mobile-web-app-capable","yes"],["mobile-web-app-capable","yes"],["apple-mobile-web-app-title", cfg.page==="kiroku"?"お打合せの記録":"おうちノート"]].forEach(function(m){
      if(document.querySelector('meta[name="'+m[0]+'"]')) return;
      var e = document.createElement("meta"); e.name = m[0]; e.content = m[1]; document.head.appendChild(e);
    });
  }
  function css(){
    if(document.getElementById("spushCss")) return;
    var s = document.createElement("style"); s.id = "spushCss";
    s.textContent = ".spush{background:#fffdfa;border:1.5px solid #e9e2da;border-radius:16px;padding:12px 14px;margin:0 0 14px;font-size:.9rem;color:#2f2925;}"+
      ".spush .sph{font-weight:700;font-size:.95rem;margin-bottom:4px;display:flex;align-items:center;gap:6px;}"+
      ".spush .spt{color:#5c534d;line-height:1.6;}"+
      ".spush .spr{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center;}"+
      ".spush input{flex:1;min-width:140px;font:inherit;font-size:16px;padding:9px 10px;border:1.5px solid #ded5cb;border-radius:12px;background:#fff;box-sizing:border-box;}"+
      ".spush .spb{border:none;border-radius:999px;background:#5d5049;color:#fff;font:inherit;font-weight:700;padding:10px 16px;cursor:pointer;}"+
      ".spush .spb:disabled{opacity:.5;}"+
      ".spush .spl{background:none;border:none;color:#7a6a60;font:inherit;font-size:.85rem;text-decoration:underline;cursor:pointer;padding:4px 0;}"+
      ".spush.on{background:#e3efe7;border-color:#b9d4c2;}"+
      ".spush .sperr{color:#b3412f;font-size:.85rem;margin-top:6px;}";
    document.head.appendChild(s);
  }
  async function getReg(){
    if(swReg) return swReg;
    swReg = await navigator.serviceWorker.register("/push-sw.js", { scope: "/" });
    return swReg;
  }
  async function getKey(){
    if(pubKey) return pubKey;
    var r = await fetch("/api/push?p=" + encodeURIComponent(cfg.p) + "&t=" + encodeURIComponent(cfg.t), { cache: "no-store" });
    var j = await r.json(); if(!r.ok || !j.publicKey) throw new Error("key");
    pubKey = j.publicKey; return pubKey;
  }
  // いまの状態：on／line／ios／unsupported／denied／ready
  async function state(){
    if(inLine) return { s: "line" };
    if(!supported()) return { s: isIOS && !standalone() ? "ios" : "unsupported" };
    if(Notification.permission === "denied") return { s: "denied" };
    try{
      var reg = await navigator.serviceWorker.getRegistration("/");
      var sub = reg && await reg.pushManager.getSubscription();
      if(sub){
        var r = await fetch("/api/push", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ p: cfg.p, t: cfg.t, action: "status", endpoint: sub.endpoint }) });
        var j = await r.json().catch(function(){ return {}; });
        if(r.ok && j.registered){ lsSet(lsKey(), j.name || "1"); return { s: "on", name: j.name || "" }; }
      }
    }catch(e){}
    lsSet(lsKey(), null);
    return { s: "ready" };
  }
  async function subscribe(name){
    var perm = await Notification.requestPermission();
    if(perm !== "granted") throw new Error(perm === "denied" ? "denied" : "dismissed");
    var reg = await getReg();
    await navigator.serviceWorker.ready;
    var key = await getKey();
    var sub = await reg.pushManager.getSubscription();
    if(!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
    var r = await fetch("/api/push", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ p: cfg.p, t: cfg.t, action: "subscribe", sub: sub.toJSON(), name: name, page: cfg.page }) });
    var j = await r.json().catch(function(){ return {}; });
    if(!r.ok) throw new Error(j.error || "server");
    lsSet(lsKey(), name || "1");
  }
  async function unsubscribe(){
    try{
      var reg = await navigator.serviceWorker.getRegistration("/");
      var sub = reg && await reg.pushManager.getSubscription();
      if(sub){
        await fetch("/api/push", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ p: cfg.p, t: cfg.t, action: "unsubscribe", endpoint: sub.endpoint }) });
        await sub.unsubscribe().catch(function(){});
      }
    }catch(e){}
    lsSet(lsKey(), null);
  }
  function html(st, m){
    var o = m.opts || {};
    var head = '<div class="sph">🔔 更新のお知らせ</div>';
    if(st.s === "on") return '<div class="spush on">'+head+'<div class="spt">この端末で受け取っています'+(st.name && st.name!=="1" ? '（'+esc(st.name)+'）' : '')+'。更新があると、スマホに通知が届きます。</div>'+
      '<div class="spr"><button type="button" class="spl" data-spoff>受け取りをやめる</button></div></div>';
    if(st.s === "line") return '<div class="spush">'+head+'<div class="spt">LINEの中の画面では設定できません。右上の「⋯」（︙）から「ブラウザで開く」（Safari・Chrome）を選んで開き直してください。</div>'+(o.dismissKey?'<div class="spr"><button type="button" class="spl" data-spno>あとで</button></div>':'')+'</div>';
    if(st.s === "ios") return '<div class="spush">'+head+'<div class="spt">iPhoneは、このページを「ホーム画面に追加」して、ホーム画面のアイコンから開くと、更新のお知らせを受け取れます。</div>'+
      '<div class="spr">'+(o.onHowTo?'<button type="button" class="spb" data-sphow>ホーム画面への追加の仕方</button>':'')+(o.dismissKey?'<button type="button" class="spl" data-spno>あとで</button>':'')+'</div></div>';
    if(st.s === "unsupported") return o.dismissKey ? "" : '<div class="spush">'+head+'<div class="spt">この端末・ブラウザでは受け取れません。</div></div>';
    if(st.s === "denied") return '<div class="spush">'+head+'<div class="spt">通知がオフになっています。端末の「設定」で、このアプリ（ブラウザ）の通知を許可すると受け取れます。</div></div>';
    return '<div class="spush">'+head+'<div class="spt">更新があったとき、このスマホに通知でお知らせします。ご家族それぞれのスマホで設定できます。</div>'+
      '<div class="spr"><input type="text" maxlength="20" data-spname placeholder="お名前（例：奥様・ご主人）" value="'+esc(m.draft||"")+'"><button type="button" class="spb" data-spon>受け取る</button></div>'+
      (o.dismissKey?'<div class="spr"><button type="button" class="spl" data-spno>あとで</button></div>':'')+
      (m.err?'<div class="sperr">'+esc(m.err)+'</div>':'')+'</div>';
  }
  function paint(m){
    if(!m.el || !document.body.contains(m.el)) return;
    var o = m.opts || {};
    if(o.dismissKey && lsGet(o.dismissKey) && lastState && lastState.s !== "on"){ m.el.innerHTML = ""; return; }
    if(o.hideWhenDone && lastState && lastState.s === "on"){ m.el.innerHTML = ""; return; }
    if(o.onlyReady && lastState && lastState.s !== "ready"){ m.el.innerHTML = ""; return; }
    m.el.innerHTML = lastState ? html(lastState, m) : "";
  }
  function paintAll(){ mounts = mounts.filter(function(m){ return m.el && document.body.contains(m.el); }); mounts.forEach(paint); }
  async function refresh(){ lastState = await state(); paintAll(); }
  function wire(m){
    m.el.addEventListener("click", async function(e){
      var o = m.opts || {};
      if(e.target.closest("[data-spno]")){ lsSet(o.dismissKey, "1"); paint(m); return; }
      if(e.target.closest("[data-sphow]")){ if(o.onHowTo) o.onHowTo(); return; }
      if(e.target.closest("[data-spoff]")){
        if(!window.confirm("この端末で、更新のお知らせの受け取りをやめますか？")) return;
        await unsubscribe(); await refresh(); return;
      }
      var b = e.target.closest("[data-spon]");
      if(b){
        var inp = m.el.querySelector("[data-spname]");
        var name = ((inp && inp.value) || "").trim();
        m.draft = name;
        if(!name){ m.err = "お名前を入れてください（どなたのスマホか分かるように）"; paint(m); return; }
        b.disabled = true; b.textContent = "設定しています…"; m.err = "";
        try{ await subscribe(name); await refresh(); }
        catch(err){
          var c = err && err.message;
          m.err = c === "denied" ? "通知が許可されませんでした。端末の「設定」から許可できます。" : c === "dismissed" ? "通知の許可が選ばれませんでした。もう一度押してください。" :
            c === "limit_reached" ? "登録できる端末の数がいっぱいです。担当者にお知らせください。" : "設定できませんでした。通信状況を確認して、もう一度お試しください。";
          await refresh();
        }
      }
    });
  }
  window.SumaiPush = {
    init: function(c){
      cfg = c; addHead(); css();
      if(supported() && !inLine){ getReg().catch(function(){}); }
      return refresh();
    },
    mount: function(el, opts){
      if(!el) return;
      var m = mounts.filter(function(x){ return x.el === el; })[0];
      if(!m){ m = { el: el, opts: opts || {} }; mounts.push(m); wire(m); }
      else m.opts = opts || m.opts;
      paint(m);
    },
    refresh: refresh,
    state: function(){ return lastState; }
  };
})();
