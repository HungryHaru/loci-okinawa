'use strict';

// ===== 設定 =====
const STORAGE_KEY = 'loci-okinawa-v1';
const KEY_STORAGE = 'loci-okinawa-apikey';
const NOTIFY_STORAGE = 'loci-okinawa-notify-url'; // LINE 通知用 Apps Script の URL（?key=合言葉 付き）
// 復習の間隔（日）。正解が続くほど のばす（エビングハウスの忘却曲線）。忘れたら最初に戻る
const INTERVALS = [1, 3, 7, 14, 30, 60, 120];
// 沖縄県のおおよその範囲
const BOUNDS = { north: 27.2, south: 24.0, west: 122.9, east: 131.4 };
const START = { lat: 26.2148, lng: 127.6853 }; // 国際通り付近

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ===== 状態 =====
let state = ensureState({ palaces: [] }); // 起動時に IndexedDB から読み込み直す
let map, pano, sv, Place;
let searchHits = [];
let markers = [], routeLine = null, lastValid = null;
let mode = 'build';      // build | review | list
let editingId = null;    // 編集中のロケーションID
let review = null;       // { queue, idx, revealed, ok, ng }

// ===== 保存まわり =====
function newPalace(name) { return { id: uid(), name, loci: [], createdAt: Date.now() }; }

// データ本体は IndexedDB に保存（localStorage の約5MB制限を避けるため）
async function loadState() {
  try {
    const s = await kv.get('state');
    if (s && Array.isArray(s.palaces)) return ensureState(s);
  } catch (e) { console.error(e); }
  // 旧バージョン（localStorage）からの引っ越し
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (s && Array.isArray(s.palaces)) {
      const st = ensureState(s);
      await kv.set('state', st);
      localStorage.removeItem(STORAGE_KEY);
      return st;
    }
  } catch (e) { console.error(e); }
  return ensureState({ palaces: [] });
}
function ensureState(s) {
  if (!s.palaces.length) s.palaces.push(newPalace('はじめての宮殿'));
  if (!s.palaces.some((p) => p.id === s.currentId)) s.currentId = s.palaces[0].id;
  return s;
}
let saveChain = Promise.resolve();
function save(fromCloud = false) {
  // 順番どおりに書き込む（追い越しで古い内容が残らないように）
  saveChain = saveChain
    .then(() => kv.set('state', state))
    .catch((e) => { console.error(e); toast('保存に失敗しました（保存容量を確認してください）'); });
  scheduleSync();
  scheduleNotifyUpload();
  if (!fromCloud) markCloudDirty(); // クラウドから読み込んだ内容は、送り返さない
}

// ===== 間隔反復（次に復習する日） =====
// 日付は 'YYYY-MM-DD'（PC の日付）
function dayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(str, n) {
  const [y, m, d] = str.split('-').map(Number);
  return dayStr(new Date(y, m - 1, d + n));
}
// 次の復習日。まだ一度も復習していない場所は「今日」
function dueOf(l) {
  const s = l.stats || {};
  if (s.due) return s.due;
  if (!s.lastAt) return dayStr();
  return addDays(dayStr(new Date(s.lastAt)), 1); // 間隔反復を入れる前に復習した場所
}
const isDue = (l) => dueOf(l) <= dayStr();
function scheduleNext(l, ok) {
  const s = l.stats;
  const today = dayStr();
  if (!ok) { s.streak = 0; s.due = addDays(today, 1); return; }
  if (dueOf(l) > today) return; // 予定より早い復習は、間隔をのばさない（同じ日に何度やっても進まない）
  s.streak = (s.streak || 0) + 1;
  s.due = addDays(today, INTERVALS[Math.min(s.streak, INTERVALS.length) - 1]);
}
const dueCountAll = () => state.palaces.reduce((n, p) => n + p.loci.filter(isDue).length, 0);

// ===== LINE 通知（Google Apps Script に「いつ・何か所」だけを送る） =====
// 送るのは宮殿の名前と、日付ごとの場所の数だけ（覚えた内容や景色は送らない）
let notifyTimer = null;
function notifyUrl() { try { return localStorage.getItem(NOTIFY_STORAGE) || ''; } catch (e) { return ''; } }
function notifyPayload() {
  return {
    palaces: state.palaces.map((p) => {
      const due = {};
      for (const l of p.loci) { const d = dueOf(l); due[d] = (due[d] || 0) + 1; }
      return { name: p.name, due };
    }),
  };
}
function scheduleNotifyUpload() {
  if (!notifyUrl()) return;
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(uploadNotify, 3000);
}
async function uploadNotify(force = false) {
  const url = notifyUrl();
  if (!url) return;
  const body = JSON.stringify(notifyPayload());
  let last = '';
  try { last = localStorage.getItem(NOTIFY_STORAGE + '-last') || ''; } catch (e) { /* なし */ }
  if (!force && body === last) return; // 変わっていなければ送らない
  try {
    // text/plain で送ると、Apps Script でも事前確認なしで受け取れる（返事は読めない）
    await fetch(url, { method: 'POST', mode: 'no-cors', body, headers: { 'Content-Type': 'text/plain' } });
    try { localStorage.setItem(NOTIFY_STORAGE + '-last', body); } catch (e) { /* なし */ }
  } catch (e) { console.error(e); } // オフラインなど。次に保存したときにまた送る
}
// ===== クラウド同期（自分の Apps Script → 自分の Google ドライブ） =====
// PC とスマホで同じデータを使うため。LINE 通知と同じ Apps Script の URL を使う。
// しくみ：クラウドには「版番号（rev）」があり、各端末は最後にそろえた版を覚えておく。
//   クラウドの版が進んでいたら読み込む／この端末だけ変更があれば送る／両方変わっていたら本人に選んでもらう
const SYNC_REV = 'loci-okinawa-sync-rev';     // この端末が最後にそろえたクラウドの版（なし＝まだ一度も同期していない）
const SYNC_DIRTY = 'loci-okinawa-sync-dirty'; // まだクラウドに送っていない変更がある
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* なし */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* なし */ } },
};
let cloudTimer = null, cloudBusy = false, cloudAgain = false;
let cloudImgs = new Set(); // クラウドにある画像の id
let editSeq = 0;           // 変更の回数（送っている最中に変更があったかを見分ける）

function markCloudDirty() {
  editSeq++;
  if (!notifyUrl()) return;
  ls.set(SYNC_DIRTY, '1');
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(cloudSync, 2000);
}

function usedImageIds(st) {
  const used = new Set();
  st.palaces.forEach((p) => p.loci.forEach((l) =>
    (l.ink || []).forEach((it) => it.type === 'image' && used.add(it.img))));
  return used;
}

async function cloudCall(body) {
  const res = await fetch(notifyUrl(), {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  });
  const t = await res.text();
  if (t === 'ng') throw new Error('合言葉が違います（URL の ?key= を確認してください）');
  let d;
  try { d = JSON.parse(t); } catch (e) { throw new Error('Apps Script が古いようです（新しいコードに貼り替えて、デプロイし直してください）'); }
  if (d.error) throw new Error(d.error);
  return d;
}

async function cloudSync() {
  if (!notifyUrl()) return;
  if (cloudBusy) { cloudAgain = true; return; }
  cloudBusy = true;
  try {
    const meta = await cloudCall({ action: 'meta' });
    cloudImgs = new Set(meta.imageIds || []);
    const mine = ls.get(SYNC_REV);
    const dirty = ls.get(SYNC_DIRTY) === '1';
    const hasData = state.palaces.some((p) => p.loci.length);
    if (mine === null) {                          // この端末で初めての同期
      if (!meta.rev) await cloudPush(0);          // クラウドが空 → この端末の内容を送る
      else if (!hasData) await cloudPull();       // この端末が空 → クラウドの内容を読む
      else await cloudConflict(meta.rev, true);
    } else if (meta.rev > Number(mine)) {          // ほかの端末で変更があった
      if (dirty) await cloudConflict(meta.rev, false);
      else await cloudPull();
    } else if (dirty) {                            // この端末だけ変更があった
      await cloudPush(Number(mine));
    }
  } catch (e) {
    console.error(e);
    if (navigator.onLine !== false) toast('クラウド同期に失敗しました：' + e.message);
  } finally {
    cloudBusy = false;
    if (cloudAgain) { cloudAgain = false; cloudSync(); }
  }
}

async function cloudPush(baseRev) {
  const seq = editSeq;
  // 新しい画像を先に少しずつ送る（一度に送ると時間切れになるため）
  const ids = [...usedImageIds(state)].filter((id) => !cloudImgs.has(id));
  for (let i = 0; i < ids.length; i += 15) {
    const images = {};
    for (const id of ids.slice(i, i + 15)) { const d = await idb.get(id); if (d) images[id] = d; }
    if (Object.keys(images).length) await cloudCall({ action: 'putImages', images });
    Object.keys(images).forEach((id) => cloudImgs.add(id));
  }
  const r = await cloudCall({ action: 'push', baseRev, state });
  if (r.conflict) return cloudConflict(r.rev, false);
  ls.set(SYNC_REV, String(r.rev));
  cloudImgs = new Set(r.imageIds || []);
  if (seq === editSeq) ls.del(SYNC_DIRTY); // 送っている間に変更があれば、次の回でまた送る
}

async function cloudPull() {
  const r = await cloudCall({ action: 'pull' });
  if (!r.state || !Array.isArray(r.state.palaces)) return;
  const have = new Set(await idb.keys());
  const missing = (r.imageIds || []).filter((id) => !have.has(id));
  for (let i = 0; i < missing.length; i += 15) {
    const g = await cloudCall({ action: 'images', ids: missing.slice(i, i + 15) });
    for (const [k, v] of Object.entries(g.images || {})) await idb.set(k, v);
  }
  await kv.set('state-before-sync', state).catch(() => {}); // 念のため、読み込む前の内容を1つだけ残す
  state = ensureState(r.state);
  review = null;
  editingId = null;
  save(true);
  ls.set(SYNC_REV, String(r.rev));
  ls.del(SYNC_DIRTY);
  cloudImgs = new Set(r.imageIds || []);
  renderAll();
  const first = cur().loci[0];
  if (first) showLocus(first);
  toast('クラウドから最新のデータを読み込みました');
}

