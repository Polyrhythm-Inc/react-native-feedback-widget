# @polyrhythm-inc/react-native-feedback-widget

React Native 向けフィードバックウィジェット。スクリーンショット取得、注釈エディタ、API 送信を提供。Web 版 `feedback-widget` / Flutter 版 `flutter-feedback-widget` の RN ポート。

## インストール

```bash
npm install github:Polyrhythm-Inc/react-native-feedback-widget
```

以下の peerDependencies が必要:

- `react` / `react-native`
- `react-native-view-shot`
- `react-native-svg`
- `react-native-safe-area-context`
- `@react-native-async-storage/async-storage`
- `expo-constants`

## 使い方

```tsx
import { FeedbackWidget } from '@polyrhythm-inc/react-native-feedback-widget';

export default function App() {
  return (
    <FeedbackWidget
      apiUrl="https://feedback-suite.polyrhythm.tokyo"
      authUrl="https://auth.feedback-suite.polyrhythm.tokyo"
      projectId="my-app"
      widgetProjectId="react-native-feedback-widget"
      appTitle="My App"
    >
      {/* your app */}
    </FeedbackWidget>
  );
}
```

## Props

| prop | 型 | 必須 | 説明 |
|---|---|---|---|
| `apiUrl` | string | ✅ | フィードバック送信先 API ベース URL |
| `projectId` | string | ✅ | 送信先プロジェクト ID |
| `widgetProjectId` | string | | 指定するとウィジェット自体への報告モードトグルが表示される |
| `authUrl` | string | | 認証サーバー URL。指定時はログイン必須 |
| `appTitle` | string | | スクリーンショット送信時の pageInfo.title（デフォルト: `"App"`） |
| `mode` | `'simple' \| 'full'` | | `'simple'` で軽量な good/bad 評価パネルに切り替え。省略時は `'full'`（従来の挙動と完全互換） |
| `enableScreenshot` | boolean | | `false` にすると FAB タップ時の自動スクリーンショット撮影・注釈・プレビュー表示をスキップし、コメントのみでフィードバックを送信できる（デフォルト `true`、従来通りの自動スクショ挙動） |

## 簡易モード（`mode="simple"`）

スクリーンショット撮影・注釈・ログインを伴わない軽量な good/bad 評価パネル。FAB タップでパネル表示 → 評価選択 + 任意の理由入力 → 送信。Web 版 `feedback-widget` の `data-mode="simple"` に相当。

```tsx
import { FeedbackWidget } from '@polyrhythm-inc/react-native-feedback-widget';

export default function App() {
  return (
    <FeedbackWidget
      apiUrl="https://feedback-suite.polyrhythm.tokyo"
      projectId="my-app"
      mode="simple"
    >
      {/* your app */}
    </FeedbackWidget>
  );
}
```

パネルのヘッダータイトル（"Feedback"）を 2 秒以内の間隔で 5 回タップすると、フル機能ウィジェットに切り替わる（切替状態は JS のメモリ上でのみ保持され、アプリ再起動でリセットされる）。

送信先は `POST {apiUrl}/api/events`（認証ヘッダなし）。ペイロードは以下の形（`reason` は入力があるときのみ、trim 後空なら省略）:

```json
{ "projectId": "my-app", "eventType": "rating", "rating": "good", "reason": "とても使いやすい" }
```

## 汎用イベント送信（`FeedbackService.trackEvent`）

good/bad 評価に限らない任意のプロダクト分析イベントを送信するための API。Web 版の `window.FeedbackSuite.trackEvent` に相当。

```tsx
import { FeedbackService } from '@polyrhythm-inc/react-native-feedback-widget';

await FeedbackService.trackEvent({
  eventType: 'button_click',
  targetType: 'button',
  targetId: 'checkout-cta',
  fields: { screen: 'Cart' },
});
```

`projectId` を省略すると `FeedbackWidget` / `FeedbackService.configure()` で設定済みの projectId が使われる。戻り値は `Promise<{ success: boolean; id: string }>`。非 2xx レスポンスは例外を throw する。

## 開発

```bash
npm install
npm run test
npm run typecheck
```

## ロールアウト

インストール先カタログ・更新手順は [../../docs/widget-installations.md](../../docs/widget-installations.md) を参照。
