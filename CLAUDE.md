# 沖縄 記憶の宮殿 — 開発メモ（Claude 向け）

Google ストリートビューで沖縄を歩き、場所法（記憶の宮殿）のルートを作って復習する**自分用** Web アプリ。
ユーザーは日本語話者でプログラミング初心者寄り。説明は日本語・平易に。UI 文言も日本語。

## 方針（ユーザーと合意済み）
- **無料で運用**（Google Maps の無料枠＋1日の割り当て上限で課金を防ぐ）。有料 API を足すときは必ず相談。
- 範囲は**沖縄限定**（`BOUNDS`）。利用者は本人だけ。
- **ストリートビュー画像は保存しない**（Google 規約）。保存するのは panoId・位置・向き・ズームのみ。
- Obsidian 連携は**アプリ → Vault の一方通行**。
- AI 画像はアプリから生成しない（無料の外部 AI で作って貼る）。プロンプトのコピー機能のみ。

## 構成（ビルドなし・素の HTML/CSS/JS）
- `index.html` / `style.css` / `app.js` … アプリ本体（app.js 1ファイル）
  - 色は style.css の `:root` のトークンだけで決める（ライト／`prefers-color-scheme: dark`／`[data-theme="dark"]` の3か所を同じ名前で）。画面の色は localStorage `loci-okinawa-theme`（なし＝自動・light・dark）、index.html の head で先に当てる。記録タブのグラフ色も `var(--heat-*)` / `var(--lv-*)`
  - 見た目は「琉球デザイン」（2026-11-11）：琉球藍の地＋紅型（びんがた）風の花模様のヘッダー、ミンサー織（五つと四つ）の帯、朱印風の番号、藍染めの濃淡の復習カレンダー。文字は Google Fonts の Zen Antique Soft（見出し・数字）と Zen Maru Gothic（本文）。模様は style.css に SVG の data URI で直接入っている（`__BINGATA__` などの置き換えで作った。描き直すときは同じ色を使う）
  - 復習の終わりの言葉：全問正解「上等！」、半分以上「ちばりよー！」、それ未満「なんくるないさ」
- `help.html` … 使い方ページ（機能を変えたらここも更新する）
- `server.py` … ローカルサーバー（静的配信＋`POST /open-chrome` で許可した URL（claude.ai のみ）を Chrome で開く。Origin チェックあり）。`python -m http.server` で起動した場合は app.js 側が `window.open` にフォールバック
- `start-app.ps1` … デスクトップショートカット用ランチャー（server.py を 127.0.0.1:8000 で起動 → Chrome `--app` で開く。ブラウザは Chrome に統一）。PS 5.1 が読むので **ASCII のみ**で書くこと
- `gas/line-notify.gs` … クラウド連携用の Google Apps Script（ユーザーが script.google.com に貼って使う）。トークン類はスクリプト プロパティ
  - 毎日12時の `dailyNotify`：① `dailyBackup_()`（Drive の backups/ に state-YYYY-MM-DD.json を7日分。今の state にもバックアップにも使われていない画像をゴミ箱へ）② `notifyFromState_()`（state.json から今日の復習を計算し、問題＝Street View リンク、答え＝下の方、最大15か所）。同期データがなければ旧方式 `notifyFromSchedule_()`（アプリが送った日付ごとの数）
  - `isDue_()` はアプリの `dueOf()` と同じ決まりにすること（片方を変えたら両方直す）
  - 同期：`doPost` の `action`（meta / pull / images / putImages / push / backups / restore）。push では画像を消さない（片付けは毎日のバックアップ時）。Drive の「沖縄 記憶の宮殿（同期データ）」に state.json と images/<id>。版番号 `SYNC_REV` で古い版からの上書きを断る（衝突はアプリ側で本人に選ばせる）
  - コードを変えたらユーザーに「デプロイを管理 → 新バージョン」をしてもらう（URL を変えないため）
- iPhone のホーム画面アプリは**消すとデータも消える**。アイコンの入れ直しを案内するときは、先にクラウド同期が済んでいるか確認してもらう
- `icon.svg`（PWA/ファビコン）, `apple-touch-icon.png`（iPhone のホーム画面。角を丸めない・透明なしの正方形。icon-180.png に藍の地を敷いたもの）, `icon-180.png`, `icon-192.png` / `icon-512.png`（Android）, `icon.ico`（ショートカット用）, `manifest.json`
  - アイコンは琉球藍 #1f3b6e の地に朱の首里城 正殿（2026-11-11）。PNG と ico は icon.svg から書き出したもの。描き直すときは全サイズをそろえ、index.html・help.html・manifest.json のアイコン URL の `?v=2` を 1 つ上げる（キャッシュ対策）。style.css・app.js を変えたら index.html の `?v=3` も上げる（GitHub Pages は10分キャッシュ。server.py は no-cache を返す）。デスクトップのショートカットは OneDrive\画像\loci-okinawa-icon.ico を参照しているので、そちらにもコピーする
- デスクトップに `沖縄 記憶の宮殿.lnk`（OneDrive\デスクトップ）

