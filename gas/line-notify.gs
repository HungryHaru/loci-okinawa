/**
 * 沖縄 記憶の宮殿 — クラウド連携（PC とスマホの同期・LINE で復習のお知らせ）（Google Apps Script 用）
 *
 * このファイルの中身を、Google Apps Script のエディタ（コード.gs）にまるごと貼り付けて使う。
 * 手順はアプリの「？（使い方）」→「クラウド連携」を見てください。
 * 同期データは自分の Google ドライブの「沖縄 記憶の宮殿（同期データ）」フォルダに入る（消さないこと）。
 *
 * スクリプト プロパティ（プロジェクトの設定 → スクリプト プロパティ）に次の3つを入れる：
 *   LINE_TOKEN   … LINE Developers の「チャネルアクセストークン（長期）」
 *   LINE_USER_ID … LINE Developers の「あなたのユーザーID」（U から始まる）
 *   SECRET       … 自分で決めた合言葉（英数字 20 文字くらい）。アプリに貼る URL の ?key= の後ろと同じにする
 *
 * 毎日 12 時台（dailyNotify）：
 *   1. 同期データを Google ドライブにバックアップ（7日分）
 *   2. 忘却曲線のポイントの日（ちょうど今日が復習日の場所がある日）だけ LINE に送る
 *      （問題＝景色のリンク、答えは下の方に。2日以内に予定の場所もまとめる。遅れた場所は1週間後に1回だけ）
 */

const TZ = 'Asia/Tokyo';
const NOTIFY_HOUR = 12; // 毎日 12 時台に送る

// アプリから予定を受け取る（ウェブアプリとして公開して使う）
function doPost(e) {
  const props = PropertiesService.getScriptProperties();
  const secret = props.getProperty('SECRET');
  if (!secret || !e || !e.parameter || e.parameter.key !== secret) return text_('ng');

  const data = JSON.parse(e.postData.contents);
  if (data.action) { // PC とスマホの同期
    try { return json_(handleSync_(data)); }
    catch (err) { return json_({ error: String((err && err.message) || err) }); }
  }
  if (data.test) {
    pushLine_('🔔 テスト：沖縄 記憶の宮殿からの通知が届きました。\n毎日 ' + NOTIFY_HOUR + ' 時ごろ、復習する場所があればお知らせします。');
    return text_('ok');
  }
  if (Array.isArray(data.palaces)) {
    props.setProperty('SCHEDULE', JSON.stringify(data.palaces));
    props.setProperty('UPDATED', new Date().toISOString());
  }
  return text_('ok');
}

// 毎日 12 時台に動く（setup() で予約する）
function dailyNotify() {
  try { dailyBackup_(); } catch (e) { Logger.log('バックアップに失敗：' + e); }
  const st = readState_();
  if (st) notifyFromState_(st);
  else notifyFromSchedule_(); // 同期を使っていないとき（アプリから届いた「日付ごとの数」だけで送る）
}

const MAX_ITEMS = 15; // LINE に載せる問題の最大数（多すぎると読みにくい）

