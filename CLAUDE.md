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
- `help.html` … 使い方ページ（機能を変えたらここも更新する）
- `server.py` … ローカルサーバー（静的配信＋`POST /open-chrome` で許可した URL（claude.ai のみ）を Chrome で開く。Origin チェックあり）。`python -m http.server` で起動した場合は app.js 側が `window.open` にフォールバック
- `start-app.ps1` … デスクトップショートカット用ランチャー（server.py を 127.0.0.1:8000 で起動 → Chrome `--app` で開く。ブラウザは Chrome に統一）。PS 5.1 が読むので **ASCII のみ**で書くこと
- `gas/line-notify.gs` … LINE 通知用の Google Apps Script（ユーザーが script.google.com に貼って使う。ウェブアプリ `doPost` で予定を受け取り、毎日12時の `dailyNotify` で LINE Messaging API の push）。トークン類はスクリプト プロパティ
- `icon.svg`（PWA/ファビコン）, `icon.ico`（ショートカット用）, `manifest.json`
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
- `state = { palaces: [{ id, name, createdAt, loci: [...] }], currentId }` を IndexedDB `loci-okinawa` の `kv` ストア `state` キーに保存（`save()` で自動保存、旧 localStorage からは自動移行）。
- locus: `{ id, panoId, lat, lng, heading, pitch, zoom, item, image, ink: [], stats: { ok, ng, lastOk, lastAt, streak, due }, createdAt }`
- ink アイテムは角度座標 `[heading, pitch]`（度）で保存し、`camera()` / `angleToScreen()` で投影（視野角 = 180 / 2^zoom と仮定）。
  - `{ type: 'stroke', color, width, pts: [[h,p],...] }`
  - `{ type: 'note', at: [h,p], text, color }`
  - `{ type: 'image', at: [h,p], img: <imagesストアのキー>, aspect, size: <横幅の角度(度)> }`
- 画像データ（dataURL、384px に縮小・白背景透過）は IndexedDB `images` ストア。起動時に未参照を `gcImages()` で削除。
- `kv` の `vault` キーに Obsidian Vault の FileSystemDirectoryHandle。
- APIキーは localStorage `loci-okinawa-apikey`（コードには書かない）。
- 間隔反復：`INTERVALS`（日）と `scheduleNext()` / `dueOf()`。`due` は 'YYYY-MM-DD'。忘れたら streak=0・翌日。
- LINE 通知：localStorage `loci-okinawa-notify-url`（Apps Script の URL＋`?key=合言葉`）。保存のたびに `uploadNotify()` が宮殿名と日付ごとの数だけを送る（内容は送らない）。

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
- PC とスマホのデータ同期
- ズーム時の落書きのずれがあれば視野角の式を調整
