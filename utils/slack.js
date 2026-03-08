/**
 * Slack 通知ユーティリティ
 *
 * 失敗時に Slack Incoming Webhook へ通知を送信する。
 */

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
    return; // Webhook URL が設定されていない場合は何もしない
  }

  const errorMessage = error instanceof Error ? error.message : String(error);
  const timestamp = new Date().toLocaleString('ja-JP');
  
  const text = `❌ サイト巡回エラー\n` +
    `サイト: ${siteId}\n` +
    `エラー: ${errorMessage}\n` +
    `失敗回数: ${failCount}\n` +
    `時刻: ${timestamp}`;

  try {
    const response = await fetch(webhookUrl.trim(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      console.error('Slack通知の送信に失敗しました:', response.status, response.statusText);
    }
  } catch (err) {
    console.error('Slack通知の送信でエラーが発生しました:', err);
  }
}