// 同期データから、今日の復習の「問題（景色のリンク）」と「答え」を作って送る
function notifyFromState_(st) {
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const until = addDays_(today, EARLY_DAYS), weekAgo = addDays_(today, -7), threeAgo = addDays_(today, -2);
  const groups = [];
  let total = 0, point = false, reminder = false;
  (st.palaces || []).forEach(function (p) {
    const items = [];
    (p.loci || []).forEach(function (l, i) {
      const d = dueOf_(l, today);
      const s = l.stats || {};
      const retry = s.lastAt && !s.streak;  // 忘れた場所（やり直し中）
      // 忘却曲線の「ポイントの日」。忘れた場所だけでは送らず、次のポイントの日に一緒に復習する
      // （3日たってもポイントの日がなければ送る）
      if (retry ? d === threeAgo : d === today) point = true;
      if (d === weekAgo) reminder = true;   // 1週間遅れている（1回だけお知らせ）
      if (d <= until) items.push({ n: i + 1, l: l }); // 2日以内に予定の場所もまとめる
    });
    if (items.length) { groups.push({ name: p.name, items: items }); total += items.length; }
  });
  // ポイントの日だけ送る（期限を過ぎた場所で毎日は送らない。1週間遅れたときだけ1回）
  if (!total || !(point || reminder)) return;
  const late = !point && reminder ? '1週間たった場所があります' : '';

  const q = ['🧠 今日は復習の日：' + total + ' か所' + (late ? '（' + late + '）' : ''),
    '景色を開いて、置いたものを思い出そう。'];
  const a = [];
  let shown = 0;
  groups.forEach(function (g) {
    const room = MAX_ITEMS - shown;
    if (room <= 0) return;
    const items = g.items.slice(0, room);
    shown += items.length;
    q.push('', '【' + g.name + '】');
    a.push('', '【' + g.name + '】');
    items.forEach(function (x) {
      const h = hintOf_(x.l);
      const nm = x.l.name ? ' 📍' + oneLine_(x.l.name) : '';
      q.push('', '#' + x.n + nm + (h ? '\n🇯🇵「' + h + '」を英語で' : '') + '\n' + svUrl_(x.l));
      a.push('#' + x.n + nm + ' → ' + oneLine_(x.l.item));
    });
  });
  if (shown < total) q.push('', '（ほか ' + (total - shown) + ' か所はアプリで）');

  const spacer = ['', '▼ 答え（思い出してからスクロール）'].concat(new Array(12).fill('・'));
  const tail = ['', 'アプリの「復習」→「今日の復習」で記録しよう！'];
  pushLine_(q.concat(spacer, a, tail).join('\n').slice(0, 4900)); // LINE の上限は 5000 文字
}

// アプリの dueOf() と同じ決まり：予定日があればそれ、未復習は置いた日、古いデータは最後の復習の翌日
const EARLY_DAYS = 2; // アプリの EARLY_DAYS と同じ
function dueOf_(l, today) {
  const s = l.stats || {};
  if (s.due) return s.due;
  const fmt = function (t) { return Utilities.formatDate(new Date(t), TZ, 'yyyy-MM-dd'); };
  if (!s.lastAt) return l.createdAt ? fmt(l.createdAt) : today;
  return addDays_(fmt(s.lastAt), 1);
}
function addDays_(d, n) {
  const p = d.split('-').map(Number);
  return Utilities.formatDate(new Date(Date.UTC(p[0], p[1] - 1, p[2] + n, 3)), TZ, 'yyyy-MM-dd');
}
function svUrl_(l) {
  const fov = Math.round(Math.max(10, Math.min(100, 180 / Math.pow(2, l.zoom == null ? 1 : l.zoom))));
  return 'https://www.google.com/maps/@?api=1&map_action=pano&pano=' + encodeURIComponent(l.panoId) +
    '&heading=' + Math.round(l.heading) + '&pitch=' + Math.round(l.pitch) + '&fov=' + fov;
}
// アプリの hintOf() と同じ決まり：「日本語の問題」欄、なければ「覚えること」の最後の（ ）の中
function hintOf_(l) {
  if (l.question && String(l.question).trim()) return oneLine_(l.question);
  const m = String(l.item || '').match(/[（(]([^（）()]+)[）)]\s*$/);
  return m ? oneLine_(m[1]) : '';
}
function oneLine_(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }

function notifyFromSchedule_() {
  const palaces = JSON.parse(PropertiesService.getScriptProperties().getProperty('SCHEDULE') || '[]');
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const lines = [];
  let total = 0;
  palaces.forEach(function (p) {
    let n = 0;
    Object.keys(p.due || {}).forEach(function (d) { if (d <= today) n += p.due[d]; });
    if (n) { lines.push('・' + p.name + '　' + n + ' か所'); total += n; }
  });
  if (!total) return;
  pushLine_('🧠 今日の復習：' + total + ' か所\n' + lines.join('\n') +
    '\n\n忘れかけたころが覚えどき。アプリの「復習」→「今日の復習」から始めよう！');
}

// LINE の文面を今すぐ試す（エディタで選んで ▶実行）
function testDaily() {
  const st = readState_();
  if (!st) return Logger.log('同期データがまだありません');
  notifyFromState_(st);
}

