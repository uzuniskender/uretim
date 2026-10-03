// SERVICE WORKER (talep 101) — ana ekrana kurulan uygulamanin arka plan parcasi: acilis iskeleti ve bildirim.
//
// ONBELLEK KURALI (surum takibini bozmamak icin, mantik/surumTakip.ts):
//   * Sayfanin kendisi (gezinme) HER ZAMAN once agdan: yeni surum hemen gelir. Ag yoksa son iskelet acilir.
//   * /assets/ altindaki dosyalar adlarinda icerik ozeti tasir (degismez): onbellekten verilir.
//   * version.json ve baska kaynaklar (Supabase) HIC onbellege alinmaz: bayat veri yanlis veridir.
//   * "Simdi yenile" butun onbellegi siler (sertYenile): bu dosya da temiz baslar.
// BILDIRIM: sunucu (Web Push) sifreli yuk yollar; burada gosterilir. Tiklaninca uygulama ilgili ekranda acilir.
const ONBELLEK = 'uretim-kabuk-v1'
const EN_COK_DOSYA = 80

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== ONBELLEK) await caches.delete(k)
  await self.clients.claim()
})()))

async function kirp(c) {
  const anahtarlar = await c.keys()
  for (const k of anahtarlar.slice(0, Math.max(0, anahtarlar.length - EN_COK_DOSYA))) await c.delete(k)
}

self.addEventListener('fetch', e => {
  const r = e.request
  if (r.method !== 'GET') return
  const u = new URL(r.url)
  if (u.origin !== self.location.origin || u.pathname.endsWith('version.json')) return
  if (r.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const y = await fetch(r)
        if (y.ok) { const c = await caches.open(ONBELLEK); await c.put(self.registration.scope, y.clone()) }
        return y
      } catch {
        return (await caches.match(self.registration.scope)) || Response.error()
      }
    })())
    return
  }
  if (u.pathname.includes('/assets/')) {
    e.respondWith((async () => {
      const c = await caches.open(ONBELLEK)
      const var_ = await c.match(r)
      if (var_) return var_
      const y = await fetch(r)
      if (y.ok) { await c.put(r, y.clone()); await kirp(c) }
      return y
    })())
  }
})

self.addEventListener('push', e => {
  let y = {}
  try { y = e.data ? e.data.json() : {} } catch { y = { metin: e.data ? e.data.text() : '' } }
  e.waitUntil(self.registration.showNotification(y.baslik || 'Üretim', {
    body: y.metin || '',
    tag: y.etiket || undefined,
    renotify: !!y.etiket,
    // Giris onayi (talep 76, "Bu siz misiniz?"): cevaplanana kadar ekranda kalir, titrer.
    requireInteraction: String(y.etiket || '').startsWith('giris-'),
    vibrate: String(y.etiket || '').startsWith('giris-') ? [200, 100, 200] : undefined,
    icon: 'ikon-192.png',
    badge: 'ikon-192.png',
    data: { ekran: y.ekran || null },
  }))
})

self.addEventListener('notificationclick', e => {
  e.notification.close()
  const ekran = e.notification.data && e.notification.data.ekran
  e.waitUntil((async () => {
    const pencereler = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const acik = pencereler.find(p => p.url.startsWith(self.registration.scope))
    if (acik) { await acik.focus(); if (ekran) acik.postMessage({ tur: 'git', ekran }); return }
    await self.clients.openWindow(new URL(ekran ? `./?ekran=${encodeURIComponent(ekran)}` : './', self.registration.scope).href)
  })())
})
