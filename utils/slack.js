/**
 * Slack 通知ユーティリティ
 *
 * 失敗時・成功時（x-bookmarks）に Slack Incoming Webhook へ通知を送信する。
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
 * x-bookmarks パイプライン成功時に Slack へ通知する
 *
 * @param {string} webhookUrl
 * @param {Object} options
 * @param {string} options.siteId
 * @param {number} options.okCount
 * @param {number} options.totalCount
 * @param {Array<{tweetId: string, title?: string, conversationUrl?: string}>} options.conversations
 * @param {string} [options.partialErrors]
 */
async function notifySlackOnSuccess(webhookUrl, { siteId, okCount, totalCount, conversations, partialErrors }) {
  if (!webhookUrl || !webhookUrl.trim()) return;

  const timestamp = new Date().toLocaleString('ja-JP');
  const lines = (conversations || [])
    .filter((c) => c.conversationUrl)
    .map((c, i) => `${i + 1}. ${c.title || c.tweetId}\n   ${c.conversationUrl}`);
  let text =
    `✅ x-bookmarks 巡回成功\n` +
    `サイト: ${siteId}\n` +
    `処理: ${okCount}/${totalCount} 件\n` +
    `時刻: ${timestamp}`;
  if (lines.length) text += `\n\n会話:\n${lines.join('\n')}`;
  if (partialErrors) text += `\n\n⚠️ 一部失敗:\n${partialErrors}`;

  try {
    await postSlackWebhook(webhookUrl, text);
  } catch (err) {
    console.error('Slack通知の送信でエラーが発生しました:', err);
  }
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
