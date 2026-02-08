/**
 * バリデーションユーティリティ
 * 
 * options.js と service-worker.js の両方で使用される
 * バリデーション関数を共通化する。
 */

/**
 * API URLのバリデーション
 * 
 * SSRF（Server-Side Request Forgery）対策として、
 * プロトコルをhttp/httpsに制限する。
 * file://、ftp://等の内部ネットワークへのアクセスを防止する。
 * 
 * @param {string} url - 検証対象のURL
 * @returns {boolean} 有効なURLの場合true
 */
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

/**
 * 時刻形式のバリデーション（HH:MM）
 * 
 * 正規表現で形式をチェックし、さらに数値範囲（0-23時、0-59分）を検証する。
 * 文字列の形式チェックだけでは"25:00"や"12:60"が通ってしまうため、
 * 数値範囲の検証も必須。
 * 
 * @param {string} time - 検証対象の時刻文字列
 * @returns {boolean} 有効な時刻形式の場合true
 */
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

