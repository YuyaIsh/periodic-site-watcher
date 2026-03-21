/**
 * siteIdに応じたアダプタ関数を呼び出すディスパッチャ
 *
 * 各サイト用スクリプト（sites/*.js）が collect_<siteId> をグローバルに定義する。
 * 動的に解決して呼び出すため、新規サイト追加時は content-script.js の変更不要。
 *
 * 返却するpayloadは設計書の「最小契約」に従う:
 * - siteId: サイト識別子
 * - url: 現在のページURL
 * - capturedAt: 取得時刻（epoch ms）
 * - payload: サイト別の抽出データ（任意形式）
 *
 * @param {string} siteId - サイト識別子
 * @returns {Promise<Object>} 最小契約に準拠したpayload
 * @throws {Error} 未対応のsiteIdの場合
 */
async function collectOnPage(siteId) {
  const fnName = 'collect_' + siteId;
  const fn = typeof window[fnName] === 'function' ? window[fnName] : null;
  if (!fn) {
    throw new Error(`Unsupported siteId: ${siteId} (${fnName} not found)`);
  }
  const result = await Promise.resolve(fn());
  return {
    siteId,
    url: window.location.href,
    capturedAt: Date.now(),
    payload: result !== undefined ? result : {}
  };
}

// Service Workerからのメッセージを受信して抽出処理を実行
// return trueで非同期応答を保持（sendResponseが非同期で呼ばれる場合に必要）
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'COLLECT') {
    // mockMode をグローバル変数に一時格納（collect 関数が参照できるように）
    if (message.mockMode !== undefined) {
      window.__COLLECT_MOCK_MODE__ = message.mockMode;
    }
    if (message.localMode !== undefined) {
      window.__COLLECT_LOCAL_MODE__ = message.localMode;
    }
    (async () => {
      try {
        const result = await collectOnPage(message.siteId);
        sendResponse({ type: 'COLLECT_RESULT', payload: result });
      } catch (error) {
        sendResponse({ type: 'COLLECT_RESULT', error: error.message });
      } finally {
        // クリーンアップ
        delete window.__COLLECT_MOCK_MODE__;
        delete window.__COLLECT_LOCAL_MODE__;
      }
    })();
    return true;
  }
});
