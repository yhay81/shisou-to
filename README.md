# 試走灯

Google Play のクローズドテストについて、参加者の集合、各参加者の14日間の自己申告、気づきの回収を一枚の進行盤にまとめる道具です。

- 開発者は Google グループと Google Play の公式テストURLだけを登録します。
- テスターはメールアドレスを渡さず、表示名、端末種別、Android バージョンだけで参加できます。
- 各テスターのオプトイン日を起点に、1日1回、最大14日分の利用状況を記録します。
- 開発者は参加数、進行状況、フィードバックを確認し、CSV / JSON で保存できます。
- 権限は URL の `#` 以降に置く期限付きの鍵で渡し、サーバーにはハッシュだけを保存します。
- Cloudflare Workers、Hono JSX、Vite+、D1 で動作します。

Google Play Console の設定、テスターのGoogleアカウント、審査結果は扱いません。試走灯の記録は、Google Play の要件充足や製品版公開を保証するものではありません。

## 開発

```powershell
npm install
npm run check
npm test
npm run build
```

データ境界は `PRIVACY.md`、安全上の連絡先は `SECURITY.md` を参照してください。
