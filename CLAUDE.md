# 住まいるアプリ（社内スタッフ用CRM）

住まいるハウジング（釧路市・注文住宅）の社内スタッフ向け業務アプリです。
このファイルは、今後このアプリを編集する人（別の担当者・別のAI・別のセッション）が
すぐに状況を把握できるようにするための資料です。

## これは何のアプリか

- お客様ごとの案件（プロジェクト）を管理する社内CRM。
- 打合せ記録、仕様（外部仕様・設備仕様・電気設備・インテリア基本色・部屋別インテリアなど）、
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

## 新しいおうちノート（/note/、試作版・2026年10月〜）

- 旧おうちノート（strong-piroshki）のソースが無く、改修できないため、同じ見た目で
  **このリポジトリ内に作り直したもの**。URLは `https://sprightly-pegasus-9b65a7.netlify.app/note/?p=<案件ID>&t=<noteToken>`。
- 画面: `public/note/index.html`（1ファイル）。API: `netlify/functions/note-data.mts`（`/api/note-data`）。
- 住まいるアプリと**同じデータ（staffData）を直接読む**ので、連携用の橋渡しは不要。
  - 平面図 = 見積タブの「図面」（attachments の kind:"plan"）
  - 設備仕様の各項目 = 「おうちノートに反映」済みの仕様写真・プランボード・打合せ記録（時系列）
  - 玄関（玄関ドア・玄関枠）は「外部」に統合
  - お客様の「仮決定／決定」は `noteDecisions` コレクションに保存（住まいるアプリの仕様タブに「お客様：決定」等のバッジで表示）
  - お客様からのメッセージは `messages` に `fromCustomer:true` で保存
  - お知らせ・豆知識／契約後に知っておきたいこと／ご利用中のサービスは `noteNotices`（業者・設定タブで編集）
- 認証: 案件ごとの `noteToken`（案件 → おうちノートタブの「新しいおうちノート」でリンク発行）。
- お客様画面の項目と住まいるアプリのカテゴリーの対応は、`note-data.mts` の `noteCatFor` と
  `public/app/index.html` の `noteCatIdFor` の**2か所に同じ内容**がある。変更時は両方直すこと。