async function cloudConflict(rev, first) {
  const useCloud = confirm(first
    ? 'クラウドにも、この端末にもデータがあります。\n\nOK：クラウドのデータを使う（この端末のデータは消えます）\nキャンセル：この端末のデータでクラウドを上書きする'
    : 'この端末とほかの端末の両方で、まだそろっていない変更があります。\n\nOK：クラウド（ほかの端末）のデータを使う（この端末の変更は消えます）\nキャンセル：この端末のデータでクラウドを上書きする');
  if (useCloud) await cloudPull();
  else await cloudPush(rev);
}

// クラウドのバックアップ（毎日1つ、7日分）から戻す
async function restoreFromCloud() {
  if (!notifyUrl()) return toast('先に「クラウド連携の設定」をしてください');
  let dates;
  try { dates = (await cloudCall({ action: 'backups' })).dates || []; }
  catch (e) { return toast('バックアップの一覧を読めませんでした：' + e.message); }
  if (!dates.length) return toast('まだバックアップがありません（毎日 12 時ごろに作られます）');
  const v = prompt('どの日のバックアップに戻しますか？ 番号を入れてください。\n（その日の 12 時ごろの内容に戻ります）\n\n' +
    dates.map((d, i) => `${i + 1}：${d}`).join('\n'), '1');
  if (v === null) return;
  const date = dates[Number(v) - 1];
  if (!date) return toast('番号が正しくありません');
  if (!confirm(`${date} の内容に戻します。今のデータは、PC・スマホとも置き換わります。よろしいですか？`)) return;
  try {
    await cloudCall({ action: 'restore', date });
    ls.del(SYNC_DIRTY);
    await cloudPull();
    toast(`${date} の内容に戻しました`);
  } catch (e) { toast('戻せませんでした：' + e.message); }
}

async function setupNotify() {
  const now = notifyUrl();
  const v = prompt(
    'クラウド連携（PC とスマホの同期・LINE 通知）用の Apps Script の URL を貼ってください（最後に ?key=合言葉 を付けたもの）。\n' +
    '空にして OK を押すと、この端末のクラウド連携をやめます。\n手順は「？（使い方）」の「クラウド連携」にあります。', now);
  if (v === null) return;
  const url = v.trim();
  if (!url) {
    [NOTIFY_STORAGE, NOTIFY_STORAGE + '-last', SYNC_REV, SYNC_DIRTY].forEach((k) => ls.del(k));
    return toast('この端末のクラウド連携をやめました');
  }
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec\?key=.+/.test(url)) {
    return toast('URL の形が違います（https://script.google.com/macros/s/…/exec?key=合言葉）');
  }
  if (url !== now) [SYNC_REV, NOTIFY_STORAGE + '-last'].forEach((k) => ls.del(k)); // 新しくつなぐときは最初からそろえ直す
  ls.set(NOTIFY_STORAGE, url);
  if (confirm('LINE にテスト通知を送りますか？')) {
    try {
      await fetch(url, { method: 'POST', mode: 'no-cors', body: JSON.stringify({ test: true }), headers: { 'Content-Type': 'text/plain' } });
    } catch (e) { /* 下の同期でエラーが分かる */ }
  }
  await uploadNotify(true);
  await cloudSync();
  toast('クラウド連携を設定しました');
}

async function showStorageInfo() {
  const loci = state.palaces.reduce((n, p) => n + p.loci.length, 0);
  let imgs = 0;
  try { imgs = (await idb.keys()).length; } catch (e) { /* なし */ }
  let usage = '不明';
  try {
    const est = await navigator.storage.estimate();
    usage = `${(est.usage / 1048576).toFixed(1)} MB 使用中（上限の目安 ${(est.quota / 1073741824).toFixed(1)} GB）`;
  } catch (e) { /* 未対応 */ }
  let persisted = '不明';
  try { persisted = (await navigator.storage.persisted()) ? 'はい' : 'いいえ（ブラウザが容量不足のときに消す可能性あり）'; } catch (e) { /* 未対応 */ }
  alert([
    `宮殿：${state.palaces.length} 個`,
    `場所：${loci} 個`,
    `画像：${imgs} 枚`,
    `容量：${usage}`,
    `消されにくい保存：${persisted}`,
    `Obsidian 連携：${vault ? `中（${vault.name}）` : 'なし'}`,
  ].join('\n'));
}
const cur = () => state.palaces.find((p) => p.id === state.currentId);
const findLocus = (id) => cur().loci.find((l) => l.id === id);
const numOf = (l) => cur().loci.indexOf(l) + 1;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2500);
}

// ===== Google Maps 読み込み =====
function loadMaps(key) {
  return new Promise((resolve, reject) => {
    window.__mapsReady = resolve;
    // キーは消さずに、原因の説明だけ出す（入れ直しは任意）
    window.gm_authFailure = () => showSetup(
      '<b>APIキーは保存されています</b>が、Google に拒否されました。次を確認してください。<br>' +
      '・請求先アカウントがプロジェクトにリンクされているか<br>' +
      '・Maps JavaScript API が有効か<br>' +
      '・キーの制限に <code>http://localhost:8000/*</code> が入っているか<br>' +
      'Cloud Console で直したら、アプリを開き直すだけで大丈夫です。<b>キーを変えるときだけ</b>下に入力してください。', true);
    const s = document.createElement('script');
    s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) +
      '&v=weekly&loading=async&callback=__mapsReady&language=ja&region=JP';
    s.async = true;
    s.onerror = () => reject(new Error('load failed'));
    document.head.appendChild(s);
  });
}

async function initMaps() {
  const { Map } = await google.maps.importLibrary('maps');
  const { StreetViewPanorama, StreetViewService } = await google.maps.importLibrary('streetView');
  await google.maps.importLibrary('marker');
  ({ Place } = await google.maps.importLibrary('places'));

  map = new Map($('#map'), {
    center: START, zoom: 14,
    restriction: { latLngBounds: BOUNDS, strictBounds: false },
    streetViewControl: false, mapTypeControl: false, fullscreenControl: false, clickableIcons: false,
  });
  pano = new StreetViewPanorama($('#pano'), {
    position: START, pov: { heading: 90, pitch: 0 },
    addressControl: false, fullscreenControl: false,
    motionTracking: false, motionTrackingControl: false,
  });
  map.setStreetView(pano);
  sv = new StreetViewService();

  map.addListener('click', (e) => {
    if (review && review.idx < review.queue.length) return; // 復習中は移動しない
    jumpTo(e.latLng);
    $('#mapWrap').classList.remove('big');
    $('#mapToggle').textContent = '拡大';
  });
  pano.addListener('position_changed', onPanoMoved);
  ['pov_changed', 'zoom_changed', 'pano_changed'].forEach((ev) => pano.addListener(ev, requestInk));

  renderMarkers();
  // 書きかけがあればその場所から、なければ宮殿の1番目から
  const first = cur().loci[0];
  if (draft.items.length && draft.view) showLocus(draft.view);
  else if (first) showLocus(first);
}

const FIRST_SETUP_MSG = 'Google Maps の API キーを入力してください。<br><b>入力は最初の1回だけ</b>です。キーはこの PC の中に保存されます。';

function showSetup(msgHtml, closable) {
  $('#setupMsg').innerHTML = msgHtml;
  $('#apiKeyInput').value = '';
  $('#closeSetupBtn').classList.toggle('hidden', !closable);
  $('#setup').classList.remove('hidden');
}

async function loadApiKey() {
  let key = null;
  try { key = localStorage.getItem(KEY_STORAGE); } catch (e) { /* なし */ }
  if (!key) {
    // localStorage が消えていても IndexedDB の控えから戻す
    key = await kv.get('apiKey').catch(() => null);
    if (key) try { localStorage.setItem(KEY_STORAGE, key); } catch (e) { /* なし */ }
  }
  return key;
}

function inOkinawa(ll) {
  const lat = ll.lat(), lng = ll.lng();
  return lat >= BOUNDS.south && lat <= BOUNDS.north && lng >= BOUNDS.west && lng <= BOUNDS.east;
}

function onPanoMoved() {
  const pos = pano.getPosition();
  if (!pos) return;
  if (inOkinawa(pos)) {
    lastValid = pos;
    map.panTo(pos);
  } else {
    toast('沖縄の外には出られません');
    if (lastValid) pano.setPosition(lastValid);
  }
}

// latLng 付近のストリートビューへ移動。faceTarget=true なら、その地点の方を向く
function jumpTo(latLng, radius = 100, faceTarget = false) {
  sv.getPanorama({ location: latLng, radius })
    .then(({ data }) => {
      pano.setPano(data.location.pano);
      if (faceTarget) pano.setPov({ heading: bearing(data.location.latLng, latLng), pitch: 0 });
      pano.setZoom(1);
      pano.setVisible(true);
    })
    .catch(() => toast('近くにストリートビューがありません'));
}

