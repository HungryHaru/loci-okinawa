/**
 * 沖縄 記憶の宮殿 — LINE で復習のお知らせ（Google Apps Script 用）
 *
 * このファイルの中身を、Google Apps Script のエディタ（コード.gs）にまるごと貼り付けて使う。
 * 手順はアプリの「？（使い方）」→「LINE で復習のお知らせ」を見てください。
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
