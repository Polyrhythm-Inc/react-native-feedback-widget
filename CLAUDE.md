# react-native-feedback-widget

React Native 用フィードバックウィジェット。GitHub リポジトリ経由で各アプリに取り込まれる。

リポジトリ: <https://github.com/Polyrhythm-Inc/react-native-feedback-widget>

## インストール先カタログ

ウィジェット側を変更した場合のロールアウト手順・反映先は以下を参照:

**[../../docs/widget-installations.md](../../docs/widget-installations.md)**

## 開発

- `npm test` → Jest (`__tests__/services/feedback.test.ts`)
- `npm run typecheck` → tsc --noEmit

## デプロイ（GitHub 経由）

1. 本ディレクトリで変更を commit
2. `git push origin main`
3. 各アプリで `npm update @polyrhythm-inc/react-native-feedback-widget`（または `package-lock.json` の該当 commit を更新して `npm install`）

インストール先アプリ一覧は [widget-installations.md](../../docs/widget-installations.md#react-native-widget) 参照。