// a から b への方角（度）
function bearing(a, b) {
  const r = (x) => x * Math.PI / 180;
  const f1 = r(a.lat()), f2 = r(b.lat()), d = r(b.lng() - a.lng());
  const y = Math.sin(d) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(d);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// ===== 場所の検索（Enter で1回だけ検索） =====
async function searchPlace(q) {
  if (!Place) return toast('地図を読み込み中です');
  if (review && review.idx < review.queue.length) return toast('復習中は検索できません');
  try {
    const { places } = await Place.searchByText({
      textQuery: q,
      fields: ['displayName', 'formattedAddress', 'location'],
      locationRestriction: BOUNDS, // 沖縄の中だけ
      maxResultCount: 5,
      language: 'ja',
      region: 'jp',
    });
    searchHits = places || [];
    if (searchHits.length === 1) return goToHit(0);
    renderSearchResults();
  } catch (e) {
    console.error(e);
    toast('検索に失敗しました（Places API (New) が有効か確認してください）');
  }
}

function renderSearchResults() {
  const ul = $('#searchResults');
  ul.innerHTML = searchHits.length
    ? searchHits.map((p, i) =>
        `<li data-hit="${i}">${esc(p.displayName)}<small>${esc(p.formattedAddress)}</small></li>`).join('')
    : '<li class="empty">沖縄の中に見つかりませんでした</li>';
  ul.classList.remove('hidden');
}

function closeSearchResults() { $('#searchResults').classList.add('hidden'); }

function goToHit(i) {
  const p = searchHits[i];
  if (!p?.location) return;
  closeSearchResults();
  $('#searchInput').value = p.displayName || $('#searchInput').value;
  $('#searchInput').blur();
  map.setCenter(p.location);
  map.setZoom(17);
  jumpTo(p.location, 300, true); // 建物や公園の中心から道まで離れていることがあるので広めに探す
}

function currentView() {
  const pos = pano.getPosition();
  const pov = pano.getPov();
  return {
    panoId: pano.getPano(), lat: pos.lat(), lng: pos.lng(),
    heading: pov.heading, pitch: pov.pitch, zoom: pano.getZoom() ?? 1,
  };
}

// 保存した地点・向きを再現する
function showLocus(l) {
  if (!pano) return;
  const pov = { heading: l.heading, pitch: l.pitch };
  if (pano.getPano() === l.panoId) {
    pano.setPov(pov);
  } else {
    const h = pano.addListener('status_changed', () => {
      h.remove();
      if (pano.getStatus() !== 'OK') pano.setPosition({ lat: l.lat, lng: l.lng }); // パノラマIDが変わった時の保険
      pano.setPov(pov);
    });
    pano.setPano(l.panoId);
  }
  pano.setZoom(l.zoom ?? 1);
  pano.setVisible(true);
  map.panTo({ lat: l.lat, lng: l.lng });
}

function renderMarkers() {
  if (!map) return;
  markers.forEach((m) => m.setMap(null));
  markers = [];
  const loci = cur().loci;
  loci.forEach((l, i) => {
    const m = new google.maps.Marker({
      position: { lat: l.lat, lng: l.lng }, map,
      label: { text: String(i + 1), color: '#fff', fontSize: '12px', fontWeight: '700' },
      title: '#' + (i + 1) + (l.name ? ' ' + l.name : ''),
    });
    m.addListener('click', () => {
      if (review && review.idx < review.queue.length) return;
      showLocus(l);
    });
    markers.push(m);
  });
  if (routeLine) routeLine.setMap(null);
  routeLine = new google.maps.Polyline({
    path: loci.map((l) => ({ lat: l.lat, lng: l.lng })), map,
    strokeColor: '#e4572e', strokeOpacity: 0.7, strokeWeight: 3,
  });
}

// ===== 落書き・付箋（景色の方角に貼り付く） =====
// 各点は [heading, pitch]（度）で保存するので、視点を回しても景色にくっついて動く
const canvas = $('#ink');
const ctx = canvas.getContext('2d');
const D2R = Math.PI / 180;
const PEN_WIDTHS = [3, 6, 12];
const NOTE_BG = { '#ff3b30': '#ffd9d4', '#ffcc00': '#fff3a3', '#34c759': '#d6f5de', '#0a84ff': '#d8e9ff', '#ffffff': '#ffffff' };
let tool = 'move';
let inkColor = '#ff3b30';
let penWidth = 6;
let draft = { panoId: null, items: [], view: null }; // まだ「置く」前の落書き（IndexedDB にも保存）
let draftText = { name: '', item: '', image: '', question: '' }; // まだ「置く」前の入力中の文字
let draftTimer = 0;

function saveDraftNow() {
  clearTimeout(draftTimer);
  draftTimer = 0;
  kv.set('draft', { ...draft, text: draftText }).catch((e) => console.error(e));
}
function saveDraftSoon() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraftNow, 400);
}
async function loadDraft() {
  try {
    const d = await kv.get('draft');
    if (!d) return;
    draft = { panoId: d.panoId ?? null, items: d.items || [], view: d.view || null };
    draftText = { name: d.text?.name || '', item: d.text?.item || '', image: d.text?.image || '', question: d.text?.question || '' };
  } catch (e) { console.error(e); }
}
window.addEventListener('pagehide', () => { if (draftTimer) saveDraftNow(); });
let drawing = null;
let rafId = 0;

const round3 = (n) => Math.round(n * 1000) / 1000;
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// 今の視点のカメラ（東・北・上の座標系）
function camera() {
  const pov = pano.getPov();
  const z = pano.getZoom() ?? 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const fov = Math.min(170, 180 / Math.pow(2, z)) * D2R; // ストリートビューの視野角（横）
  const F = (W / 2) / Math.tan(fov / 2);
  const h = pov.heading * D2R, p = pov.pitch * D2R;
  return {
    W, H, F,
    f: [Math.sin(h) * Math.cos(p), Math.cos(h) * Math.cos(p), Math.sin(p)],
    r: [Math.cos(h), -Math.sin(h), 0],
    u: [-Math.sin(h) * Math.sin(p), -Math.cos(h) * Math.sin(p), Math.cos(p)],
  };
}
function screenToAngle(c, x, y) {
  const dx = x - c.W / 2, dy = y - c.H / 2;
  const d = [0, 1, 2].map((i) => c.F * c.f[i] + dx * c.r[i] - dy * c.u[i]);
  const n = Math.hypot(d[0], d[1], d[2]);
  return [round3((Math.atan2(d[0], d[1]) / D2R + 360) % 360), round3(Math.asin(d[2] / n) / D2R)];
}
function angleToScreen(c, [hd, pt]) {
  const h = hd * D2R, p = pt * D2R;
  const d = [Math.sin(h) * Math.cos(p), Math.cos(h) * Math.cos(p), Math.sin(p)];
  const cf = dot3(d, c.f);
  if (cf <= 0.05) return null; // 背中側は描かない
  return [c.W / 2 + c.F * dot3(d, c.r) / cf, c.H / 2 - c.F * dot3(d, c.u) / cf];
}

const reviewing = () => !!review && review.idx < review.queue.length;

// 今描き込める先（編集中の場所 or 下書き）
function inkTarget(create) {
  if (!pano) return null;
  const id = pano.getPano();
  if (editingId) {
    const l = findLocus(editingId);
    if (!l || l.panoId !== id) return null;
    l.ink = l.ink || [];
    return l.ink;
  }
  if (draft.panoId !== id) {
    if (!create) return null;
    if (draft.items.length) toast('前の地点の下書きの落書きは消えました');
    draft = { panoId: id, items: [], view: currentView() };
  }
  return draft.items;
}

// 今の画面に表示する落書き
function inkLayers() {
  if (!pano) return [];
  const id = pano.getPano();
  if (reviewing()) {
    const l = findLocus(review.queue[review.idx]);
    return review.revealed && l && l.panoId === id ? [l.ink || []] : []; // 答えを見るまで隠す
  }
  const layers = cur().loci.filter((l) => l.panoId === id && l.id !== editingId).map((l) => l.ink || []);
  const t = inkTarget(false);
  if (t) layers.push(t);
  return layers;
}

function requestInk() {
  if (!rafId) rafId = requestAnimationFrame(() => { rafId = 0; drawInk(); });
}

function drawInk() {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!pano || !pano.getPov()) return;
  const c = camera();
  for (const items of inkLayers()) for (const it of items) drawItem(c, it);
  if (drawing) drawItem(c, drawing);
  drawSelection(c);
}

function drawItem(c, it) {
  if (it.type === 'stroke') {
    ctx.save();
    ctx.strokeStyle = it.color;
    ctx.lineWidth = it.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(0,0,0,.6)';
    ctx.shadowBlur = 3;
    ctx.beginPath();
    let prev = null;
    for (const a of it.pts) {
      const s = angleToScreen(c, a);
      if (!s) { prev = null; continue; }
      if (prev) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]);
      prev = s;
    }
    if (it.pts.length === 1 && prev) ctx.lineTo(prev[0] + 0.1, prev[1]); // 点
    ctx.stroke();
    ctx.restore();
  } else if (it.type === 'note') {
    const s = angleToScreen(c, it.at);
    if (s) drawNote(s, it.text, it.color);
  } else if (it.type === 'image') {
    const s = angleToScreen(c, it.at);
    const el = s && getImg(it.img);
    if (!el) return;
    const w = 2 * c.F * Math.tan(it.size * D2R / 2), h = w * it.aspect;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.4)';
    ctx.shadowBlur = 8;
    ctx.drawImage(el, s[0] - w / 2, s[1] - h / 2, w, h);
    ctx.restore();
  } else if (it.type === 'imagePlace' && pending?.el.complete) {
    const w = placeWidth(it), h = w * pending.aspect;
    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.drawImage(pending.el, it.x0 - w / 2, it.y0 - h / 2, w, h);
    ctx.restore();
  }
}

function wrapText(text, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const ch of para) {
      if (line && ctx.measureText(line + ch).width > maxW) { out.push(line); line = ch; }
      else line += ch;
    }
    out.push(line);
  }
  return out;
}