- 設備仕様の一覧は8項目（外部・キッチン・お風呂・洗面・トイレ・暖房・換気・電気・あかり・インテリアメイン・各部屋）。トイレ（1階・2階）、暖房・換気、電気・あかりは1項目に統合している（統合前のID `toilet1` 等で保存された決定は `LEGACY_CAT_MAP` で読み替え）。
- 「各部屋」（id `rooms`）は部屋別インテリア（scope:"room"）を部屋ごとに表示し、「仮決定／決定」も部屋単位（`noteDecisions` の `roomId` 付き、ID は `<案件ID>__rooms__<部屋ID>`）。インテリアメインには床・建具・クロスなど家全体の基本色だけを出す。
- お家のイメージ（2026年10月〜）: アルバムとは別に、お客様とスタッフが双方で写真を追加できる場所。`imageBoard` コレクション（`ALLOWED_COLLECTIONS` に追記済み）。お客様は `note-data.mts` の `imageAdd` / `imageDelete`（自分の写真のみ削除可）、スタッフは住まいるアプリの「写真・アルバム」タブの「お家のイメージ」から。場所タグ（外観・LDKなど）は `note-data.mts` の `IMAGE_PLACES` と `public/app/index.html` の `IMAGE_PLACES` の**2か所**に同じ内容があるので、変更時は両方直すこと（お客様画面はサーバーから受け取る）。
- 設備仕様の「契約時仕様／見積もり仕様」タブ（2026年10月〜）: お客様画面の各項目（各部屋は部屋ごと）に、「すべて／契約時仕様／見積もり仕様」の切り替えを出す。分類は住まいるアプリの仕様履歴・打合せ記録のバッジ（`badges.contract`／`badges.quote`）で、`note-data.mts` が各項目の `spec:{contract,quote}` として渡す（社内タスクなど他のバッジはお客様に渡さない）。分類された項目が1つもない項目ではタブを出さない。
- ヘッダーのボタン（決める順番・わたしのメモ・使い方・メッセージ）: 「決める順番」は `public/note/index.html` の `DECISION_ORDER`（全お客様共通の文言）。「わたしのメモ」はお客様の端末のlocalStorageにだけ保存し、サーバー・スタッフには送らない。
- 見積（kind:"quote"）や社内タスクはお客様には出さない設計。
- 現場写真（スタッフ限定、2026年10月〜）: リフォーム案件（`type==="リフォーム"`）の「写真・アルバム」タブに出る `sitePhotos` コレクション（`ALLOWED_COLLECTIONS` に追記済み）。**お客様画面には出さない**ので、`note-data.mts` には読み込みを追加しないこと。場所タグは `public/app/index.html` の `SITE_PLACES`、撮影日・メモ付きで複数枚まとめて追加できる。
- 打合せ記録の「操作」メニュー（2026年10月〜）: 「→社内タスクへ」等のほかに「→追加見積もりへ」があり、おうちノート連携の追加見積り（`customerEstimates`）に金額なし（お客様画面は「金額確認中」）で追加する。金額は「おうちノート」タブの追加見積り一覧で入力。登録済みかどうかは打合せ記録の `sent` フィールド（バッジ表示）で管理。
- 仕様タブの履歴から依頼（2026年10月〜）: 仕様の各カテゴリーの履歴カード（写真・PDF）に「タスク依頼」ボタンがあり、社内タスク／業者タスク／お客様への確認／お客様の検討事項へ入れられる（`openSpecTaskMenu`。登録処理は打合せ記録のバッジと共通の `autoCreateLinkedItem`、部位はカードのカテゴリーから自動設定、写真は添付）。登録済みは仕様写真の `sent` フィールドで管理し、カードにバッジ表示・二重登録を防止。
- タスク画面の担当者での絞り込み（2026年10月〜）: 「すべて／社内／業者」の下に、担当者（設定のスタッフ一覧＋タスクに入っている担当名）と「担当未設定」で絞り込むチップ（`state.taskAssigneeFilter`、`renderTaskAssigneeFilterBar`）。
- タスクの確認依頼・担当者（2026年10月〜）: タスクに `checker`（確認者）欄を追加（フォーム「確認者（確認依頼）」）。カンバンの進捗列に「社長確認依頼中」「朋子確認依頼中」を追加（`STATUS_ORDER`。2026年10月に「確認中」から改名）。種類の絞り込みに「確認依頼」（checkerあり）、担当者の絞り込みは担当者・確認者のどちらかが一致で表示。打合せ記録の「→社内/業者タスクへ」と仕様履歴の「タスク依頼」では担当者を選んで作成（`askAssignee`）。
- 確認者を選んだタスク（2026年10月〜）: 確認者に社長／朋子を選んで保存すると、進捗が自動で「社長確認依頼中」／「朋子確認依頼中」に入り、タスク画面でそのカードを強調表示する（`checkStatusFor`。編集で確認者を変えたときも移動。該当の列がない人は進捗を変えない）。確認者を選ぶと指示者は自動で「なし」になり、指示者は空のままでも保存できる。
- タスク依頼後の移動（2026年10月〜）: 打合せ記録・仕様履歴から社内／業者タスクを作ると、ホームのタスク画面へ移動して新しいカードを強調表示する（`goToTaskBoard`。絞り込みは解除）。
- 予約（2026年10月〜）: `netlify/functions/note-calendar.mts`（`/api/note-calendar`）。空き状況は Googleカレンダー「お客様予約」＋ 住まいるアプリの `reservations` から判定（9:00〜17:00・30分刻み・1枠2時間・日曜と祝日は不可、同時刻は1件のみ）。確定すると同カレンダーに予定を登録し、`reservations` にも保存する。種類は 来店／オンライン／銀行／ショールーム。
- 予約の編集（2026年10月〜）: 案件の「予約」タブとホームの「新規のお客様のご予約」の各予約に「✏️ 編集」（`openResEdit`／`saveResEdit`）。サーバーは `netlify/functions/reservation-update.mts`（`/api/reservation-update`、合言葉で認証・`STAFF_PASSPHRASE` あり）。日時を変えると他の予約・カレンダーとの重なりを確認（重なる場合は409→画面で「このまま変更する」を選べば `force:true` で保存）、Googleカレンダー「お客様予約」の予定（`googleEventId`）も新しい日時に更新（失敗しても予約は保存し画面に知らせる）、送信済みの前日リマインドは送り直せるよう解除する。お客様へのお知らせは従来どおり「メールを送る」→日時変更。
- 画面幅: アプリ全体は画面いっぱいに広がる（`.wrap` の最大幅なし、左右の余白は `body` の `clamp(12px,1.6vw,32px)`）。
- タスク一覧（カンバン）は進捗7段階（未着手→対応中→社長確認依頼中→朋子確認依頼中→業者連絡済み→お客様へ連絡済み→完了。`STATUS_ORDER`）を、進捗ごとに縦に積み、見出しのタップで開け閉めする形で表示する（案1。最初は未着手〜朋子確認依頼中が開き、業者連絡済み以降は閉じる。`state.taskOpen`。カードは2列、画面幅900px以下は1列）。進捗の変更は各カードの「進捗を変更する ▾」（`setTaskStatus`）から好きな段階へ直接移せる（「前へ／次へ」は廃止）。移した先の見出しは自動で開く（`goToTaskBoard` も同様）。横スクロールはなし。旧「対応済み」は廃止し、既存タスクは起動時に `migrateLegacyTaskStatus` で「業者連絡済み」へ移す。
- 新規のお客様向けの公開予約（2026年10月〜）: `https://sprightly-pegasus-9b65a7.netlify.app/yoyaku/`（画面 `public/yoyaku/index.html`、API `netlify/functions/public-booking.mts`）。ログイン不要で、種類は「ショールーム見学＆おうち相談」のみ。空き状況のルール（9:00〜17:00・30分刻み・1枠2時間・日曜祝日不可・前後1時間の間隔）は `netlify/lib/booking.mts` に共通化してあり、おうちノートの予約（`note-calendar.mts`）と同じ「お客様予約」カレンダーを見る。予約は `reservations` に `projectId:""`・`source:"public"`・`customerName/phone/email/notes` で保存し、カレンダー登録＋スタッフへ通知メール。住まいるアプリのホームの「新規のお客様のご予約」に今日以降の分が出る。誰でも叩ける公開APIなので、入力チェック・ハニーポット欄・同じ連絡先は今後2件まで・24時間で15件までの上限を入れている。
- 新規のお客様へのメール（2026年10月〜）: 予約ページの予約者だけが対象（おうちノートのお客様はおうちノートで連絡する）。メールアドレスは必須。共有Gmail（smilehousing8@gmail.com）から差出人名「住まいるハウジング」で送り、お客様の返信はそのGmailに届く（住まいるアプリのホーム「新規のお客様のご予約」の「やりとりを見る」＝Gmailタブで検索）。送信は `netlify/lib/google.mts` の `sendMailTo`。文面は `netlify/lib/customer-mail.mts`（確認メール＝予約直後に `public-booking.mts` が送信／前日リマインド＝`netlify/functions/booking-reminder.mts` が毎朝9:00 JSTに実行する定期関数。予約から12時間以内は送らない・送れなければスタッフへ通知）。スタッフが送る日時変更・キャンセル・自由なメッセージは `netlify/functions/customer-mail.mts`（合言葉で認証・宛先は予約に保存されたメールだけ。キャンセルは予約をごみ箱へ移し、希望すればGoogleカレンダーの予定も削除）で、文面の雛形は `public/app/index.html` の `cmTemplate`（署名 `CM_SIGNATURE` は `CUSTOMER_MAIL_SIGNATURE` と同じにすること）。`customer-mail.mts` にも `STAFF_PASSPHRASE` がある。
- 通知: お客様の予約・メッセージ送信時に `netlify/lib/google.mts` の `sendNotifyMail` で smilehousing8@gmail.com へメール（失敗しても処理は止めない）。
- カレンダー・メール送信にはGoogle連携（設定タブの「Gmailと連携する」）でカレンダー権限（calendar.events）の許可が必要。権限追加後は一度やり直すこと。Google Cloud側でCalendar APIの有効化も必要。
- 旧おうちノートからの切り替え（既存のお客様への案内）はまだ。確認後に判断する。

