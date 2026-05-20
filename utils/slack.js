/**
 * Slack 通知ユーティリティ
 *
 * 失敗時・記録0件の注意喚起時に Webhook へ送る。
 * 成功時の heartbeat は settings.slackSuccessWebhookUrl（オプション画面で設定）。
 */

async function postSlackWebhook(webhookUrl, text) {
  const response = await fetch(webhookUrl.trim(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
  if (!response.ok) {
    console.error('Slack通知の送信に失敗しました:', response.status, response.statusText);
  }
  return response.ok;
}

/**
 * 失敗時に Slack へ通知を送信する
 *
 * @param {string} webhookUrl - Slack Incoming Webhook URL
 * @param {Object} options - 通知オプション
 * @param {string} options.siteId - サイトID
 * @param {Error|string} options.error - エラーオブジェクトまたはエラーメッセージ
 * @param {number} options.failCount - 失敗回数
 * @returns {Promise<void>}
 */
async function notifySlackOnFailure(webhookUrl, { siteId, error, failCount }) {
  if (!webhookUrl || !webhookUrl.trim()) {
    return;
  }

  const errorMessage = error instanceof Error ? error.message : String(error);
  const timestamp = new Date().toLocaleString('ja-JP');

  const text =
    `❌ サイト巡回エラー\n` +
    `サイト: ${siteId}\n` +
    `エラー: ${errorMessage}\n` +
    `失敗回数: ${failCount}\n` +
    `時刻: ${timestamp}`;

  try {
    await postSlackWebhook(webhookUrl, text);
  } catch (err) {
    console.error('Slack通知の送信でエラーが発生しました:', err);
  }
}

/**
 * ペイロード上の記録件数が 0 のとき（成功完了だが中身が空）に Webhook へ送る
 *
 * @param {string} webhookUrl - Slack Incoming Webhook URL
 * @param {Object} options - 通知オプション
 * @param {string} options.siteId - サイトID
 * @returns {Promise<void>}
 */
async function notifySlackOnZeroItems(webhookUrl, { siteId }) {
  if (!webhookUrl || !webhookUrl.trim()) {
    return;
  }

  const timestamp = new Date().toLocaleString('ja-JP');
  const text =
    `⚠️ サイト巡回: 記録件数が0件です\n` + `サイト: ${siteId}\n` + `時刻: ${timestamp}`;

  try {
    await postSlackWebhook(webhookUrl, text);
  } catch (err) {
    console.error('Slack通知の送信でエラーが発生しました:', err);
  }
}

/**
 * Slack 通知用にテキストを正規化して切り詰める
 *
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
function truncateForSlack(text, maxLen = 140) {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '(本文なし)';
  if (normalized.length <= maxLen) return normalized;
  return normalized.slice(0, maxLen - 1) + '…';
}

/**
 * 成功完了時に Slack へ heartbeat を送る（全サイト共通）
 * 本文は「巡回が問題なく終わったこと」のみ。件数はペイロードから算出できたときだけ補足行として付与する。
 *
 * @param {string} webhookUrl - Slack Incoming Webhook URL
 * @param {Object} options
 * @param {string} options.siteId - サイトID
 * @param {number|undefined|null} options.recordCount - 補足用の件数（算出できなければ null / undefined）
 * @param {string} options.runLabel - 実行コンテキスト（例: スケジュール/通常）
 * @returns {Promise<void>}
 */
async function notifySlackOnSuccess(webhookUrl, { siteId, recordCount, runLabel }) {
  if (!webhookUrl || !webhookUrl.trim()) {
    return;
  }

  const timestamp = new Date().toLocaleString('ja-JP');
  const lines = [`✅ サイト巡回 OK（稼働確認）`, `サイト: ${siteId}`];
  if (typeof recordCount === 'number') {
    lines.push(`件数: ${recordCount}`);
  }
  lines.push(`実行: ${runLabel}`, `時刻: ${timestamp}`);
  const text = lines.join('\n');

  try {
    await postSlackWebhook(webhookUrl, text);
  } catch (err) {
    console.error('Slack成功通知の送信でエラーが発生しました:', err);
  }
}

/**
 * x-bookmarks パイプライン完了時に Slack へ処理結果を送る（サイト専用 Webhook）
 *
 * @param {string} webhookUrl - サイトオプションの slackWebhookUrl
 * @param {Object} options
 * @param {Array<{ tweetId?: string, text?: string, url?: string, author?: { displayName?: string, screenName?: string }, conversationUrl?: string|null, title?: string|null }>} options.posts
 * @param {boolean} [options.mockMode]
 * @returns {Promise<void>}
 */
async function notifySlackOnXBookmarksProcessed(webhookUrl, { posts, mockMode }) {
  if (!webhookUrl || !webhookUrl.trim()) {
    return;
  }
  if (!Array.isArray(posts) || posts.length === 0) {
    return;
  }

  const timestamp = new Date().toLocaleString('ja-JP');
  const modeSuffix = mockMode ? '（モック）' : '';
  const lines = [`📌 Xブックマーク処理完了${modeSuffix}`, `件数: ${posts.length}`, `時刻: ${timestamp}`, ''];

  posts.forEach((item, i) => {
    const sn = item.author?.screenName ? `@${item.author.screenName}` : '';
    const headline =
      (item.title && String(item.title).trim()) ||
      truncateForSlack(item.text, 72);
    const header = [sn, headline].filter(Boolean).join(' | ') || `Tweet ${item.tweetId || i + 1}`;
    lines.push(`[${i + 1}] ${header}`);
    lines.push(`タイトル: ${(item.title && String(item.title).trim()) || '（未取得）'}`);
    lines.push(`本文: ${truncateForSlack(item.text)}`);
    if (item.url) {
      lines.push(`X: ${item.url}`);
    }
    if (item.conversationUrl) {
      lines.push(`ChatGPT: ${item.conversationUrl}`);
    } else {
      lines.push('ChatGPT: （未取得）');
    }
    lines.push('');
  });

  const text = lines.join('\n').replace(/\n+$/, '');

  try {
    await postSlackWebhook(webhookUrl, text);
  } catch (err) {
    console.error('Slack x-bookmarks 通知の送信でエラーが発生しました:', err);
  }
}