function drawNote([x, y], text, color) {
  ctx.save();
  ctx.font = 'bold 15px system-ui, "Hiragino Sans", "Yu Gothic UI", "Meiryo", sans-serif';
  const lines = wrapText(text, 180);
  const lh = 20, pad = 10;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
  const h = lines.length * lh + pad * 2 - 4;
  const bx = x - w / 2, by = y - h / 2;
  ctx.shadowColor = 'rgba(0,0,0,.4)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  ctx.fillStyle = NOTE_BG[color] || '#fff3a3';
  ctx.fillRect(bx, by, w, h);
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = color === '#ffffff' ? '#999' : color; // 付箋の上の色帯
  ctx.fillRect(bx, by, w, 4);
  ctx.fillStyle = '#222';
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, bx + pad, by + pad + i * lh));
  ctx.restore();
}

function setTool(t) {
  tool = t;
  if (t !== 'adjust') { selImg = null; adjusting = null; }
  canvas.style.cursor = '';
  canvas.classList.toggle('active', t !== 'move');
  requestInk();
  document.querySelectorAll('#inkBar [data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
}

function inkSaved() {
  if (editingId) save();  // 編集中の場所はその場で保存
  else saveDraftNow();    // 「置く」前の書きかけも保存（アプリを閉じても残る）
  requestInk();
}

function canvasPoint(e) {
  const rect = canvas.getBoundingClientRect();
  return [e.clientX - rect.left, e.clientY - rect.top];
}

// ===== 画像ステッカー（IndexedDB に保存） =====
// images：画像データ ／ kv：Obsidian フォルダの権限などの設定
function makeStore(name) {
  const tx = async (mode, fn) => {
    const db = await openDB();
    return new Promise((res, rej) => {
      const t = db.transaction(name, mode);
      const req = fn(t.objectStore(name));
      t.oncomplete = () => res(req.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    get: (k) => tx('readonly', (s) => s.get(k)),
    set: (k, v) => tx('readwrite', (s) => s.put(v, k)),
    del: (k) => tx('readwrite', (s) => s.delete(k)),
    keys: () => tx('readonly', (s) => s.getAllKeys()),
  };
}
let dbPromise;
function openDB() {
  return dbPromise || (dbPromise = new Promise((res, rej) => {
    const r = indexedDB.open('loci-okinawa', 2);
    r.onupgradeneeded = () => {
      for (const s of ['images', 'kv']) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}
const idb = makeStore('images');
const kv = makeStore('kv');

const imgCache = new Map();
let pending = null; // 貼る前の画像 { data, aspect, el }
const DEFAULT_IMG_PX = 160;

function getImg(id) {
  let el = imgCache.get(id);
  if (el) return el.complete && el.naturalWidth ? el : null;
  el = new Image();
  imgCache.set(id, el);
  idb.get(id).then((d) => { if (d) { el.onload = requestInk; el.src = d; } });
  return null;
}

// 縮小して、白い背景（四隅とつながっている白）を透明にする
async function processImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url;
    });
    const s = Math.min(1, 384 / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0, w, h);
    removeWhiteBg(x, w, h);
    let data = c.toDataURL('image/webp', 0.85);
    if (!data.startsWith('data:image/webp')) data = c.toDataURL('image/png');
    return { data, aspect: h / w };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function removeWhiteBg(x, w, h) {
  const d = x.getImageData(0, 0, w, h), p = d.data;
  const white = (k) => p[k * 4] > 235 && p[k * 4 + 1] > 235 && p[k * 4 + 2] > 235 && p[k * 4 + 3] > 0;
  const corners = [0, w - 1, (h - 1) * w, h * w - 1];
  if (!corners.every(white)) return; // 背景が白くない画像はそのまま
  const seen = new Uint8Array(w * h);
  const stack = [...corners];
  while (stack.length) {
    const k = stack.pop();
    if (seen[k]) continue;
    seen[k] = 1;
    if (!white(k)) continue;
    p[k * 4 + 3] = 0;
    const xx = k % w, yy = (k - xx) / w;
    if (xx > 0) stack.push(k - 1);
    if (xx < w - 1) stack.push(k + 1);
    if (yy > 0) stack.push(k - w);
    if (yy < h - 1) stack.push(k + w);
  }
  x.putImageData(d, 0, 0);
}

async function setPending(blob) {
  if (!blob || !blob.type.startsWith('image/')) return toast('画像ファイルを選んでください');
  try {
    const r = await processImage(blob);
    r.el = new Image();
    r.el.src = r.data;
    pending = r;
    return true;
  } catch (e) {
    toast('画像を読み込めませんでした');
    return false;
  }
}

// 画面上の (x, y) に幅 widthPx で pending の画像を貼る
async function placeImage(x, y, widthPx) {
  const target = inkTarget(true);
  if (!target) return toast('編集中の場所の画面に戻ってから貼ってください');
  if (!pending) return;
  const c = camera();
  const id = uid();
  try { await idb.set(id, pending.data); }
  catch (e) { return toast('画像の保存に失敗しました'); }
  imgCache.set(id, pending.el);
  target.push({
    type: 'image', img: id, aspect: pending.aspect,
    at: screenToAngle(c, x, y),
    size: round3(2 * Math.atan(widthPx / 2 / c.F) / D2R), // 角度で持つのでズームすると一緒に大きくなる
  });
  pending = null;
  setTool('adjust');
  selImg = target[target.length - 1]; // 貼った直後はそのまま大きさを直せるようにする
  toast('角をドラッグで大きさ、中をドラッグで移動できます。終わったら ✋');
  inkSaved();
}

// ===== 貼った画像の調整（⤡ ツール） =====
let selImg = null;    // 選んでいる画像（ink アイテム）
let adjusting = null; // ドラッグ中 { mode: 'resize' | 'move', ... }
const HANDLE_PX = 12;
const MIN_IMG_PX = 24;

function imageRect(c, it) {
  const s = angleToScreen(c, it.at);
  if (!s) return null;
  const w = 2 * c.F * Math.tan(it.size * D2R / 2);
  return { cx: s[0], cy: s[1], w, h: w * it.aspect };
}

// 今選べる画像の一覧（編集中の場所か、置く前の下書きの画像だけ）
function editableImages() {
  const t = inkTarget(false);
  return t ? t.filter((it) => it.type === 'image') : [];
}

function selectedImage() {
  if (selImg && !editableImages().includes(selImg)) selImg = null; // 消された・別の地点に移動した
  return selImg;
}

function sizeFromPx(c, px) {
  return round3(2 * Math.atan(Math.max(MIN_IMG_PX, px) / 2 / c.F) / D2R);
}

// (x, y) にあるもの：選択中の画像の角 → 'resize'、画像の上 → その画像
function hitAdjust(c, x, y) {
  const sel = selectedImage();
  const r = sel && imageRect(c, sel);
  if (r) {
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      if (Math.hypot(x - (r.cx + sx * r.w / 2), y - (r.cy + sy * r.h / 2)) <= HANDLE_PX) return { mode: 'resize', it: sel, r };
    }
  }
  const imgs = editableImages();
  for (let i = imgs.length - 1; i >= 0; i--) { // 上に重なっているものから
    const rr = imageRect(c, imgs[i]);
    if (rr && Math.abs(x - rr.cx) <= rr.w / 2 && Math.abs(y - rr.cy) <= rr.h / 2) return { mode: 'move', it: imgs[i], r: rr };
  }
  return null;
}

function drawSelection(c) {
  const sel = tool === 'adjust' && selectedImage();
  const r = sel && imageRect(c, sel);
  if (!r) return;
  const x0 = r.cx - r.w / 2, y0 = r.cy - r.h / 2;
  ctx.save();
  ctx.strokeStyle = '#0a84ff';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(x0, y0, r.w, r.h);
  ctx.setLineDash([]);
  ctx.fillStyle = '#fff';
  for (const [hx, hy] of [[x0, y0], [x0 + r.w, y0], [x0, y0 + r.h], [x0 + r.w, y0 + r.h]]) {
    ctx.beginPath();
    ctx.arc(hx, hy, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function adjustDown(e, x, y) {
  const c = camera();
  const hit = hitAdjust(c, x, y);
  if (!hit) { // 画像のない所をクリック → 調整を終わって視点を動かすモードへ
    selImg = null;
    setTool('move');
    return;
  }
  selImg = hit.it;
  canvas.setPointerCapture(e.pointerId);
  adjusting = hit.mode === 'resize'
    ? { mode: 'resize', cx: hit.r.cx, cy: hit.r.cy }
    : { mode: 'move', dx: x - hit.r.cx, dy: y - hit.r.cy, moved: false };
  requestInk();
}

function adjustMove(x, y) {
  const c = camera();
  if (!adjusting) { // ドラッグしていないときは、カーソルの形で操作を教える
    const hit = hitAdjust(c, x, y);
    canvas.style.cursor = !hit ? 'default' : hit.mode === 'resize' ? 'nwse-resize' : 'move';
    return;
  }
  if (adjusting.mode === 'resize') {
    const half = Math.max(Math.abs(x - adjusting.cx), Math.abs(y - adjusting.cy) / selImg.aspect);
    selImg.size = sizeFromPx(c, half * 2);
  } else {
    selImg.at = screenToAngle(c, x - adjusting.dx, y - adjusting.dy);
    adjusting.moved = true;
  }
  requestInk();
}

function adjustUp() {
  if (!adjusting) return;
  adjusting = null;
  inkSaved();
}

// ホイールで大きさを変える（少し待ってから保存）
let wheelSaveTimer = 0;
canvas.addEventListener('wheel', (e) => {
  if (tool !== 'adjust' || !selectedImage()) return;
  e.preventDefault();
  const c = camera();
  const r = imageRect(c, selImg);
  if (!r) return;
  selImg.size = sizeFromPx(c, r.w * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  requestInk();
  clearTimeout(wheelSaveTimer);
  wheelSaveTimer = setTimeout(inkSaved, 300);
}, { passive: false });

// Delete / Backspace で選んでいる画像を消す
document.addEventListener('keydown', (e) => {
  if (tool !== 'adjust' || !['Delete', 'Backspace'].includes(e.key)) return;
  if (['TEXTAREA', 'INPUT', 'SELECT'].includes(e.target.tagName)) return;
  const sel = selectedImage();
  if (!sel) return;
  e.preventDefault();
  const t = inkTarget(false);
  t.splice(t.indexOf(sel), 1);
  selImg = null;
  inkSaved();
});

// どこからも使われていない画像を消す（起動時）
async function gcImages() {
  try {
    const used = usedImageIds(state);
    (draft.items || []).forEach((it) => it.type === 'image' && used.add(it.img));
    for (const k of await idb.keys()) if (!used.has(k)) await idb.del(k);
  } catch (e) { /* 失敗しても動作には影響なし */ }
}

canvas.addEventListener('pointerdown', (e) => {
  if (tool === 'move' || !pano) return;
  if (tool === 'adjust') return adjustDown(e, ...canvasPoint(e));
  const target = inkTarget(true);
  if (!target) return toast('編集中の場所の画面に戻ってから描いてください');
  const [x, y] = canvasPoint(e);
  const c = camera();
  if (tool === 'image') {
    if (!pending) { $('#imgFile').click(); return; }
    canvas.setPointerCapture(e.pointerId);
    drawing = { type: 'imagePlace', x0: x, y0: y, x1: x, y1: y };
    requestInk();
    return;
  }
  if (tool === 'note') {
    const text = prompt('付箋に書く内容');
    if (text && text.trim()) {
      target.push({ type: 'note', at: screenToAngle(c, x, y), text: text.trim(), color: inkColor });
      inkSaved();
    }
    return;
  }
  canvas.setPointerCapture(e.pointerId);
  drawing = { type: 'stroke', color: inkColor, width: penWidth, pts: [screenToAngle(c, x, y)], last: [x, y], target };
  requestInk();
});
canvas.addEventListener('pointermove', (e) => {
  if (tool === 'adjust') return adjustMove(...canvasPoint(e));
  if (!drawing) return;
  const [x, y] = canvasPoint(e);
  if (drawing.type === 'imagePlace') { drawing.x1 = x; drawing.y1 = y; requestInk(); return; }
  if (Math.hypot(x - drawing.last[0], y - drawing.last[1]) < 2) return; // 点を間引いて軽くする
  drawing.pts.push(screenToAngle(camera(), x, y));
  drawing.last = [x, y];
  requestInk();
});
const placeWidth = (d) => {
  const r = Math.hypot(d.x1 - d.x0, d.y1 - d.y0);
  return r > 10 ? r * 2 : DEFAULT_IMG_PX; // クリックだけなら標準サイズ、ドラッグで大きさ指定
};
function endStroke() {
  if (adjusting) return adjustUp();
  if (!drawing) return;
  if (drawing.type === 'imagePlace') {
    const d = drawing;
    drawing = null;
    placeImage(d.x0, d.y0, placeWidth(d));
    return;
  }
  const { target, last, ...item } = drawing;
  target.push(item);
  drawing = null;
  inkSaved();
}
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);
new ResizeObserver(requestInk).observe(canvas);

$('#inkBar').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.tool) {
    setTool(b.dataset.tool);
    if (b.dataset.tool === 'image' && !pending) $('#imgFile').click();
    if (b.dataset.tool === 'adjust') {
      toast(editableImages().length
        ? '大きさを変えたい画像をクリック（角をドラッグで大きさ、中をドラッグで移動）'
        : 'この画面に調整できる画像がありません（保存済みの場所は「編集」を開いてから）');
    }
    return;
  }
  if (b.dataset.color) {
    inkColor = b.dataset.color;
    document.querySelectorAll('#inkBar .swatch').forEach((s) => s.classList.toggle('active', s === b));
    return;
  }
  if (b.dataset.ink === 'width') {
    penWidth = PEN_WIDTHS[(PEN_WIDTHS.indexOf(penWidth) + 1) % PEN_WIDTHS.length];
    b.style.fontSize = (10 + PEN_WIDTHS.indexOf(penWidth) * 5) + 'px';
    return toast(`ペンの太さ：${['細', '中', '太'][PEN_WIDTHS.indexOf(penWidth)]}`);
  }
  const target = inkTarget(false);
  if (!target || !target.length) return toast('この画面に消せる落書きはありません');
  if (b.dataset.ink === 'undo') target.pop();
  if (b.dataset.ink === 'clear') {
    if (!confirm('この場所の落書き・付箋を全部消しますか？')) return;
    target.length = 0;
  }
  inkSaved();
});

const PLACE_HINT = '貼りたい場所をクリック（ドラッグすると大きさを指定できます）';

async function startPlacing(blob) {
  if (reviewing()) return toast('復習中は貼れません');
  if (await setPending(blob)) { setTool('image'); toast(PLACE_HINT); }
}

$('#imgFile').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) startPlacing(f);
});

// Ctrl+V で貼り付け（画像、または Claude が出した SVG コード）
document.addEventListener('paste', (e) => {
  if (reviewing()) return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) {
    e.preventDefault();
    startPlacing(item.getAsFile());
    return;
  }
  if (['TEXTAREA', 'INPUT'].includes(e.target.tagName)) return; // 文字入力欄への普通の貼り付けは邪魔しない
  const svg = extractSvg(e.clipboardData?.getData('text/plain'));
  if (!svg) return;
  e.preventDefault();
  const blob = svgToBlob(svg);
  if (blob) startPlacing(blob);
  else toast('SVG コードが壊れているようです');
});

// ドラッグ&ドロップ：落とした場所にそのまま貼る
$('#stage').addEventListener('dragover', (e) => e.preventDefault());
$('#stage').addEventListener('drop', async (e) => {
  e.preventDefault();
  if (reviewing() || !pano) return;
  const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/'));
  if (!f) return;
  const [x, y] = canvasPoint(e);
  if (await setPending(f)) placeImage(x, y, DEFAULT_IMG_PX);
});

// ===== Obsidian 連携（Vault の中に自動で書き出す） =====
const VAULT_FOLDER = '記憶の宮殿';
const IMG_FOLDER = '画像';
const WRITTEN_KEY = 'loci-okinawa-written-notes';
let vault = null;          // Vault フォルダのハンドル
let syncTimer = 0, syncing = false, syncAgain = false;
const lastWritten = new Map(); // ファイル名 → 前回書いた内容（変わっていなければ書かない）

async function writeIfChanged(dir, name, content) {
  if (lastWritten.get(name) === content) return;
  await writeFile(dir, name, content);
  lastWritten.set(name, content);
}

const safeName = (s) => String(s).replace(/[\\/:*?"<>|#^[\]\n\r]/g, '_').trim().slice(0, 80) || '無題';
const oneLine = (s) => String(s ?? '').replace(/\s*\n\s*/g, ' ').trim();

function svUrl(l) {
  const fov = Math.round(Math.max(10, Math.min(100, 180 / Math.pow(2, l.zoom ?? 1))));
  return 'https://www.google.com/maps/@?api=1&map_action=pano' +
    `&pano=${encodeURIComponent(l.panoId)}&heading=${Math.round(l.heading)}&pitch=${Math.round(l.pitch)}&fov=${fov}`;
}

function palaceMarkdown(p, imgExt) {
  const out = [
    '---', 'tags: [記憶の宮殿]', `場所の数: ${p.loci.length}`, '---', '',
    `# ${p.name}`, '',
    '> 沖縄 記憶の宮殿アプリから自動で書き出したノートです。ここを書き換えても、次の保存でアプリの内容に上書きされます。', '',
    '#flashcards/記憶の宮殿', '',
  ];
  p.loci.forEach((l, i) => {
    const ink = l.ink || [];
    out.push(`## ${i + 1}. ${oneLine(l.item)}`, '');
    if (l.name) out.push(`- 🏷 目印：${oneLine(l.name)}`);
    if (l.image) out.push(`- 💭 ${oneLine(l.image)}`);
    const notes = ink.filter((x) => x.type === 'note').map((x) => oneLine(x.text));
    if (notes.length) out.push(`- 📝 ${notes.join(' ／ ')}`);
    out.push(`- 📍 [ストリートビューで開く](${svUrl(l)})`);
    out.push(`- ✓ ${l.stats?.ok ?? 0} ／ ✗ ${l.stats?.ng ?? 0} ／ 次の復習 ${dueOf(l)}`);
    const imgs = ink.filter((x) => x.type === 'image' && imgExt[x.img]);
    if (imgs.length) out.push('', imgs.map((x) => `![[${VAULT_FOLDER}/${IMG_FOLDER}/${x.img}.${imgExt[x.img]}|200]]`).join(' '));
    // Spaced Repetition プラグイン用のカード（質問::答え）
    out.push('', `${p.name} の ${i + 1} 番目の場所${l.name ? `（${oneLine(l.name)}）` : ''}に置いたものは？::${oneLine(l.item)}`);
    const hint = hintOf(l);
    if (hint) out.push(`「${oneLine(hint)}」を英語で::${oneLine(l.item)}`);
    out.push('');
  });
  return out.join('\n');
}

async function writeFile(dir, name, content) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(content);
  await w.close();
}
async function fileExists(dir, name) {
  try { await dir.getFileHandle(name); return true; } catch (e) { return false; }
}

function scheduleSync() {
  if (!vault) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncObsidian, 1500); // 連続で操作しても1.5秒後にまとめて保存
}

async function syncObsidian() {
  if (!vault) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  try {
    const root = await vault.getDirectoryHandle(VAULT_FOLDER, { create: true });
    const imgDir = await root.getDirectoryHandle(IMG_FOLDER, { create: true });

    // 画像（まだ無いものだけ書く）
    const imgExt = {};
    for (const p of state.palaces) for (const l of p.loci) for (const it of l.ink || []) {
      if (it.type !== 'image' || imgExt[it.img]) continue;
      const data = await idb.get(it.img);
      if (!data) continue;
      const ext = data.startsWith('data:image/webp') ? 'webp' : 'png';
      imgExt[it.img] = ext;
      const name = `${it.img}.${ext}`;
      if (!(await fileExists(imgDir, name))) await writeFile(imgDir, name, await (await fetch(data)).blob());
    }

    // 宮殿ごとのノート
    const written = new Set();
    for (const p of state.palaces) {
      let name = safeName(p.name) + '.md';
      if (written.has(name)) name = `${safeName(p.name)}_${p.id.slice(-4)}.md`;
      await writeIfChanged(root, name, palaceMarkdown(p, imgExt));
      written.add(name);
    }
    // 名前変更・削除で使われなくなったノートを消す（アプリが書いたものだけ）
    let prev = [];
    try { prev = JSON.parse(localStorage.getItem(WRITTEN_KEY)) || []; } catch (e) { /* なし */ }
    for (const n of prev) if (!written.has(n)) {
      try { await root.removeEntry(n); } catch (e) { /* もう無い */ }
      lastWritten.delete(n);
    }
    localStorage.setItem(WRITTEN_KEY, JSON.stringify([...written]));

    // アプリのデータ全体（復元用）
    await writeIfChanged(root, '_data.json', JSON.stringify(state));
    setVaultStatus('on');
  } catch (e) {
    console.error(e);
    setVaultStatus('warn');
    toast('Obsidian への保存に失敗しました（🔗 を押して再接続してください）');
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; syncObsidian(); }
  }
}