- 仕様履歴カードの編集・メモ（2026年10月〜）: 仕様タブの履歴カード（写真・PDF・打合せ記録）に「✏️ 編集」（`openSpecEdit`／`saveSpecEdit`、モーダル `#spEditModal`）。スタッフ用メモを `specPhotos` の `memo` に保存しカードに「📝」表示、写真・PDFは日付（`createdAt`）も変更可。打合せ記録は「記録の内容を編集」で既存の `editMeetingNote` へ移動。`memo` はお客様画面（`note-data.mts`）には出さない。

- 旧おうちノートの一覧更新（2026年10月〜）: 追加見積り（`customerEstimates`）・家づくりリスト（`considerations`）の追加／金額変更／削除は、画面のキャッシュではなく `okaiUpdateList(projectId, key, mutate)` で「最新を取り直す→変更→書き戻す」を案件ごとに1件ずつ順番に実行する（古いキャッシュで全件を書き戻して他の項目を消す不具合の対策）。打合せ記録の「→追加見積もりへ」は、書き戻し後の一覧に項目が入っているのを確認してから「追加見積もり済」にする。

- 業者タスクの複数社対応（2026年10月〜）: 1つのタスク（カード）に複数の依頼先を入れられる。`t.vendors=[{name,status}]`（会社ごとの進捗＝未連絡／連絡済み／返答あり／完了。カード上の進捗の印を押すと次へ進む `cycleVendorStatus`）と、互換用に会社名を「、」でつないだ `t.requestTo` を両方持つ（`setTaskVendors`／`taskVendors`。`vendors` が無い旧タスクは `requestTo` 1社として扱う）。全社が「連絡済み」以降になると、カードの進捗が「未着手／対応中」のときだけ自動で「業者連絡済み」へ進む（`autoAdvanceByVendors`）。依頼先を選ぶのは、タスク入力フォーム（チェックボックス）・打合せ記録の「→業者タスクへ」・仕様履歴の「タスク依頼」・記録のバッジ（`askVendorForBadge` が業者IDの配列を返す）。業者ごとの見積依頼（`requests`）も会社の数だけ作る。打合せ記録の「→業者タスクへ」は、業者を選ぶとそのタスクを最初から「業者連絡済み」（各社も「連絡済み」）で作る（業者を選ばなければ「未着手」）。

