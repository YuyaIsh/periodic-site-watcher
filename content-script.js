/**
 * siteIdに応じたアダプタ関数を呼び出すディスパッチャ
 *
 * 各サイト用スクリプト（sites/*.js）が collect_<siteId> をグローバルに定義する。
 * siteId にハイフンがあっても、関数名はアンダースコアに読み替える（例: x-bookmarks → collect_x_bookmarks）。
 *
 * 返却するpayloadは設計書の「最小契約」に従う:
 * - siteId: サイト識別子
 * - url: 現在のページURL
 * - capturedAt: 取得時刻（epoch ms）
 * - payload: サイト別の抽出データ（任意形式）
 *
 * @param {string} siteId - サイト識別子
 * @param {Object} [collectContext] - Service Worker から渡す実行時コンテキスト
 * @returns {Promise<Object>} 最小契約に準拠したpayload
 * @throws {Error} 未対応のsiteIdの場合
 */
async function collectOnPage(siteId, collectContext) {
  const fnName = 'collect_' + siteId.replace(/-/g, '_');
  const fn = typeof window[fnName] === 'function' ? window[fnName] : null;
  if (!fn) {
    throw new Error(`Unsupported siteId: ${siteId} (${fnName} not found)`);
  }
  const ctx =
    collectContext !== undefined && collectContext !== null && typeof collectContext === 'object'
      ? collectContext
      : {};
  const result = await Promise.resolve(fn(ctx));
  return {
    siteId,
    url: window.location.href,
    capturedAt: Date.now(),
    payload: result !== undefined ? result : {}
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'COLLECT') {
    if (message.mockMode !== undefined) {
      window.__COLLECT_MOCK_MODE__ = message.mockMode;
    }
    (async () => {
      try {
        const result = await collectOnPage(message.siteId, message.collectContext);
        sendResponse({ type: 'COLLECT_RESULT', payload: result });
      } catch (error) {
        sendResponse({ type: 'COLLECT_RESULT', error: error.message });
      } finally {
        delete window.__COLLECT_MOCK_MODE__;
      }
    })();
    return true;
  }
});