// 最初に1回だけ、エディタで選んで ▶実行 する（毎日の予約を作る。バックアップもこの時間に動く）
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyNotify') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyNotify').timeBased().everyDays(1).atHour(NOTIFY_HOUR).inTimezone(TZ).create();
  Logger.log('毎日 ' + NOTIFY_HOUR + ' 時台に dailyNotify を動かす予約をしました');
}

// うまく届かないときの確認用：エディタで選んで ▶実行 → 下の「実行ログ」に結果が出る
function testLine() {
  const props = PropertiesService.getScriptProperties();
  ['LINE_TOKEN', 'LINE_USER_ID', 'SECRET'].forEach(function (k) {
    const v = props.getProperty(k);
    Logger.log(k + '：' + (v ? 'あり（' + v.length + ' 文字、先頭 ' + v.slice(0, 2) + '…）' : '★ありません'));
  });
  pushLine_('🔔 テスト（エディタから）：届いていれば LINE 側の設定は OK です');
  Logger.log('同期データのフォルダ：' + syncFolder_().getName() + '（版 ' + (props.getProperty('SYNC_REV') || 0) + '）');
}

function pushLine_(message) {
  const props = PropertiesService.getScriptProperties();
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + props.getProperty('LINE_TOKEN') },
    payload: JSON.stringify({ to: props.getProperty('LINE_USER_ID'), messages: [{ type: 'text', text: message }] }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) Logger.log('LINE への送信に失敗：' + res.getResponseCode() + ' ' + res.getContentText());
  else Logger.log('LINE に送りました');
}