- 文字の大きさ（2026年10月〜）: 60代の方でも読みやすいよう、住まいるアプリ全体の文字を大きくした（お客様用おうちノートは対象外）。`html{font-size:clamp(18px, 0.35vw + 15.5px, 21px)}`（全サイズが rem 基準なので全体が連動。画面が広いほど少し大きい）と、`font-size` の最小を `.85rem` に統一（それより小さい値は使わない）。新しい文字を足すときも `.85rem` 未満にしないこと。`.speccatgrid .speccat` の最小幅は340px。

- 旧おうちノートのお客様リンク欄の廃止（2026年10月〜）: 案件の「おうちノート連携」タブから旧「お客様用リンク」カードを削除し、案件ヘッダーのボタンも「おうちノートを見る」「お客様用リンクをコピー」を**新しいおうちノート（/note/）のリンク**に付け替え（「おうちノートに同期する」ボタンは削除）。リンク未発行なら「おうちノート連携」タブで発行するよう案内。（追加見積り等は、その後「旧おうちノートからの引っ越し」で本体側へ移した。）

- 追加見積りの状態切り替え（2026年10月〜）: 「おうちノート連携」タブの追加見積りの各カードに「状態」の選択欄（金額確認中／承認依頼／承認済み／見送り、`OKAI_EST_STATES`・`okaiSetEstimateState`）。選んだ値は `customerEstimates` の `estimateState` に保存し、旧おうちノート側の `customerResponse`（承認／見送り／未回答）も合わせて更新する。`estimateState` が無い古いデータは金額・回答から自動判定（`okaiEstimateState`）。新おうちノート（`note-data.mts`→`public/note/index.html`）は `estimateState` が「金額確認中」なら金額が入っていても「金額確認中」と表示。保存後に返ってきた一覧に `estimateState` が入っているか確認し、入っていなければエラー表示（旧おうちノート本体のサーバーが未知の項目を捨てる場合の検知）。

- 「反映」スイッチの統一（2026年10月〜）: 打合せ記録・仕様履歴（写真／PDF／プランボード）・業者タスクの「反映」ボタンは、すべて「反映する」⇔「✓反映済み」の表記で、反映済みは緑のベタ塗り（`.pill.reflect.on`）。新おうちノート（/note/）は `reflected` フラグを直接読むだけで、旧おうちノートへ送る処理は呼ばない（旧への自動送信・外部「色・仕様」の反映ボタン・一括反映内の旧送信を削除。`pushSpecPhotoToOkai` 等の関数と `syncAllToOkaiNote` は呼び出し元の無い残骸）。追加見積り・家づくりリストへの反映（`okaiUpdateList`）は、noteExtras（本体側）への保存。