function setVaultStatus(s) {
  const b = $('#vaultBtn');
  b.classList.toggle('on', s === 'on');
  b.classList.toggle('warn', s === 'warn');
  b.title = { on: `Obsidian 連携中（${vault?.name}）：クリックで今すぐ保存`,
    warn: 'Obsidian 連携が止まっています：クリックして再開',
    off: 'Obsidian と連携する（Vault フォルダを選ぶ）' }[s];
}

async function onVaultBtn() {
  if (!('showDirectoryPicker' in window)) return toast('このブラウザでは使えません（PC の Chrome で開いてください）');
  if (vault) { await syncObsidian(); return toast('Obsidian に保存しました'); }

  // 前に選んだフォルダがあれば権限だけもらい直す
  const saved = await kv.get('vault').catch(() => null);
  if (saved && (await saved.requestPermission({ mode: 'readwrite' })) === 'granted') {
    vault = saved;
    await syncObsidian();
    return toast(`「${saved.name}」との連携を再開しました`);
  }

  let h;
  try { h = await window.showDirectoryPicker({ id: 'obsidian-vault', mode: 'readwrite', startIn: 'documents' }); }
  catch (e) { return; } // キャンセル
  if (!(await h.getDirectoryHandle('.obsidian').then(() => true, () => false)) &&
      !confirm(`「${h.name}」は Obsidian の Vault ではないようです（.obsidian フォルダがありません）。ここに保存しますか？`)) return;
  await kv.set('vault', h);
  vault = h;
  await syncObsidian();
  toast(`「${h.name}」の「${VAULT_FOLDER}」フォルダに保存しました`);
}

