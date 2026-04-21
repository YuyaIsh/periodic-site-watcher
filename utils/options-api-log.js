/**
 * オプション画面用: Service Worker が外部 API へ送る POST ボディの記録（楽天・マネフォ等）
 * importScripts 前提のグローバル関数。
 */

const OPTIONS_API_LOG_STORAGE_KEY = 'optionsApiRequestLog';
const OPTIONS_API_LOG_MAX_ENTRIES = 50;
const OPTIONS_API_LOG_MAX_JSON_CHARS = 100000;

/**
 * @param {unknown} body
 * @param {string} siteId
 * @returns {unknown}
 */
function summarizeBodyForOptionsLog(body, siteId) {
  try {
    const s = JSON.stringify(body);
    if (s.length <= OPTIONS_API_LOG_MAX_JSON_CHARS) {
      return body;
    }
    if (
      siteId === 'rakuten-card' &&
      body &&
      typeof body === 'object' &&
      Array.isArray(/** @type {{ items?: unknown[] }} */ (body).items)
    ) {
      const b = /** @type {{ items: unknown[] }} */ (body);
      return {
        _truncated: true,
        itemCount: b.items.length,
        itemsPreview: b.items.slice(0, 25)
      };
    }
    if (
      siteId === 'moneyforward' &&
      body &&
      typeof body === 'object' &&
      Array.isArray(/** @type {{ items?: unknown[] }} */ (body).items)
    ) {
      const b = /** @type {{ instrument?: unknown; items: unknown[] }} */ (body);
      return {
        _truncated: true,
        instrument: b.instrument,
        itemCount: b.items.length,
        itemsPreview: b.items.slice(0, 20)
      };
    }
    return { _truncated: true, jsonPreview: s.slice(0, 8000) + '…' };
  } catch (e) {
    return { _error: String(e) };
  }
}

/**
 * @param {{ siteId: string, url: string, mockMode: boolean, localMode: boolean, body: unknown }} params
 * @returns {Promise<void>}
 */
async function appendOptionsApiRequestLog(params) {
  const { siteId, url, mockMode, localMode, body } = params;
  const entry = {
    at: Date.now(),
    siteId,
    mockMode,
    localMode,
    method: 'POST',
    url,
    body: summarizeBodyForOptionsLog(body, siteId)
  };

  const got = await chrome.storage.local.get(OPTIONS_API_LOG_STORAGE_KEY);
  const arr = Array.isArray(got[OPTIONS_API_LOG_STORAGE_KEY])
    ? got[OPTIONS_API_LOG_STORAGE_KEY]
    : [];
  arr.push(entry);
  while (arr.length > OPTIONS_API_LOG_MAX_ENTRIES) {
    arr.shift();
  }
  await chrome.storage.local.set({ [OPTIONS_API_LOG_STORAGE_KEY]: arr });
}