function text_(s) { return ContentService.createTextOutput(s); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

// ===== PC とスマホの同期（Google ドライブに保存） =====
// state.json … 宮殿のデータ全体、images/<id> … 貼った画像（1枚1ファイル）
// SYNC_REV（スクリプト プロパティ）… 版番号。送られるたびに 1 増える。古い版をもとにした上書きは断る
function handleSync_(d) {
  const props = PropertiesService.getScriptProperties();
  const folder = syncFolder_();
  const rev = Number(props.getProperty('SYNC_REV') || 0);
  switch (d.action) {
    case 'meta':
      return { rev: rev, imageIds: imageIds_(folder) };
    case 'pull': {
      const f = fileByName_(folder, 'state.json');
      return { rev: rev, state: f ? JSON.parse(f.getBlob().getDataAsString('UTF-8')) : null, imageIds: imageIds_(folder) };
    }
    case 'images': {
      const imgs = imageFolder_(folder), out = {};
      (d.ids || []).filter(okId_).forEach(function (id) {
        const f = fileByName_(imgs, id);
        if (f) out[id] = f.getBlob().getDataAsString('UTF-8');
      });
      return { images: out };
    }
    case 'putImages': {
      const imgs = imageFolder_(folder);
      Object.keys(d.images || {}).filter(okId_).forEach(function (id) {
        if (!fileByName_(imgs, id)) imgs.createFile(id, d.images[id], MimeType.PLAIN_TEXT);
      });
      return { ok: true };
    }
    case 'push': {
      const lock = LockService.getScriptLock();
      lock.waitLock(20000);
      try {
        const now = Number(props.getProperty('SYNC_REV') || 0);
        if (d.baseRev !== now) return { conflict: true, rev: now }; // ほかの端末が先に送っていた
        if (!d.state || !Array.isArray(d.state.palaces)) throw new Error('データの形が正しくありません');
        const text = JSON.stringify(d.state);
        const f = fileByName_(folder, 'state.json');
        if (f) f.setContent(text); else folder.createFile('state.json', text, 'application/json');
        // 使われなくなった画像は、バックアップでも使っていなければ毎日の片付け（dailyBackup_）で消す
        props.setProperty('SYNC_REV', String(now + 1));
        return { ok: true, rev: now + 1, imageIds: imageIds_(folder) };
      } finally {
        lock.releaseLock();
      }
    }
    case 'backups': { // バックアップの一覧（新しい順）
      return { dates: backupFiles_(folder).map(function (f) { return f.getName().replace(/^state-|\.json$/g, ''); }) };
    }
    case 'restore': { // バックアップの日の内容に戻す（ほかの端末も次に開いたときに戻る）
      const lock = LockService.getScriptLock();
      lock.waitLock(20000);
      try {
        const b = fileByName_(backupFolder_(folder), 'state-' + String(d.date) + '.json');
        if (!b) throw new Error('その日のバックアップがありません');
        const text = b.getBlob().getDataAsString('UTF-8');
        const f = fileByName_(folder, 'state.json');
        if (f) f.setContent(text); else folder.createFile('state.json', text, 'application/json');
        const now = Number(props.getProperty('SYNC_REV') || 0) + 1;
        props.setProperty('SYNC_REV', String(now));
        return { ok: true, rev: now };
      } finally {
        lock.releaseLock();
      }
    }
  }
  throw new Error('不明な操作です：' + d.action);
}

// ===== 毎日のバックアップ（7日分）と画像の片付け =====
const KEEP_BACKUPS = 7;
function dailyBackup_() {
  const folder = syncFolder_();
  const f = fileByName_(folder, 'state.json');
  if (!f) return;
  const text = f.getBlob().getDataAsString('UTF-8');
  const bf = backupFolder_(folder);
  const name = 'state-' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd') + '.json';
  const old = fileByName_(bf, name);
  if (old) old.setContent(text); else bf.createFile(name, text, 'application/json');

  const files = backupFiles_(folder);
  files.slice(KEEP_BACKUPS).forEach(function (x) { x.setTrashed(true); });

  // 今のデータにも、残っているバックアップにも使われていない画像をゴミ箱へ
  const used = {};
  [text].concat(files.slice(0, KEEP_BACKUPS).map(function (x) { return x.getBlob().getDataAsString('UTF-8'); }))
    .forEach(function (t) {
      try {
        JSON.parse(t).palaces.forEach(function (p) { (p.loci || []).forEach(function (l) {
          (l.ink || []).forEach(function (it) { if (it.type === 'image') used[it.img] = true; });
        }); });
      } catch (e) { /* 壊れたファイルは飛ばす */ }
    });
  const it = imageFolder_(folder).getFiles();
  while (it.hasNext()) { const x = it.next(); if (!x.isTrashed() && !used[x.getName()]) x.setTrashed(true); }
  Logger.log('バックアップしました：' + name);
}
function backupFolder_(folder) {
  const it = folder.getFoldersByName('backups');
  return it.hasNext() ? it.next() : folder.createFolder('backups');
}
function backupFiles_(folder) { // 新しい順
  const out = [], it = backupFolder_(folder).getFiles();
  while (it.hasNext()) { const f = it.next(); if (!f.isTrashed() && /^state-\d{4}-\d{2}-\d{2}\.json$/.test(f.getName())) out.push(f); }
  return out.sort(function (a, b) { return a.getName() < b.getName() ? 1 : -1; });
}
function readState_() {
  try {
    const f = fileByName_(syncFolder_(), 'state.json');
    return f ? JSON.parse(f.getBlob().getDataAsString('UTF-8')) : null;
  } catch (e) { return null; }
}

function syncFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SYNC_FOLDER');
  if (id) {
    try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) { /* 消えていたら作り直す */ }
  }
  const f = DriveApp.createFolder('沖縄 記憶の宮殿（同期データ）');
  props.setProperty('SYNC_FOLDER', f.getId());
  props.setProperty('SYNC_REV', '0');
  return f;
}
function imageFolder_(folder) {
  const it = folder.getFoldersByName('images');
  return it.hasNext() ? it.next() : folder.createFolder('images');
}
function fileByName_(folder, name) {
  const it = folder.getFilesByName(name);
  while (it.hasNext()) { const f = it.next(); if (!f.isTrashed()) return f; }
  return null;
}
function imageIds_(folder) {
  const ids = [], it = imageFolder_(folder).getFiles();
  while (it.hasNext()) { const f = it.next(); if (!f.isTrashed()) ids.push(f.getName()); }
  return ids;
}
function okId_(id) { return /^[A-Za-z0-9_-]{1,64}$/.test(String(id)); }