async function initVault() {
  setVaultStatus('off');
  try {
    const h = await kv.get('vault');
    if (!h) return;
    if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') { vault = h; setVaultStatus('on'); return; }
    setVaultStatus('warn');
    // ブラウザの決まりで、許可の確認はクリックの直後にしか出せない。
    // そこで起動後の最初のクリックで自動的に確認を出す（🔗 を押し忘れても連携が戻る）
    const resume = async (e) => {
      document.removeEventListener('pointerdown', resume, true);
      if (vault || e.target.closest?.('#vaultBtn')) return; // 🔗 自体は onVaultBtn に任せる
      try {
        if ((await h.requestPermission({ mode: 'readwrite' })) !== 'granted') return;
        vault = h;
        await syncObsidian();
        toast(`「${h.name}」との連携を再開しました`);
      } catch (err) { /* 確認を閉じた等 */ }
    };
    document.addEventListener('pointerdown', resume, true);
  } catch (e) { /* 未対応ブラウザ */ }
}

async function unlinkVault() {
  if (!confirm('Obsidian との連携を解除しますか？（Vault の中のノートはそのまま残ります）')) return;
  vault = null;
  await kv.del('vault').catch(() => {});
  setVaultStatus('off');
  toast('連携を解除しました');
}

$('#vaultBtn').addEventListener('click', onVaultBtn);

// ===== 画面描画 =====
function renderAll() {
  renderPalaceSelect();
  renderPanel();
  renderMarkers();
}

function renderPalaceSelect() {
  $('#palaceSelect').innerHTML = state.palaces.map((p) =>
    `<option value="${p.id}" ${p.id === state.currentId ? 'selected' : ''}>${esc(p.name)}（${p.loci.length}）</option>`
  ).join('');
}

function renderPanel() {
  document.querySelectorAll('.tabs button').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === mode));
  const html = { build: buildHTML, review: reviewHTML, list: listHTML }[mode]();
  $('#content').innerHTML = html;
  // 復習中は落書きツールを隠す
  const r = reviewing();
  $('#inkBar').classList.toggle('hidden', r);
  if (r && tool !== 'move') setTool('move');
  requestInk();
}