- 旧おうちノートからの引っ越し（2026年10月〜）: 追加見積り（`customerEstimates`）・家づくりリスト（`considerations`）・ご家族・家電・持ち込み品（`customerProfile`）・A's 3Dリンク（`customerLinks`）・手動の予約（`nextBookings`）は、**住まいるアプリ本体のデータ置き場**（staffData の `noteExtras/<案件ID>`、1案件1ドキュメント）に保存する。`netlify/lib/note-extras.mts` の `getExtras` が、ドキュメントが無いときだけ旧おうちノート本体から1回だけ写す（旧側は消さない。旧側と通信できないときは保存せず502を返し、次に開いたときにやり直す）。以後は旧側を一切見ない・書かない。`netlify/functions/okainote-bridge.mts` は名前と URL（`/api/okainote-bridge`）はそのままで、中身を noteExtras の読み書き（GET data／PATCH）に差し替えた（住まいるアプリ画面側のコードは変更なしで動く。`ensureLink` は410、受信箱は空）。新おうちノート（`note-data.mts`）も `getExtras` から読む。旧おうちノート本体へ送る古い関数（`pushSpecPhotoToOkai` など）は呼び出し元の無い残骸。
- お客様の追加見積りの承認／見送り（2026年10月〜）: 新おうちノート（/note/）の追加見積りで、金額が入っている項目に「承認する／見送る」ボタン（承認後は「回答をやり直す」）。`note-data.mts` の `estimateRespond`（金額確認中は不可）が `customerResponse`／`customerRespondedAt`／`estimateState`（承認済み・見送り・承認依頼）を更新し、`sendNotifyMail` でスタッフへ通知する。スタッフ側の状態選択（`okaiSetEstimateState`）と同じ項目を共有。
- 打合せ記録フォームの社内タスク（2026年10月〜）: 「社内タスク」バッジを押した時点で担当者を選ぶ（業者タスクで業者を選ぶのと同じ。`askAssignee`、`newMeetingNoteBadgeAssignee`）。記録後の一覧のバッジから付けるときも同様。

- お客様によるご家族・家電・持ち込み品の入力（2026年10月〜）: 新おうちノート（/note/）のホームに「ご家族・家電・持ち込み品」欄（「入力・変更する」でシート `#famModal`、`FAM_DEFS`／`famOpen`／`famSave`）。`note-data.mts` の `profileSave`（各20行・60文字まで、名前なしの行は捨てる）が `noteExtras` の `customerProfile` に保存し、スタッフへ通知メール。住まいるアプリの「おうちノート連携」タブ（`renderOkaiProfile`）に表示される。
- スマホ幅の仕様タブ（2026年10月〜）: 文字拡大で `.speccat` の最小幅340pxが画面からはみ出していたため、幅760px以下は1列・最小幅なし。`.spectl-actions` と `.btn.small` は折り返し可。

- 家づくりの進み具合（2026年10月〜）: お客様ホームの進み具合カードに工程のステップ表示（済／いま／これから＋予定日の自由入力）を出す。スタッフは案件の「おうちノート連携」タブ「家づくりの進み具合」で、工程名・予定日（文字）・「現在」を入力し「お客様の画面に表示する」にチェックして保存（`okaiProg*`、既定の工程は `OKAI_PROG_DEFAULT`）。保存先は `noteExtras` の `houseProgress`（`{on,current,steps:[{name,date}]}`、`EXTRAS_KEYS` に追加済み）。`note-data.mts` が `houseProgress` を返し、`public/note/index.html` の `homeHtml` が描画（未設定・非表示のときは従来の「仕様のお打合せ」カードのまま）。仕様のお打合せの％はステップ表示の下に小さく残す。進み具合のステップ表示を出しているお客様は、上の帯を「家づくり進行中」だけにする（食い違い防止。案件ヘッダーのタグ `progressTag` は帯には出さず、ステップ表示を出していないお客様にだけ従来どおり出す）。

