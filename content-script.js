/**
 * サイト別データ抽出アダプタ関数
 * 
 * 各サイトのDOM構造に応じた抽出ロジックを実装する。
 * 現時点では分岐枠のみ実装されており、実際の抽出処理は後で埋める。
 * 
 * @returns {Object} 抽出したデータ（サイト別の形式）
 */
function collect_moneyforward() {
  // TODO: 実装は後で埋める
  return {};
}

/**
 * サイト別データ抽出アダプタ関数
 * 
 * @returns {Object} 抽出したデータ（サイト別の形式）
 */
function collect_x_bookmarks() {
  // TODO: 実装は後で埋める
  return {};
}

/**
 * siteIdに応じたアダプタ関数を呼び出すディスパッチャ
 * 
 * 設計書の「分岐だけ実装」方針に従い、switch文で分岐する。
 * 未対応のsiteIdの場合は明確にエラーを投げる（デフォルトケースで処理しない）。
 * 
 * 返却するpayloadは設計書の「最小契約」に従う:
 * - siteId: サイト識別子
 * - url: 現在のページURL
 * - capturedAt: 取得時刻（epoch ms）
 * - payload: サイト別の抽出データ（任意形式）
 * 
 * @param {string} siteId - サイト識別子
 * @returns {Object} 最小契約に準拠したpayload
 * @throws {Error} 未対応のsiteIdの場合
 */
function collectOnPage(siteId) {
  let payload = {};
  
  switch (siteId) {
    case 'moneyforward':
      payload = collect_moneyforward();
      break;
    case 'x_bookmarks':
      payload = collect_x_bookmarks();
      break;
    default:
      throw new Error(`Unsupported siteId: ${siteId}`);
  }
  
  return {
    siteId: siteId,
    url: window.location.href,
    capturedAt: Date.now(),
    payload: payload
  };
}

// Service Workerからのメッセージを受信して抽出処理を実行
// return trueで非同期応答を保持（sendResponseが非同期で呼ばれる場合に必要）
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'COLLECT') {
    try {
      const result = collectOnPage(message.siteId);
      sendResponse({ type: 'COLLECT_RESULT', payload: result });
    } catch (error) {
      sendResponse({ type: 'COLLECT_RESULT', error: error.message });
    }
    return true;
  }
});

