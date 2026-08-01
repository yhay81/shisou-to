# Metrics

`product_events` の許可済みイベントを、匿名セッションと日付で集計します。

- `visited`: 製品を開いた
- `campaign_created`: 募集を作成した
- `tester_joined`: 募集に参加した
- `optin_confirmed`: Google側での参加を自己申告した
- `day_checked`: 当日の試走結果を記録した
- `feedback_sent`: 気づきを送った
- `roster_exported`: 開発者が進行表を保存した
- `public_campaign_viewed`: 公開募集を開いた
- `official_link_opened`: Google の公式リンクを開いた
- `returned`: 別日に再訪した

`x-shisou-qa: 1` のイベントは保存時に `is_qa = 1` とし、実利用集計から除外します。募集、参加者、日々の記録、フィードバックは作成45日後、匿名利用イベントも45日後に定期削除します。