function buildHTML() {
  const ed = editingId && findLocus(editingId);
  return `
    <p class="hint">地図をクリックするか、ストリートビューの矢印で歩いて場所を探そう。
    <b>向き・ズームもそのまま保存</b>されるので、覚えたいものを置く「目印」（シーサー、看板、ガジュマルなど）を画面の中心にしてから置くのがおすすめです。<br>
    右上の ✏️ で景色に落書き、📝 で付箋を貼れます（✋ で視点操作に戻る）。復習では「答えを見る」まで隠れます。</p>
    ${ed ? `<span class="badge">#${numOf(ed)} を編集中</span>` : ''}
    <label>目印の名前（なくてもよい）
      <input id="nameInput" type="text" placeholder="例：赤いポスト、知念商店、公園のベンチ" value="${esc(ed ? ed.name || '' : draftText.name)}">
    </label>
    <label>覚えること
      <textarea id="itemInput" rows="2" placeholder="例：apple = りんご">${esc(ed ? ed.item : draftText.item)}</textarea>
    </label>
    <label>日本語の問題（なくてもよい）
      <input id="questionInput" type="text" placeholder="例：〜することになっている（空なら「覚えること」の（ ）の中を使う）" value="${esc(ed ? ed.question || '' : draftText.question)}">
    </label>
    <label>連想イメージ（場所と結びつける、変で鮮やかな光景）
      <textarea id="imageInput" rows="3" placeholder="例：シーサーの口から巨大なりんごがゴロゴロ転がり出てくる">${esc(ed ? ed.image : draftText.image)}</textarea>
    </label>
    <div class="row-btns">
      ${ed
        ? `<button class="primary" data-action="update">内容を更新</button>
           <button data-action="move-here">位置を今の画面に変更</button>
           <button class="ghost" data-action="cancel-edit">やめる</button>`
        : `<button class="primary" data-action="add">この場所に置く</button>`}
    </div>
    <div class="row-btns">
      <button data-action="claude-art" title="連想イメージから Claude 用の指示文をコピーして Claude を開く">🎨 Claudeで絵を作る</button>
      <button data-action="paste-art" title="コピーした SVG コードや画像を貼る">📋 コピーした絵を貼る</button>
    </div>
    <p class="hint" style="margin-top:6px">
      ① 「Claudeで絵を作る」→ 指示文がコピーされて Chrome で Claude が開く<br>
      ② Claude に貼り付けて送信 → 横に絵が出るので確認（直したい所は言葉で頼む）→ 決まったら、返事の最後のコードの右上にある「コピー」<br>
      ③ ここに戻って「コピーした絵を貼る」→ 景色の貼りたい所をクリック（ドラッグで大きさ）<br>
      ほかの画像生成AIを使うときは <button class="linklike" data-action="ai-prompt">こちらの指示文</button> を使い、できた画像を Ctrl+V かドラッグで貼れます。
    </p>
    <p class="count">「${esc(cur().name)}」の場所：${cur().loci.length} 個</p>`;
}

// 日本語の問題：「日本語の問題」欄。空なら「覚えること」の最後の（ ）の中（例：I'm supposed to 〜（〜することになっている））
// ※ gas/line-notify.gs の hintOf_() と同じ決まりにすること
function hintOf(l) {
  if (l.question && l.question.trim()) return l.question.trim();
  const m = String(l.item || '').match(/[（(]([^（）()]+)[）)]\s*$/);
  return m ? m[1].trim() : '';
}
const HINT_STORAGE = 'loci-okinawa-hint';
const showHint = () => ls.get(HINT_STORAGE) !== '0'; // 最初は「出す」

function hintToggleHTML() {
  return `<label class="check"><input type="checkbox" id="hintToggle" ${showHint() ? 'checked' : ''}>
    日本語の問題を出す（日本語 → 英語）</label>`;
}

function reviewHTML() {
  const loci = cur().loci;
  const weak = loci.filter((l) => l.stats?.lastOk !== true).length;
  const due = loci.filter(isDue).length;
  const dueAll = dueCountAll();

  if (!review) {
    return `
      <p class="hint">場所を順番に巡ります。<b>答えを見る前に</b>、景色の中に置いたイメージをできるだけ鮮明に思い浮かべよう。</p>
      <p>場所：${loci.length} 個 ／ <b>今日の復習：${due} 個</b> ／ 苦手・未復習：${weak} 個</p>
      ${dueAll > due ? `<p class="hint">ほかの宮殿にも今日の復習が ${dueAll - due} 個あります。</p>` : ''}
      <div class="row-btns">
        <button class="primary" data-action="review-due">今日の復習（${due}）</button>
        <button data-action="review-all">最初から順に</button>
        <button data-action="review-weak">苦手・未復習だけ</button>
      </div>
      ${hintToggleHTML()}
      <p class="hint">「覚えてた」が続くほど、次の復習までの間が 1日 → 3日 → 1週間 → 2週間 → 1か月 → 2か月 → 4か月 とのびます。忘れたら翌日からやり直しです。</p>
      <p class="hint" style="margin-top:16px">キーボード：Enter＝答えを見る、1＝覚えてた、2＝忘れた</p>`;
  }

  if (review.idx >= review.queue.length) {
    const total = review.ok + review.ng;
    return `
      <p class="progress">おつかれさま！</p>
      <div class="score">${review.ok} / ${total}</div>
      <p class="hint">${review.ng ? '忘れた場所は「苦手」に入ります。連想イメージをもっと大げさにすると覚えやすくなります。' : '全部覚えていました 🎉'}</p>
      <div class="row-btns">
        <button class="primary" data-action="review-weak">苦手だけもう一度</button>
        <button data-action="review-end">終わる</button>
      </div>`;
  }

  const l = findLocus(review.queue[review.idx]);
  const hint = showHint() ? hintOf(l) : '';
  return `
    <p class="progress">${review.idx + 1} / ${review.queue.length}　（場所 #${numOf(l)}${l.name ? ` ${esc(l.name)}` : ''}）</p>
    <p class="question">この場所に何を置いた？</p>
    ${hint ? `<p class="hint-ja">🇯🇵 「${esc(hint)}」<small>を英語で言うと？（声に出してから答えを見よう）</small></p>` : ''}
    ${review.revealed
      ? `<div class="answer">
           <div class="item">${esc(l.item)}</div>
           ${l.image ? `<div class="image">💭 ${esc(l.image)}</div>` : ''}
         </div>
         <div class="row-btns">
           <button class="ok" data-action="ok">覚えてた ✓</button>
           <button class="ng" data-action="ng">忘れた ✗</button>
         </div>`
      : `<div class="row-btns"><button class="primary" data-action="reveal">答えを見る</button></div>`}
    <div class="row-btns"><button class="ghost" data-action="review-end">中断する</button></div>
    ${hintToggleHTML()}`;
}

function listHTML() {
  const loci = cur().loci;
  if (!loci.length) return `<p class="hint">まだ場所がありません。「作成」タブから置いてみよう。</p>`;
  return `<ol class="loci">${loci.map((l, i) => `
    <li>
      <div class="row">
        <span class="num">${i + 1}</span>
        <div class="txt">
          ${l.name ? `<small class="landmark">📍 ${esc(l.name)}</small>` : ''}
          <b>${esc(l.item)}</b>
          ${l.image ? `<small>💭 ${esc(l.image)}</small>` : ''}
          <small>✓ ${l.stats?.ok ?? 0}　✗ ${l.stats?.ng ?? 0}${l.ink?.length ? `　✏️ ${l.ink.length}` : ''}</small>
        </div>
      </div>
      <div class="acts">
        <button class="small" data-action="show" data-id="${l.id}">見る</button>
        <button class="small" data-action="edit" data-id="${l.id}">編集</button>
        <button class="small" data-action="up" data-id="${l.id}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="small" data-action="down" data-id="${l.id}" ${i === loci.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="small" data-action="del" data-id="${l.id}">削除</button>
      </div>
    </li>`).join('')}</ol>`;
}

// ===== 操作 =====
function setMode(m) { mode = m; renderPanel(); }

function addLocus() {
  const item = $('#itemInput').value.trim();
  const image = $('#imageInput').value.trim();
  const question = $('#questionInput').value.trim();
  const name = $('#nameInput').value.trim();
  if (!item) return toast('「覚えること」を入力してください');
  if (!pano || !pano.getPano()) return toast('ストリートビューが表示されていません');
  if (!inOkinawa(pano.getPosition())) return toast('沖縄の中の場所を選んでください');
  const view = currentView();
  const ink = draft.panoId === view.panoId ? draft.items : [];
  draft = { panoId: null, items: [], view: null };
  draftText = { name: '', item: '', image: '', question: '' };
  saveDraftNow();
  cur().loci.push({
    id: uid(), ...view, item, image, ink,
    ...(question ? { question } : {}),
    ...(name ? { name } : {}),
    stats: { ok: 0, ng: 0, lastOk: null, lastAt: null }, createdAt: Date.now(),
  });
  save();
  renderAll();
  toast(`#${cur().loci.length} に置きました`);
}

function updateLocus(moveHere) {
  const l = findLocus(editingId);
  if (!l) return;
  if (moveHere) {
    if (!inOkinawa(pano.getPosition())) return toast('沖縄の中の場所を選んでください');
    Object.assign(l, currentView());
    toast(`#${numOf(l)} の位置を変更しました`);
  } else {
    const item = $('#itemInput').value.trim();
    if (!item) return toast('「覚えること」を入力してください');
    l.item = item;
    l.image = $('#imageInput').value.trim();
    const question = $('#questionInput').value.trim();
    if (question) l.question = question; else delete l.question;
    const name = $('#nameInput').value.trim();
    if (name) l.name = name; else delete l.name;
    editingId = null;
    toast('更新しました');
  }
  save();
  renderAll();
}

function currentScene() {
  return $('#imageInput')?.value.trim() || $('#itemInput')?.value.trim();
}

async function copyText(text) {
  // スマホから http:// で開いた場合などはクリップボードが使えない
  try { await navigator.clipboard.writeText(text); return true; }
  catch (e) { prompt('この文をコピーしてください', text); return false; }
}

// 絵に入れる文字の指示（「覚えること」があればそれを大きく入れてもらう）
function textRule() {
  const item = $('#itemInput')?.value.trim();
  return item
    ? `「${item}」という文字を、大きく読みやすく絵の中に入れる`
    : '場面を表す短い言葉を、大きく読みやすく絵の中に入れる';
}

// 画像生成AI（Copilot / ChatGPT / Gemini など）向け
async function copyAiPrompt() {
  const scene = currentScene();
  if (!scene) return toast('先に「連想イメージ」を書いてください');
  const text = `${scene}\n\nこの場面を1枚のイラストにしてください。` +
    'ステッカー風、太い輪郭線、鮮やかな色、大げさで印象に残る表現、白い無地の背景、' +
    textRule() + '。';
  if (await copyText(text)) toast('コピーしました。画像生成AIに貼り付けてください');
}

// Claude 向け：SVG コードで描いてもらう
async function claudeArt() {
  const scene = currentScene();
  if (!scene) return toast('先に「連想イメージ」を書いてください');
  const text = [
    '次の場面を、記憶に残るステッカー風のイラストにしてください。',
    '絵を見て確認・手直ししたいので、SVG のアーティファクトとして表示してください。',
    'さらに、毎回の返事の最後に、同じ SVG のコード全体を ```svg のコードブロックでチャットにも書いてください（コピーボタンで取り出すためです）。',
    'このあと手直しを頼むことがあります。そのときも同じアーティファクトを更新し、最後に新しいコード全体をコードブロックで書いてください。',
    '',
    `場面：${scene}`,
    '',
    '条件：',
    '- viewBox="0 0 512 512"',
    '- 背景は透明（背景の四角は描かない）',
    '- 太い輪郭線、鮮やかな色、大げさで動きのある印象的な表現',
    `- ${textRule()}`,
    '- 外部の画像・フォント・スクリプトは使わない（文字は普通のフォントでよい）',
    '- 説明は一言でよい',
  ].join('\n');
  if (await copyText(text)) {
    toast('コピーしました。Claude に貼り付けて送信してください');
    openInChrome('https://claude.ai/new');
  }
}

// アプリ用サーバー（server.py）に頼んで Chrome で開く。だめならこのブラウザで開く
async function openInChrome(url) {
  // ネット上（GitHub Pages など）では server.py がないので、すぐ開く（待つとポップアップを止められる）
  if (!['localhost', '127.0.0.1'].includes(location.hostname)) return void window.open(url, '_blank', 'noopener');
  try {
    const res = await fetch('/open-chrome', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (res.ok) return;
  } catch (e) { /* server.py 以外で起動している */ }
  window.open(url, '_blank', 'noopener');
}

// テキストの中から <svg>…</svg> を取り出す（```svg のコードブロックでもOK）
function extractSvg(text) {
  const m = String(text || '').match(/<svg[\s\S]*<\/svg>/i);
  return m ? m[0] : null;
}

// SVG コードを画像ファイル（Blob）にする。大きさが無ければ viewBox から決める
function svgToBlob(svgText) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = doc.documentElement;
  if (doc.querySelector('parsererror') || svg.nodeName.toLowerCase() !== 'svg') return null;
  svg.querySelectorAll('script, foreignObject').forEach((n) => n.remove());
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const num = (v) => (v && !/%/.test(v) ? parseFloat(v) : NaN);
  let w = num(svg.getAttribute('width')), h = num(svg.getAttribute('height'));
  const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (!(w > 0 && h > 0)) {
    w = vb[2] > 0 ? vb[2] : 512;
    h = vb[3] > 0 ? vb[3] : 512;
  }
  if (!(vb.length === 4 && vb[2] > 0)) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const s = 512 / Math.max(w, h);
  svg.setAttribute('width', Math.round(w * s));
  svg.setAttribute('height', Math.round(h * s));
  return new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
}