- 打合せ記録の拡張（2026年10月〜）: ①記録フォームに「打合せ内容（社内メモ・`talk`、お客様には出さない）」と「お客様へのメッセージ（`message`、反映した記録でだけお客様に出る）」を追加。②住まいるアプリの「記録」タブ上部とお客様の「打合せ記録」画面上部に、決定事項（`decided`）だけを新しい順にまとめた「決定事項のまとめ」（`renderDecidedSummary`／お客様側 `.dsum`）。③業者タスクを作った記録・仕様履歴は、そのタスクが「完了」になるまで「変更依頼中」の印をスタッフ側（`isChangeRequesting`）とお客様側に出す。判定は記録／仕様写真の `sent.vendortask.ref`（タスクID）で、`note-data.mts` の `isChangeRequesting` 相当（`isChanging`）が true/false だけをお客様に渡す（タスクの中身は渡さない）。バッジから業者タスクを作った場合も `sent` に記録するようにした。この機能より前に作った業者タスクは `sent` が無いので印は出ない。

- タスクのメモ（2026年10月〜）: タスクに社内用の自由記述メモ `memo`（1つの欄を書き換える形）を追加。入力・編集フォームの「メモ」欄で書き、カンバンのカードに「📝」つきで表示（`.kc-memo`）。社内だけの情報で、業者への依頼やお客様画面（`note-data.mts`）には出さない。

- 業者タスクの「反映」と添付（2026年10月〜）: 「✓反映済み」の業者タスク（部位あり・自分だけのタスクでない）の添付は、仕様写真へのコピーの有無に関わらず `note-data.mts` がタスクから直接お客様画面（その項目の「変更後のPDF」）に出す（コピー済みで反映済みのファイルは重複して出さない）。反映のON/OFFでタスク由来の仕様写真コピーの `reflected` も切り替える。

- タスクカードの部位表示（2026年10月〜）: カンバンのタスクカードに、選んでいる部位を色付きのラベル「📍 部位：設備仕様・キッチン」（`.kc-part`）で目立つように表示。未設定のときは点線の「📍 部位：未設定」。
- タスクの案件・進捗での絞り込みと、反映の修正（2026年10月〜）: タスク画面に「案件」プルダウン（`state.taskProjectFilter`）と「進捗」チップ（`state.taskStatusFilter`。選ぶとその進捗だけ表示して開く）を追加（`renderTaskProjectStatusBars`）。「反映する」は部位が未設定でも押せ、未設定ならその案件の部位を選ばせる（`askSpecPart(cb, projectId)`）。反映すると添付（図面）を、**タスクの案件（`t.projectId`）**の設備仕様の履歴へ入れ（`syncTaskSpecCopies`。部位変更・反映ON/OFF・添付追加でも同期）、おうちノートに出る。以前は「いま開いている案件」（`state.currentProjectId`）に入れていたため、ホームのタスク画面から反映すると別案件／無反応になっていた。

- 反映済みタスクの色と自動修復（2026年10月〜）: 反映済みのタスクカードは薄い緑の背景＋緑の左線（`.kancard.reflected`）。起動時に1回、「✓反映済み」なのに設備仕様に図面が入っていないタスクを `repairReflectedTaskCopies` が直す（コピーのIDは `sp_t_<タスクID>_<添付ID>` で固定なので、複数の端末で同時に直しても重複しない）。

- お客様画面の「打ち合わせ記録・変更後の図面」カードと、カードごとの仮決定／決定（2026年10月〜）: 設備仕様の各項目で、打合せ記録と、業者タスク由来のPDF（`source.taskId` あり。同じタスクは1枚にまとめ、同じurlは重複させない）を、1つの時系列（新しい順）のカードで出す（`public/note/index.html` の `itemsSectionsHtml`。カードの背景色は状態で分ける：検討中＝白／仮決定＝黄／決定＝緑、左に日付の縦線）。PDFカードの日付・内容はタスク側（反映日・タスク内容60文字）。**項目全体の「いまの状態」ボックスは廃止**し、カード1枚ごとに「仮決定にする／決定する／検討中に戻す」を選ぶ（`decideCard` → `note-data.mts` の POST `decideCard`。`noteDecisions` に `cardKey`（記録＝`n:<記録ID>`／PDF＝`t:<タスクID>`）・`label`・`category`（各部屋は `roomId` も）付きで保存、ID は `<案件ID>__card__<cardKey>`）。項目の見出しバッジ（各部屋は部屋ごと）は、その項目の**いちばん新しい決定**の状態にそろえる。住まいるアプリの「お客様：決定」バッジと決定状況の一覧にもそのまま出る（一覧は内容を添える）。写真・資料・プランボードのカードには仮決定／決定は付けない。

