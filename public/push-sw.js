// おうちノート・お打合せの記録ページのプッシュ通知を受け取る（2026年11月〜）。
// 画面の読み込みには関わらない（fetch は扱わない）。通知を押すと、そのお客様のページを開く。
self.addEventListener("install", function(){ self.skipWaiting(); });
self.addEventListener("activate", function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener("push", function(e){
  var d = {};
  try{ d = e.data ? e.data.json() : {}; }catch(err){ d = { body: e.data ? e.data.text() : "" }; }
  var title = d.title || "おうちノート";
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || "更新されました。",
    icon: "/note/icons/apple-touch-icon.png",
    badge: "/note/icons/favicon-32.png",
    data: { url: d.url || "/" },
    tag: "sumai-update",
    renotify: true
  }));
});
self.addEventListener("notificationclick", function(e){
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function(list){
    for(var i=0;i<list.length;i++){
      var c = list[i];
      try{
        var u = new URL(c.url);
        if(u.pathname.indexOf(url.split("?")[0]) === 0 && "focus" in c){ c.navigate(url).catch(function(){}); return c.focus(); }
      }catch(err){}
    }
    return self.clients.openWindow(url);
  }));
});
