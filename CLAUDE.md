# react-native-feedback-widget

React Native 用フィードバックウィジェット。GitHub リポジトリ経由で各アプリに取り込まれる。

リポジトリ: <https://github.com/Polyrhythm-Inc/react-native-feedback-widget>

## インストール先カタログ

ウィジェット側を変更した場合のロールアウト手順・反映先は以下を参照:

**[https://github.com/Polyrhythm-Inc/test-suite-docs/blob/main/docs/widget-installations.md](https://github.com/Polyrhythm-Inc/test-suite-docs/blob/main/docs/widget-installations.md)**

## 技術スタック

- TypeScript（`strict: true`）/ React Native 0.81 / React 19
- テスト: Jest（preset `jest-expo`）
- リンター: ESLint 9（flat config、`eslint-config-expo`）

## ディレクトリ構成

```
src/
├── components/   # FeedbackWidget / SimpleFeedbackPanel / AnnotationEditor
├── services/     # feedback（API 送信）
├── utils/        # feedbackWidgetMode / tapSwitchGesture
└── index.ts      # エントリーポイント
__tests__/        # services / utils のテスト
```

## 開発

- `npm test` → Jest (`__tests__/` 配下: `services/feedback.test.ts`, `utils/feedbackWidgetMode.test.ts`, `utils/tapSwitchGesture.test.ts`)
- `npm run typecheck` → tsc --noEmit
- `npm run lint` → ESLint (`eslint.config.js`)

## コーディング規約

- TypeScript は厳密な型定義とし、`any` の使用を避ける
- `.editorconfig` に従う（インデントはスペース2文字、改行 LF、UTF-8、末尾空白削除、Markdown を除く）
- ESLint（`eslint-config-expo`）を使用し、フォーマッター（Prettier / Biome 等）は使用しない
- pre-commit（`.pre-commit-config.yaml`）で gitleaks・typecheck・eslint を実行する

## デプロイ（GitHub 経由）

1. 本ディレクトリで変更を commit
2. `git push origin main`
3. 各アプリで `npm update @polyrhythm-inc/react-native-feedback-widget`（または `package-lock.json` の該当 commit を更新して `npm install`）

インストール先アプリ一覧は [widget-installations.md](https://github.com/Polyrhythm-Inc/test-suite-docs/blob/main/docs/widget-installations.md#react-native-widget) 参照。
