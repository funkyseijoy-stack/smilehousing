// おうちノート（/note/）・お打合せの記録ページ（/kiroku/）の「🔔 更新のお知らせを受け取る」（プッシュ通知、2026年11月〜）。
// 2026年11月〜：「お知らせの受け取り方」— お客様が名前を書いて アプリ／LINE／メール を選ぶ（ご家族それぞれ）。
// 使い方：SumaiPush.init({p, t, page:"note"|"kiroku"}) → SumaiPush.mount(要素, {dismissKey, onHowTo, hideWhenDone})
// 登録は /api/push（netlify/functions/push.mts）、通知の受け取りは /push-sw.js。
(function(){
  var cfg = null, swReg = null, pubKey = null, lastState = null, mounts = [], entries = null;
  var ua = navigator.userAgent || "";
  var inLine = /\bLine\//i.test(ua);
  var isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  function standalone(){ try{ return !!(navigator.standalone || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)); }catch(e){ return false; } }
  function supported(){ return ("serviceWorker" in navigator) && ("PushManager" in window) && ("Notification" in window); }
  function lsKey(){ return "sumaiPush:" + (cfg && cfg.p); }
  function doneKey(){ return "sumaiNotifyDone:" + (cfg && cfg.p); }
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
      ".spush .sperr{color:#b3412f;font-size:.85rem;margin-top:6px;}"+
      ".spush .spok{color:#2f6b45;font-size:.85rem;margin-top:6px;font-weight:700;}"+
      ".spush .splist{margin:8px 0 2px;display:flex;flex-direction:column;gap:6px;}"+
      ".spush .spe{display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #e9e2da;border-radius:12px;padding:8px 10px;}"+
      ".spush .spe b{font-weight:700;}.spush .spe .spm{color:#5c534d;font-size:.85rem;flex:1;}"+
      ".spush .spx{border:none;background:none;color:#9a8b80;font:inherit;font-size:.85rem;text-decoration:underline;cursor:pointer;padding:2px 4px;}"+
      ".spush .spch{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;}"+
      ".spush .spc{flex:1 1 0;min-width:84px;border:1.5px solid #ded5cb;background:#fff;border-radius:12px;padding:9px 6px;font:inherit;font-size:.88rem;font-weight:700;color:#2f2925;cursor:pointer;}"+
      ".spush .spc.on{border-color:#5d5049;background:#5d5049;color:#fff;}"+
      ".spush .spsub{margin-top:8px;padding:10px;border-radius:12px;background:#f6f1eb;}";
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
    // 住まいるアプリ（スタッフ用）をホーム画面から開いた中でおうちノートを見ているときは、登録させない
    // （登録すると、お客様向けの通知が住まいるアプリに届き、アイコンに数字が付いてしまうため）
    try{ if(standalone() && localStorage.getItem("sumairu_staff_token")) return { s: "staffapp" }; }catch(e){}
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
  var KIND_LABEL = { push: "📱 アプリ", line: "💬 LINE", email: "✉️ メール" };
  // アプリで受け取れない理由（この端末の状態ごと）
  function appNote(st, o){
    if(st.s === "line") return 'LINEの中の画面では設定できません。右上の「⋯」（︙）から「ブラウザで開く」（Safari・Chrome）を選んで開き直してください。';
    if(st.s === "ios") return 'iPhoneは、このページを「ホーム画面に追加」して、ホーム画面のアイコンから開くと、アプリで受け取れます。'+(o.onHowTo?'<div class="spr"><button type="button" class="spb" data-sphow>ホーム画面への追加の仕方</button></div>':'');
    if(st.s === "staffapp") return 'いまは住まいるアプリ（スタッフ用）の中で開いているため、ここでは登録できません。';
    if(st.s === "unsupported") return 'この端末・ブラウザでは、アプリの通知は受け取れません。LINEかメールをお選びください。';
    if(st.s === "denied") return '通知がオフになっています。端末の「設定」で、このアプリ（ブラウザ）の通知を許可すると受け取れます。';
    return "";
  }
  function html(st, m){
    var o = m.opts || {};
    var list = entries || [];
    var head = '<div class="sph">🔔 お知らせの受け取り方</div>';
    var rows = list.map(function(x){
      var how = x.kind === "push" ? "📱 アプリ" + (x.mine ? "（このスマホ）" : "") : x.kind === "email" ? "✉️ メール（" + esc(x.email) + "）" : "💬 LINE";
      return '<div class="spe"><b>' + esc(x.name || "お名前なし") + '</b><span class="spm">' + how + '</span><button type="button" class="spx" data-spdel="' + esc(x.id) + '" data-spkind="' + esc(x.kind) + '" data-spmine="' + (x.mine ? "1" : "") + '">削除</button></div>';
    }).join("");
    var adding = m.adding || !list.length;
    var out = '<div class="spush' + (list.length ? ' on' : '') + '">' + head;
    out += '<div class="spt">' + (list.length ? '更新があったとき、次の方へお知らせします。' : '更新があったとき、どの方法でお知らせするかを選べます。ご家族それぞれ登録できます。') + '</div>';
    if(rows) out += '<div class="splist">' + rows + '</div>';
    if(!adding){
      out += '<div class="spr"><button type="button" class="spb" data-spadd>＋ ほかの方を登録する</button></div>';
    } else {
      var mt = m.method || "";
      out += '<div class="spr"><input type="text" maxlength="20" data-spname placeholder="お名前（例：奥様・ご主人）" value="' + esc(m.draft || "") + '"></div>';
      out += '<div class="spch">' + ["push", "line", "email"].map(function(k){ return '<button type="button" class="spc' + (mt === k ? ' on' : '') + '" data-spm="' + k + '">' + KIND_LABEL[k] + '</button>'; }).join("") + '</div>';
      if(mt === "push"){
        var note = st.s === "on" ? "" : appNote(st, o);
        out += '<div class="spsub">' + (st.s === "on" ? 'このスマホはすでにアプリで受け取っています。' :
          note ? note : 'このスマホに通知でお知らせします。<div class="spr"><button type="button" class="spb" data-spon>このスマホで受け取る</button></div>') + '</div>';
      } else if(mt === "line"){
        out += '<div class="spsub">いつもの公式LINEにお知らせが届きます。<div class="spr"><button type="button" class="spb" data-spline>LINEで受け取る</button></div></div>';
      } else if(mt === "email"){
        out += '<div class="spsub"><div class="spr" style="margin-top:0;"><input type="email" maxlength="200" data-spmail placeholder="メールアドレス" value="' + esc(m.mailDraft || "") + '" autocomplete="email" inputmode="email"></div>' +
          '<div class="spr"><button type="button" class="spb" data-spmailgo>メールで受け取る</button></div></div>';
      }
      if(list.length) out += '<div class="spr"><button type="button" class="spl" data-spcancel>やめる</button></div>';
    }
    if(o.dismissKey && !list.length) out += '<div class="spr"><button type="button" class="spl" data-spno>あとで</button></div>';
    if(m.err) out += '<div class="sperr">' + esc(m.err) + '</div>';
    if(m.ok) out += '<div class="spok">' + esc(m.ok) + '</div>';
    return out + '</div>';
  }
  function paint(m){
    if(!m.el || !document.body.contains(m.el)) return;
    var o = m.opts || {};
    var done = (lastState && lastState.s === "on") || !!lsGet(doneKey());
    if(o.dismissKey && lsGet(o.dismissKey) && !done){ m.el.innerHTML = ""; return; }
    if(o.hideWhenDone && done){ m.el.innerHTML = ""; return; }
    if(o.onlyReady && lastState && lastState.s !== "ready"){ m.el.innerHTML = ""; return; }
    m.el.innerHTML = lastState ? html(lastState, m) : "";
  }
  function paintAll(){ mounts = mounts.filter(function(m){ return m.el && document.body.contains(m.el); }); mounts.forEach(paint); }
  async function loadEntries(){
    try{
      var ep = "";
      try{ var reg = supported() && await navigator.serviceWorker.getRegistration("/"); var sub = reg && await reg.pushManager.getSubscription(); if(sub) ep = sub.endpoint; }catch(e){}
      var r = await fetch("/api/push", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ p: cfg.p, t: cfg.t, action: "list", endpoint: ep }) });
      var j = await r.json().catch(function(){ return {}; });
      entries = r.ok && j.entries ? j.entries : (entries || []);
    }catch(e){ entries = entries || []; }
  }
  async function refresh(){ lastState = await state(); await loadEntries(); paintAll(); }
  async function api(action, extra){
    var r = await fetch("/api/push", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ p: cfg.p, t: cfg.t, action: action, page: cfg.page }, extra || {})) });
    var j = await r.json().catch(function(){ return {}; });
    if(!r.ok) throw new Error(j.error || "server");
    return j;
  }
  function errText(c){
    return c === "denied" ? "通知が許可されませんでした。端末の「設定」から許可できます。" : c === "dismissed" ? "通知の許可が選ばれませんでした。もう一度押してください。" :
      c === "limit_reached" ? "登録できる数がいっぱいです。担当者にお知らせください。" : c === "bad_email" ? "メールアドレスを確かめてください。" :
      c === "no_name" ? "お名前を入れてください。" : "登録できませんでした。通信状況を確認して、もう一度お試しください。";
  }
  function wire(m){
    m.el.addEventListener("input", function(e){
      if(e.target.matches("[data-spname]")) m.draft = e.target.value;
      if(e.target.matches("[data-spmail]")) m.mailDraft = e.target.value;
    });
    m.el.addEventListener("click", async function(e){
      var o = m.opts || {};
      if(e.target.closest("[data-spno]")){ lsSet(o.dismissKey, "1"); paint(m); return; }
      if(e.target.closest("[data-sphow]")){ if(o.onHowTo) o.onHowTo(); return; }
      if(e.target.closest("[data-spadd]")){ m.adding = true; m.method = ""; m.err = ""; m.ok = ""; paint(m); return; }
      if(e.target.closest("[data-spcancel]")){ m.adding = false; m.method = ""; m.err = ""; paint(m); return; }
      var mb = e.target.closest("[data-spm]");
      if(mb){ m.method = mb.getAttribute("data-spm"); m.err = ""; m.ok = ""; paint(m); return; }
      var del = e.target.closest("[data-spdel]");
      if(del){
        if(!window.confirm("この受け取り方を削除しますか？")) return;
        try{
          if(del.getAttribute("data-spmine")) await unsubscribe();
          else await api("remove", { id: del.getAttribute("data-spdel") });
          m.ok = "削除しました";
        }catch(err){ m.err = errText(err && err.message); }
        await refresh(); return;
      }
      var name = String(m.draft || "").trim();
      var go = e.target.closest("[data-spon],[data-spline],[data-spmailgo]");
      if(!go) return;
      if(!name){ m.err = "お名前を入れてください（どなたへのお知らせか分かるように）"; m.ok = ""; paint(m); return; }
      go.disabled = true; var orig = go.textContent; go.textContent = "登録しています…"; m.err = ""; m.ok = "";
      try{
        if(go.hasAttribute("data-spon")) await subscribe(name);
        else if(go.hasAttribute("data-spline")) await api("addLine", { name: name });
        else {
          var mail = String(m.mailDraft || "").trim();
          if(!mail){ throw new Error("bad_email"); }
          await api("addEmail", { name: name, email: mail });
        }
        lsSet(doneKey(), "1");
        m.adding = false; m.method = ""; m.draft = ""; m.mailDraft = "";
        m.ok = "登録しました。更新があったらお知らせします。";
      }catch(err){ m.err = errText(err && err.message); go.disabled = false; go.textContent = orig; }
      await refresh();
    });
  }
  // ページを開いたら、アプリのアイコンの数字と、届いている通知を消す
  function clearBadge(){
    try{ if(navigator.clearAppBadge) navigator.clearAppBadge().catch(function(){}); }catch(e){}
    try{ if(window.caches) caches.open("sumai-badge").then(function(c){ return c.put("/__badge", new Response("0")); }).catch(function(){}); }catch(e){}
    try{ if(navigator.serviceWorker) navigator.serviceWorker.getRegistration("/").then(function(r){ if(r && r.getNotifications) r.getNotifications().then(function(ns){ ns.forEach(function(n){ n.close(); }); }); }).catch(function(){}); }catch(e){}
  }
  document.addEventListener("visibilitychange", function(){ if(document.visibilityState === "visible" && cfg) clearBadge(); });
  window.SumaiPush = {
    init: function(c){
      cfg = c; addHead(); css(); clearBadge();
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
