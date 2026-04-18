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

## 開発

```bash
npm install
npm run test
npm run typecheck
```

## ロールアウト

インストール先カタログ・更新手順は [../../docs/widget-installations.md](../../docs/widget-installations.md) を参照。