- カードの「仮決定／決定」ボタンの出す／出さない（2026年10月〜）: お客様画面のカードにボタンを出すかは、スタッフが記録・業者タスクごとに選ぶ（初めは**出さない**。出さないカードは色も付けない）。打合せ記録は「操作」メニューの「お客様の決定ボタン：出す／出さない」（`toggleMeetingAskDecision`、`meetingNotes.askDecision`）、業者タスクは反映済みカードの「決定ボタン：出す／出さない」（`toggleTaskAskDecision`、`tasks.askDecision`）。`note-data.mts` が各カードに `showDecide` を渡す（`askDecision===true`、または未設定でお客様がすでに選んでいるカード）。また記録の並び順は、書いた日が打合せ日と同じなら書いた時刻（`noteAt`）、図面は反映した時刻で、同じ日でも新しい順に並ぶ。

- 案件の進捗（契約前・着工など）の変え方（2026年10月〜）: 案件ヘッダーの進捗チップは表示だけ（タップでは変わらない。誤タップ防止）。変更は「編集」の「進捗」選択欄（`#editProjectTag`、`saveEditProject`）で行う。

- 部位の自由追加（2026年10月〜）: 打合せ記録のサブタブ（記録・外部仕様…・プランボード）の「＋追加」で、その案件だけの部位を増やせる（`project.customParts=[{id,name,memo,deletedAt}]`、`addCustomPart`／`renameCustomPart`／`deleteCustomPart`、画面は `renderCustomPartTabs`。追加した部位のタブは「＋追加」「プランボード」の前に並ぶ）。部位は `scope:"custom"`・`category=部位ID` で、打合せ記録・タスク（反映も）・仕様履歴の部位選択（`askSpecPart` の「追加した部位」）から使える。お客様のおうちノートでは1つずつ別の項目（ID `cp_<部位ID>`）として出る：`note-data.mts` の `catsOf`／`noteCatFor`／`partLabel`、住まいるアプリの `noteCatIdFor`／`noteDecisionName` の**2か所に同じ対応**がある。削除は `deletedAt` を付けるだけ（履歴は残るが、お客様画面からは消える）。

- 仕様履歴カードの「お客様の決定ボタン：出す／出さない」（2026年10月〜）: 仕様タブの履歴カード（手動追加の写真・PDF・受領PDF・プランボード。タスクから作ったコピーはタスク側のボタンで決める）に、反映ボタンの隣へ追加（`toggleSpecAskDecision`、`specPhotos.askDecision`）。「出す」にしたカードだけ、お客様画面（`public/note/index.html` の `itemsSectionsHtml`）で「写真・資料」「プランボード」欄から記録・図面と同じ時系列のカードに移り、カードごとに仮決定／決定を選べる。カードの `cardKey` は `s:<仕様写真ID>`（`note-data.mts` の `decideCard` は `n:`／`t:`／`s:` を受け付ける）。

- 「確認事項」タブの分割（2026年10月〜）: 案件の上段にあった「確認事項」（固定6項目、`scope:"siteCheck"`）は廃止し、項目ごとに分けた。**ポスト**は外部仕様のカード（`EXTERIOR_CATS`）、**ランドリーバー**は設備仕様のカード（`FACILITY_CATS`、脱衣室の隣。お客様画面は新しい項目「脱衣室」（id `dressing`、洗面の次）に出る。脱衣室・ランドリーバーは洗面から分けた：`note-data.mts` の `NOTE_CATS`／`noteCatFor` と、住まいるアプリの `noteCatIdFor`／`NOTE_CAT_NAMES` の2か所に同じ対応）。残りの**外部散水栓・インターホン親機・給湯リモコン・床下点検口**は、打合せ記録のサブタブの並びにそれぞれ別のタブ（`SITECHECK_TABS`、キー `sc_*`、`renderSpecSiteCheck` が `#siteCheckPanes` に描画）として出す（これらは `scope:"siteCheck"` のままで、お客様画面には出ない）。以前 siteCheck に入れたポスト／ランドリーバーの写真・記録・タスク・メモは、起動時に `migrateSiteCheckMoves` が新しい場所へ移す（何度動かしても同じ結果）。

