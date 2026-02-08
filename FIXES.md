# 修正内容まとめ

## 実施した修正（レビュー指摘事項への対応）

### 🔴 緊急修正（完了）

#### 1. `options.js:207` - constの再代入エラー
**問題**: `const`で宣言された変数を再代入しようとしていた
**修正**: `let`に変更
```javascript
// 修正前
const { state } = await chrome.storage.local.get('state');
state = { bySite: {} }; // ❌ エラー

// 修正後
let { state } = await chrome.storage.local.get('state');
state = { bySite: {} }; // ✅ OK
```

#### 2. `options.js:44, 47` - XSS脆弱性
**問題**: `siteId`がエスケープされていなかった
**修正**: `escapeHtml()`でエスケープ処理を追加
```javascript
// 修正前
<h2>${siteId}</h2>
<button onclick="deleteSite('${siteId}')">削除</button>

// 修正後
<h2>${escapeHtml(siteId)}</h2>
<button onclick="deleteSite('${escapeHtml(siteId).replace(/'/g, "\\'")}')">削除</button>
```

#### 3. `service-worker.js:98-122` - タブの状態チェック競合
**問題**: `tabs.onUpdated`と`tabs.get`の両方が`resolve`を呼ぶ可能性があった
**修正**: フラグ管理を追加して重複解決を防止
```javascript
// 修正後
let resolved = false; // フラグで重複解決を防止
const listener = (updatedTabId, changeInfo) => {
  if (updatedTabId === tabId && changeInfo.status === 'complete' && !resolved) {
    resolved = true;
    // ...
  }
};
```

### ⚠️ 高優先度修正（完了）

#### 4. API URLのバリデーション（SSRF対策）
**問題**: 任意のURLが設定可能でSSRFリスクがあった
**修正**: URL形式の検証を追加
```javascript
function isValidApiUrl(url) {
  if (!url || !url.trim()) {
    return false;
  }
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
```

#### 5. スケジュール時刻のバリデーション
**問題**: 無効な時刻形式（例: "25:00", "12:60"）が設定される可能性があった
**修正**: `isValidTimeFormat()`関数を追加して検証
```javascript
function isValidTimeFormat(time) {
  if (!time || typeof time !== 'string') {
    return false;
  }
  const match = time.match(/^(\d{2}):(\d{2})$/);
  if (!match) {
    return false;
  }
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  return hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60;
}
```

#### 6. 数値バリデーション
**問題**: `parseInt`の結果が`NaN`の場合や範囲外の値のチェックがなかった
**修正**: 数値検証を追加
```javascript
// タイムアウトのバリデーション
const timeoutSec = parseInt(timeoutSecValue, 10);
if (isNaN(timeoutSec) || timeoutSec < 1 || timeoutSec > 300) {
  alert(`サイト "${siteId}" のタイムアウトは1-300秒の範囲で入力してください。`);
  return;
}
```

#### 7. Content Script注入タイミングの改善
**問題**: `setTimeout(100)`で待機するのは不確実
**修正**: 再試行ロジックを追加
```javascript
let retries = 0;
const maxRetries = 5;
const trySendMessage = () => {
  chrome.tabs.sendMessage(tabId, { type: 'COLLECT', siteId })
    .catch((err) => {
      if (retries < maxRetries && !resolved) {
        retries++;
        setTimeout(trySendMessage, 50);
      } else {
        // エラー処理
      }
    });
};
```

#### 8. エラーメッセージのサニタイズ
**問題**: エラーメッセージに機密情報が含まれる可能性があった
**修正**: 機密情報を除去する処理を追加
```javascript
// エラーメッセージをサニタイズ（機密情報の漏洩防止）
let errorMessage = error.message || String(error);
errorMessage = errorMessage.replace(/password|token|secret|key|api[_-]?key/gi, '[REDACTED]');
errorMessage = errorMessage.substring(0, 100);
```

#### 9. サイトが見つからない場合のエラーハンドリング
**問題**: `site`が存在しない場合に`return`だけで終了していた
**修正**: エラーとして扱い、stateを更新
```javascript
if (!site) {
  console.error(`Site ${siteId} not found in settings`);
  // エラーとして扱い、stateを更新
  const now = Date.now();
  // ... state更新処理
  return;
}
```

#### 10. URLバリデーションの追加
**問題**: 無効なURLが設定される可能性があった
**修正**: URL形式の検証を追加
```javascript
// URLのバリデーション
if (!url) {
  alert(`サイト "${siteId}" のURLが入力されていません。`);
  return;
}
try {
  new URL(url);
} catch {
  alert(`サイト "${siteId}" のURL形式が正しくありません。`);
  return;
}
```

## 修正ファイル一覧

1. `options.js` - XSS対策、バリデーション追加、const再代入エラー修正
2. `service-worker.js` - タブ状態チェック改善、API URL検証、エラーメッセージサニタイズ、Content Script注入改善

## テスト推奨項目

1. ✅ XSS対策: 悪意のある`siteId`（例: `<script>alert('XSS')</script>`）を入力してエスケープされることを確認
2. ✅ API URLバリデーション: 無効なURLを入力してエラーが表示されることを確認
3. ✅ 時刻バリデーション: 無効な時刻（例: "25:00", "12:60"）を入力してエラーが表示されることを確認
4. ✅ 数値バリデーション: 無効な数値（例: 負の値、範囲外）を入力してエラーが表示されることを確認
5. ✅ タブの状態チェック: 複数のサイトを連続実行して競合が発生しないことを確認

## 残りの改善提案（将来対応）

- コード重複の解消（`computeNextRunAfterSuccess`の共通化）
- Service Workerのライフサイクル対応
- ストレージクォータ管理
- ログ出力の整理（本番環境対応）

