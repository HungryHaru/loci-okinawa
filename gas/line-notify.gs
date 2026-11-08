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
 * アプリから届くデータ（「いつ・何か所」だけ）：
 *   { palaces: [{ name: '首里城ルート', due: { '2026-11-09': 3, '2026-11-12': 1 } }] }
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
  const palaces = JSON.parse(PropertiesService.getScriptProperties().getProperty('SCHEDULE') || '[]');
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');

  const lines = [];
  let total = 0;
  palaces.forEach(function (p) {
    let n = 0;
    Object.keys(p.due || {}).forEach(function (d) { if (d <= today) n += p.due[d]; });
    if (n) { lines.push('・' + p.name + '　' + n + ' か所'); total += n; }
  });
  if (!total) return; // 今日の復習がない日は送らない（無料の通数を節約）

  pushLine_('🧠 今日の復習：' + total + ' か所\n' + lines.join('\n') +
    '\n\n忘れかけたころが覚えどき。アプリの「復習」→「今日の復習」から始めよう！');
}

// 最初に1回だけ、エディタで選んで ▶実行 する（毎日の予約を作る）
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
        // どこからも使われなくなった画像をゴミ箱へ
        const used = {};
        d.state.palaces.forEach(function (p) { (p.loci || []).forEach(function (l) {
          (l.ink || []).forEach(function (it) { if (it.type === 'image') used[it.img] = true; });
        }); });
        const it = imageFolder_(folder).getFiles();
        while (it.hasNext()) { const x = it.next(); if (!used[x.getName()]) x.setTrashed(true); }
        props.setProperty('SYNC_REV', String(now + 1));
        return { ok: true, rev: now + 1, imageIds: imageIds_(folder) };
      } finally {
        lock.releaseLock();
      }
    }
  }
  throw new Error('不明な操作です：' + d.action);
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