- お客様画面の部位名と「その他の確認」（2026年10月〜）: 外部・脱衣室にも部位名（ポスト・ランドリーバーなど）をカードに付ける（`public/note/index.html` の `LABEL_CATS`）。外部散水栓・インターホン親機・給湯リモコン・床下点検口（`scope:"siteCheck"`）は、反映したものだけお客様画面の新しい項目「その他の確認」（id `other`）に出す（`note-data.mts` の `noteCatFor`／`NOTE_CATS`、住まいるアプリの `noteCatIdFor`／`NOTE_CAT_NAMES` の2か所に同じ対応）。

- 引っ越し状況の確認（2026年10月〜）: 旧おうちノートからの引っ越し状況を調べるだけのページ `/app/migration-check.html`（API `netlify/functions/migration-check.mts`、合言葉で認証・`STAFF_PASSPHRASE` あり）。案件ごとに旧側と新しい側（noteExtras）の件数を並べ、旧のほうが多い案件を赤で出す。何も書き換えない・旧側も消さない。

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
- 確認依頼中への改名・タスクのアーカイブ・完工保存（2026年10月〜）:
  - 進捗名「社長確認中」「朋子確認中」→「社長確認依頼中」「朋子確認依頼中」。旧名称のタスクは起動時・更新時に `migrateLegacyTaskStatus`（`LEGACY_STATUS_MAP`）が自動で新名称へ移す。サーバーの `staff-data.mts`（通知判定 `/^(.+?)確認(?:依頼)?中$/`）と `task-mail.mts` の `flushTaskQueue` は新旧どちらの名称も受け付け、旧→新の自動移行では通知メールを重ねて送らない。
  - タスクのアーカイブ: 「完了」にして3日（`ARCHIVE_AFTER_MS`）たったタスクに `autoArchiveTasks` が `archivedAt` を付け、`liveTasks()` から外れてホームのタスク画面に出なくなる（消えない）。完了にした時刻は `completedAt`（`setTaskStatus` で設定。無い古いタスクは `updatedAt` で代用）。案件の「タスク履歴」サブタブ（`renderTaskHistory`）で案件ごとに見られ、「元に戻す」（`unarchiveTask`）で完了のままホームへ戻す（また3日間残る）。
  - 完工・保存: 案件ヘッダーの「🏁 工事完了として保存」（`toggleFinishProject`）で `project.finishedAt` を付け、`liveProjects()` から外れて案件一覧の下の「完工・保存」カード（`renderFinishedProjList`）に移る。記録・仕様・写真などはそのまま閲覧・編集でき、「↩ 保存を解除する」で戻せる。未完了のタスクはホームに残る。「📦 全情報をダウンロード」（`exportProjectZip`、JSZip）は案件の記録・タスク・仕様・写真・メッセージ・予約などを `data.json`＋読み物の `読み物.html`＋ファイル本体（`files/`）のZIPにする。
- 写真・ファイルのアップロード先の案件固定（2026年10月〜）: 写真・PDF・図面などを複数枚アップロードしている途中で別の案件を開くと、残りが「いま開いている案件」に保存される不具合があった（他のお客様の写真がおうちノートに出た）。`uploadSpecPhotos`／`uploadSpecPlanboardRaw`／`uploadAlbumPhotos`／`uploadImageBoard`／`uploadSitePhotos`／`uploadAttachments`／`attachBlobsToMeetingNote`／`pbSaveToProject`（`pb.pid`）は、開始時に `pid0 = state.currentProjectId` を控え、保存時はそれを使う。新しいアップロード処理を足すときも、`await` のあとで `state.currentProjectId` を読まないこと。
- 記録の「連絡方法」と打合せ内容の表示（2026年10月〜）: 打合せ記録フォームに「連絡方法」（打合せ／LINE／電話／メール、`meetingNotes.channel`）を追加。「打合せ」以外はカードに印（LINEは緑）が付き、お客様画面にも連絡方法のタグが出る。「打合せ内容」（`talk`）は、フォームの「お客様にも見せる」（`talkPublic`、新規は初期ON）を入れた記録だけ、反映するとお客様画面（「打合せの内容」）に出る。**これまでの記録は `talkPublic` が無いので社内メモのまま非公開**（過去に社内向けに書いた内容が急に見えないようにするため。編集でチェックを入れた記録だけ公開）。`note-data.mts` が `talk`（公開のときだけ）と `channel` をお客様に渡す。