// 「コピーした絵を貼る」ボタン：クリップボードの画像 or SVG コードを読む
async function pasteArt() {
  if (!navigator.clipboard) return toast('景色の上で Ctrl+V を押して貼ってください');
  try {
    if (navigator.clipboard.read) {
      for (const it of await navigator.clipboard.read()) {
        const t = it.types.find((x) => x.startsWith('image/'));
        if (t) return startPlacing(await it.getType(t));
      }
    }
  } catch (e) { /* 画像なし → テキストを試す */ }
  try {
    const svg = extractSvg(await navigator.clipboard.readText());
    if (!svg) return toast('クリップボードに絵が見つかりません（SVG コードか画像をコピーしてください）');
    const blob = svgToBlob(svg);
    if (!blob) return toast('SVG コードが壊れているようです。Claude にもう一度出力してもらってください');
    startPlacing(blob);
  } catch (e) {
    toast('クリップボードを読めませんでした。景色の上で Ctrl+V を押して貼ってください');
  }
}

function startReview(kind) { // 'all' | 'weak' | 'due'
  let loci = cur().loci;
  if (kind === 'weak') loci = loci.filter((l) => l.stats?.lastOk !== true);
  if (kind === 'due') loci = loci.filter(isDue);
  if (!loci.length) {
    return toast({ weak: '苦手な場所はありません 🎉', due: '今日の復習はありません 🎉' }[kind] || 'まだ場所がありません');
  }
  review = { queue: loci.map((l) => l.id), idx: 0, revealed: false, ok: 0, ng: 0 };
  reviewStep();
}
function reviewStep() {
  if (review.idx < review.queue.length) showLocus(findLocus(review.queue[review.idx]));
  renderPanel();
}
function answer(ok) {
  const l = findLocus(review.queue[review.idx]);
  l.stats = l.stats || { ok: 0, ng: 0 };
  if (ok) { l.stats.ok++; review.ok++; } else { l.stats.ng++; review.ng++; }
  scheduleNext(l, ok); // lastAt を更新する前に、次の復習日を決める
  l.stats.lastOk = ok;
  l.stats.lastAt = Date.now();
  save();
  review.idx++;
  review.revealed = false;
  reviewStep();
}

function moveLocus(id, dir) {
  const loci = cur().loci;
  const i = loci.findIndex((l) => l.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= loci.length) return;
  [loci[i], loci[j]] = [loci[j], loci[i]];
  save();
  renderAll();
}

function deleteLocus(id) {
  const l = findLocus(id);
  if (!l || !confirm(`#${numOf(l)}「${l.item}」を削除しますか？`)) return;
  cur().loci = cur().loci.filter((x) => x.id !== id);
  review = null;
  if (editingId === id) editingId = null;
  save();
  renderAll();
}

function switchPalace(id) {
  state.currentId = id;
  review = null;
  editingId = null;
  save();
  renderAll();
  const first = cur().loci[0];
  if (first) showLocus(first);
}

async function exportData() {
  const images = {};
  try { for (const k of await idb.keys()) images[k] = await idb.get(k); } catch (e) { /* 画像なし */ }
  const blob = new Blob([JSON.stringify({ ...state, images })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `loci-okinawa-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function importData(file) {
  const r = new FileReader();
  r.onload = async () => {
    try {
      const d = JSON.parse(r.result);
      if (!Array.isArray(d.palaces)) throw new Error('bad');
      if (!confirm('今のデータをすべて置き換えます。よろしいですか？')) return;
      const images = d.images || {};
      delete d.images;
      for (const [k, v] of Object.entries(images)) await idb.set(k, v);
      imgCache.clear();
      state = ensureState(d);
      review = null;
      editingId = null;
      save();
      switchPalace(state.currentId);
      toast('読み込みました');
    } catch (e) {
      toast('ファイルの形式が正しくありません');
    }
  };
  r.readAsText(file);
}

function handleMenu(cmd) {
  $('#menu').classList.add('hidden');
  if (cmd === 'rename') {
    const name = prompt('新しい名前', cur().name);
    if (name && name.trim()) { cur().name = name.trim(); save(); renderAll(); }
  } else if (cmd === 'delete') {
    if (!confirm(`「${cur().name}」と中の場所 ${cur().loci.length} 個を削除しますか？`)) return;
    state.palaces = state.palaces.filter((p) => p.id !== state.currentId);
    ensureState(state);
    switchPalace(state.currentId);
  } else if (cmd === 'export') {
    exportData();
  } else if (cmd === 'import') {
    $('#importFile').click();
  } else if (cmd === 'storage') {
    showStorageInfo();
  } else if (cmd === 'vault-off') {
    unlinkVault();
  } else if (cmd === 'notify') {
    setupNotify();
  } else if (cmd === 'restore') {
    restoreFromCloud();
  } else if (cmd === 'key') {
    showSetup('新しい API キーを入力してください。', true);
  }
}

// ===== イベント =====
$('#saveKeyBtn').addEventListener('click', async () => {
  const key = $('#apiKeyInput').value.trim();
  if (!key) return toast('APIキーを入力してください');
  try { localStorage.setItem(KEY_STORAGE, key); } catch (e) { /* なし */ }
  await kv.set('apiKey', key).catch(() => {}); // 控え
  location.reload();
});
$('#closeSetupBtn').addEventListener('click', () => $('#setup').classList.add('hidden'));

document.querySelectorAll('.tabs button').forEach((b) =>
  b.addEventListener('click', () => setMode(b.dataset.mode)));

$('#palaceSelect').addEventListener('change', (e) => switchPalace(e.target.value));

$('#newPalaceBtn').addEventListener('click', () => {
  const name = prompt('新しい宮殿の名前（例：英単語セット1、首里城ルート）');
  if (!name || !name.trim()) return;
  const p = newPalace(name.trim());
  state.palaces.push(p);
  mode = 'build';
  switchPalace(p.id);
});

$('#menuBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#menu').classList.toggle('hidden'); });
document.addEventListener('click', () => $('#menu').classList.add('hidden'));
$('#menu').addEventListener('click', (e) => {
  e.stopPropagation();
  const b = e.target.closest('[data-menu]');
  if (b) handleMenu(b.dataset.menu);
});
$('#importFile').addEventListener('change', (e) => {
  if (e.target.files[0]) importData(e.target.files[0]);
  e.target.value = '';
});

$('#searchBox').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#searchInput').value.trim();
  if (q) searchPlace(q);
});
$('#searchResults').addEventListener('click', (e) => {
  const li = e.target.closest('[data-hit]');
  if (li) goToHit(Number(li.dataset.hit));
});
$('#searchBox').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', closeSearchResults);
$('#searchInput').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSearchResults(); });

$('#mapToggle').addEventListener('click', () => {
  const big = $('#mapWrap').classList.toggle('big');
  $('#mapToggle').textContent = big ? '縮小' : '拡大';
});

// 「日本語の問題を出す」の切り替え（端末ごとに覚えておく）
$('#content').addEventListener('change', (e) => {
  if (e.target.id !== 'hintToggle') return;
  ls.set(HINT_STORAGE, e.target.checked ? '1' : '0');
  renderPanel();
});

// 入力中の文字も書きかけとして保存（アプリを閉じても残る）
$('#content').addEventListener('input', (e) => {
  if (editingId) return;
  if (e.target.id === 'itemInput') draftText.item = e.target.value;
  else if (e.target.id === 'imageInput') draftText.image = e.target.value;
  else if (e.target.id === 'questionInput') draftText.question = e.target.value;
  else if (e.target.id === 'nameInput') draftText.name = e.target.value;
  else return;
  saveDraftSoon();
});

$('#content').addEventListener('click', (e) => {
  const b = e.target.closest('[data-action]');
  if (!b) return;
  const id = b.dataset.id;
  switch (b.dataset.action) {
    case 'add': addLocus(); break;
    case 'ai-prompt': copyAiPrompt(); break;
    case 'claude-art': claudeArt(); break;
    case 'paste-art': pasteArt(); break;
    case 'update': updateLocus(false); break;
    case 'move-here': updateLocus(true); break;
    case 'cancel-edit': editingId = null; renderPanel(); break;
    case 'review-all': startReview('all'); break;
    case 'review-weak': startReview('weak'); break;
    case 'review-due': startReview('due'); break;
    case 'reveal': review.revealed = true; renderPanel(); break;
    case 'ok': answer(true); break;
    case 'ng': answer(false); break;
    case 'review-end': review = null; renderPanel(); break;
    case 'show': showLocus(findLocus(id)); break;
    case 'edit': editingId = id; showLocus(findLocus(id)); setMode('build'); break;
    case 'up': moveLocus(id, -1); break;
    case 'down': moveLocus(id, 1); break;
    case 'del': deleteLocus(id); break;
  }
});

// 復習中のキーボード操作
document.addEventListener('keydown', (e) => {
  if (mode !== 'review' || !review || review.idx >= review.queue.length) return;
  if (['TEXTAREA', 'INPUT', 'SELECT'].includes(e.target.tagName)) return;
  if (!review.revealed && e.key === 'Enter') { review.revealed = true; renderPanel(); }
  else if (review.revealed && e.key === '1') answer(true);
  else if (review.revealed && e.key === '2') answer(false);
});

// アプリに戻ってきたとき・ネットにつながったときに、クラウドとそろえる
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') cloudSync(); });
window.addEventListener('online', () => cloudSync());

// ===== 起動 =====
(async () => {
  state = await loadState();
  await loadDraft(); // 「置く」前の書きかけ（落書き・入力中の文字）
  renderPalaceSelect();
  renderPanel();
  gcImages();
  initVault();
  uploadNotify(); // 起動時にも予定を送っておく（日付が変わって数が変わることがあるため）
  cloudSync();    // ほかの端末で変更があれば読み込む
  // ブラウザに「容量不足でも消さないで」とお願いする
  try { await navigator.storage?.persist?.(); } catch (e) { /* 未対応 */ }
  const savedKey = await loadApiKey();
  if (!savedKey) {
    showSetup(FIRST_SETUP_MSG, false);
  } else {
    loadMaps(savedKey).then(initMaps).catch(() => toast('Google Maps の読み込みに失敗しました'));
  }
})();
