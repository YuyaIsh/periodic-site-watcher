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
 * - collectLogs: 収集中にページ console に出した行のコピー（タブ閉鎖後も SW で参照するため）
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

  /** @type {Array<{ level: string, text: string, at: number }>} */
  const collectLogs = [];
  const push = (level, args) => {
    const text = args
      .map((a) => {
        try {
          if (typeof a === 'object' && a !== null) return JSON.stringify(a);
          return String(a);
        } catch {
          return '[unserializable]';
        }
      })
      .join(' ');
    collectLogs.push({ level, text, at: Date.now() });
  };
  const methods = ['log', 'warn', 'error', 'info', 'debug'];
  const origConsole = window.console;
  const proxy = new Proxy(origConsole, {
    get(target, prop, receiver) {
      const name = String(prop);
      if (
        methods.includes(name) &&
        typeof Reflect.get(target, prop, receiver) === 'function'
      ) {
        const origMethod = Reflect.get(target, prop, receiver);
        return function (...args) {
          push(name, args);
          return origMethod.apply(target, args);
        };
      }
      return Reflect.get(target, prop, receiver);
    }
  });
  window.console = proxy;
  let result;
  try {
    result = await Promise.resolve(fn());
  } finally {
    window.console = origConsole;
  }

  return {
    siteId,
    url: window.location.href,
    capturedAt: Date.now(),
    payload: result !== undefined ? result : {},
    collectLogs
  };
}

// Service Workerからのメッセージを受信して抽出処理を実行
// return trueで非同期応答を保持（sendResponseが非同期で呼ばれる場合に必要）
// 同一ドキュメントへ executeScript を重ねたときだけ二重登録を防ぐ（遷移後は window が新しくなる）
if (!window.__PERIODIC_SITE_WATCHER_COLLECT_LISTENER__) {
  window.__PERIODIC_SITE_WATCHER_COLLECT_LISTENER__ = true;
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
}
