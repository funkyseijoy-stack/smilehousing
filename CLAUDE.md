# 住まいるアプリ（社内スタッフ用CRM）

住まいるハウジング（釧路市・注文住宅）の社内スタッフ向け業務アプリです。
このファイルは、今後このアプリを編集する人（別の担当者・別のAI・別のセッション）が
すぐに状況を把握できるようにするための資料です。

## これは何のアプリか

- お客様ごとの案件（プロジェクト）を管理する社内CRM。
- 打合せ記録、仕様（外部仕様・設備仕様・電気設備・インテリア基本色・部屋別クロスなど）、
  写真・アルバム、タスク、見積、Gmail連携などのタブを持つ1ページアプリ。
- お客様自身が見る「おうちノート」という別サイトと連携しており、スタッフがここで
  資料や写真を「送る」と、お客様側のおうちノートにも表示される。

## 技術構成

- **リポジトリ**: `funkyseijoy-stack/smilehousing`（GitHub）
- **本体ファイル**: `public/app/index.html` 1ファイルのみ（HTML + CSS + JS が全部入り、
  約6,200行）。スタッフはほぼこの1ファイルを編集することになる。
- **ホスティング**: Netlify。`main` ブランチに push すると自動デプロイされる。
  - サイト名: `sprightly-pegasus-9b65a7`
  - サイトID: `aaa40722-82c5-449c-aaf4-dc14fd63be41`
- **サーバー処理**: `netlify/functions/*.mts`（Netlify Functions）。データの保存先は
  `@netlify/blobs`（Netlifyが提供するシンプルなデータストア。別途データベース契約は不要）。
- **認証**: 合言葉（パスフレーズ）方式。`sumairu2026` がスタッフ用の合言葉で、
  各Functionファイルの `STAFF_PASSPHRASE` にハードコードされている
  （`staff-auth.mts`, `staff-data.mts`, `staff-upload-photo.mts`, `okainote-bridge.mts`,
  `gmail-*.mts`, `google-oauth-start.mts` など）。**変更する場合は、これらのファイル
  すべてで同じ値に揃える必要がある**（コード内にもその旨のコメントあり）。

## 主なデータの流れ

- 汎用データAPI: `netlify/functions/staff-data.mts`（`/api/staff-data`）
  - `collection`（例: `projects`, `meetingNotes`, `specPhotos`, `albumPhotos`, `tasks` など）
    ごとに GET（一覧取得）/ POST（新規作成）/ PUT（更新）/ DELETE（削除）。
  - 許可されているコレクション名は `ALLOWED_COLLECTIONS` 配列で管理（新しいデータ種別を
    追加する時はここに追記が必要）。
  - PUT で `replace:true` を渡すとドキュメント全体を上書き保存（住まいるアプリ本体は
    基本これを使う）。省略時は差分マージ。
- 写真アップロード: `netlify/functions/staff-upload-photo.mts`（`/api/staff-upload-photo`）
  → `customerPhotos` ストアに保存。取得は `get-photo.mts`（`/api/get-photo`）。
- Gmail連携: `gmail-*.mts` + `google-oauth-*.mts`（Google OAuth経由）。

## お客様向け「おうちノート」との関係（重要・制約あり）

- おうちノート本体は **別サイト** `strong-piroshki-295252.netlify.app`
  （サイトID `cfadf5cb-fcdc-4abe-b74d-c27c355546fd`）。
- 住まいるアプリからは `netlify/functions/okainote-bridge.mts` が単なる中継（プロキシ）
  として、`x-staff-code` ヘッダーに合言葉を付けて叩いているだけ。
- **重要**: このリポジトリ内に `customer-site/` というフォルダがあり、見た目は
  おうちノートのソースに見えるが、Netlifyの実際のデプロイ記録を確認したところ、
  本番の `strong-piroshki-295252` は **GitHubと連携しておらず**、`deploy_source: "api"`
  （直接アップロード/ドロップデプロイ）になっている。つまり `customer-site/` を
  編集してpushしても、本番のおうちノートには反映されない可能性が高い
  （過去に試みた分離作業の名残と見られる）。
  - おうちノート本体を編集するには、それがどこで（どのAIセッション/どのツールで）
    作られ、どうやって現在のNetlifyサイトにアップロードされているかを、まず
    ともこさんに確認する必要がある。
  - 関連しそうな構想メモ: 「統合アプリ」「おうち決定ノート」など、複数の似た取り組みが
    並行している可能性があるので、依頼時にどのサイトのことか明確にすると良い。

## 編集を依頼する人向け：進め方の目安

1. まず `public/app/index.html` を読んで、該当する画面・関数を探す
   （タブは `data-tab` 属性で分かれている：`home`, `projects`, `pending`, `trash`,
   `gmail`, `brand`, `settings` など）。
2. 画面側を直すだけで済むか、`netlify/functions/*.mts` 側の修正も要るかを見極める。
3. 編集したら、最後の `<script>...</script>` だけ取り出して `node --check` で
   構文チェックしてからコミットする（1ファイルが大きいため、ミスに気づきにくい）。
4. `main` に push → Netlifyの自動デプロイを確認（サイトID `aaa40722-82c5-449c-aaf4-dc14fd63be41`
   のデプロイ状態が `ready` になり、`commit_ref` が最新コミットと一致することを確認）。
5. 可能なら、変更内容をブラウザで実際に操作して確認する。

## 既知の注意点・クセ

- `saveDoc()`（旧実装）はステータス401以外を全部「成功」とみなす不具合があったため
  修正済み（2026年10月）。今後も「保存系の関数は `res.ok` を必ず確認する」方針を守ること。
- 仕様タブ（外部仕様など）のカテゴリーカードは横スクロールの固定幅カード
  （`.speccat`、現在320px）。中の要素を増やすと簡単に詰まって見づらくなるので、
  `flex-wrap` やカード幅の調整が必要になりやすい。
- 合言葉はソースにハードコードされているため、担当者が変わる・外部に漏れた場合は
  手動で全ファイルを書き換えて再デプロイする必要がある（自動ローテーションの仕組みはない）。

## 連絡・引き継ぎ

このアプリに詳しいAIセッション（Claude）に相談する場合は、このリポジトリを
Claudeに接続した上でこのファイルを読んでもらえば、経緯を一から説明しなくても
作業を始められます。