## git
- このフォルダ専用のリポジトリ（ブランチ `main`）。ホームフォルダ `C:\Users\HARUKI` にも別の古い練習用リポジトリ（sample-chatbot）があるが無関係なので触らない。
- バックアップ JSON（`loci-okinawa-*.json`）は `.gitignore` で除外。
- リモート：https://github.com/HungryHaru/loci-okinawa （公開）。`main` に push すると GitHub Pages に反映される。
- このPCでは git の SSL 証明書エラーが出るため、リポジトリ設定で `http.sslBackend=schannel` にしてある。

## 公開先（GitHub Pages）
- https://hungryharu.github.io/loci-okinawa/ （APIキーのウェブサイト制限に追加済み）
- ネット上では server.py がないので、`openInChrome()` は localhost 以外ではすぐ `window.open`。
- データ（IndexedDB）は PC の localhost 版とは別の保存場所になる。

## データ
- `state = { palaces: [{ id, name, createdAt, loci: [...] }], currentId, history: { 'YYYY-MM-DD': [覚えてた, 忘れた] } }` を IndexedDB `loci-okinawa` の `kv` ストア `state` キーに保存（`save()` で自動保存、旧 localStorage からは自動移行）。
- locus: `{ id, panoId, lat, lng, heading, pitch, zoom, name?, item, image, question?, ink: [], stats: { ok, ng, lastOk, lastAt, streak, due }, createdAt }`
  - 記録タブ（`statsHTML()`）：次の復習日 `nextReview()`（毎日やらせる「連続日数」は、ユーザーの希望で廃止）、覚え具合 `levelOf()`（streak 0-2 覚え中／3-4 定着／5+ 長期記憶）、12週カレンダー。history は `answer()` → `recordHistory()` で記録、400日より前は消す
  - `name`（任意）は目印の名前（一覧・復習・ピン・LINE・Obsidian に表示）。`question`（任意）は日本語の問題。`hintOf()` は question → なければ item の最後の（ ）の中。gas の `hintOf_()` と同じ決まりにする。復習で出すかは localStorage `loci-okinawa-hint`
- ink アイテムは角度座標 `[heading, pitch]`（度）で保存し、`camera()` / `angleToScreen()` で投影（視野角 = 180 / 2^zoom と仮定）。
  - `{ type: 'stroke', color, width, pts: [[h,p],...] }`
  - `{ type: 'note', at: [h,p], text, color }`
  - `{ type: 'image', at: [h,p], img: <imagesストアのキー>, aspect, size: <横幅の角度(度)> }`
- 画像データ（dataURL、384px に縮小・白背景透過）は IndexedDB `images` ストア。起動時に未参照を `gcImages()` で削除。
- `kv` の `vault` キーに Obsidian Vault の FileSystemDirectoryHandle。
- APIキーは localStorage `loci-okinawa-apikey`（コードには書かない）。
- 間隔反復：`INTERVALS`（日）と `scheduleNext()` / `dueOf()`。`due` は 'YYYY-MM-DD'。忘れたら streak=0・翌日。未復習は置いた日が復習日。
  - `EARLY_DAYS`=2：2日以内に予定の場所は「今日の復習」にまとめ、前倒しでも正解なら間隔を進める（復習日を集めて毎日にしない）。同じ日の2回目は進めない
  - `joinDay()`：次の復習日の近く（最低 1日前〜3日後、長い間隔は ±2割）にほかの場所の復習日があれば合わせる。忘れた場所は 1〜3日後の既存の復習日に合流
  - LINE は「ちょうど今日が復習日」の場所がある日だけ（忘れてやり直し中の場所だけなら3日後、遅れは1週間後に1回）。ユーザーの希望：毎日の復習はきついので、ポイントの日だけ
- LINE 通知：localStorage `loci-okinawa-notify-url`（Apps Script の URL＋`?key=合言葉`）。保存のたびに `uploadNotify()` が宮殿名と日付ごとの数だけを送る。
- 同期：同じ URL を使う。`save()` → `markCloudDirty()` → 2秒後 `cloudSync()`。起動時・画面に戻ったとき・online でも `cloudSync()`。localStorage `loci-okinawa-sync-rev`（最後にそろえた版）/ `-sync-dirty`（未送信あり）。クラウドから読んだときは `save(true)`（送り返さない）。読み込む直前の state は kv `state-before-sync` に1つだけ控える。

## Obsidian 書き出し（`syncObsidian()`）
- Vault: `C:\Users\HARUKI\OneDrive\ドキュメント\Obsidian Vault`
- `記憶の宮殿/<宮殿名>.md`, `記憶の宮殿/画像/<id>.webp`, `記憶の宮殿/_data.json`
- Spaced Repetition プラグイン形式のカード行 `質問::答え` を含む。変更のあったファイルだけ書く。

## 使用 API
- Maps JavaScript API（地図・StreetViewPanorama・StreetViewService）
- Places API (New) の `Place.searchByText`（Enter 時のみ、`locationRestriction: BOUNDS`）

## 確認方法
- 構文チェック: `node --check app.js`
- 起動: デスクトップのアイコン、または `python -m http.server 8000` → http://localhost:8000
- ブラウザでの動作確認は Claude からはできない（APIキーが必要）。ユーザーに確認してもらう。

## 今後のアイデア（未実装）
- ズーム時の落書きのずれがあれば視野角の式を調整
