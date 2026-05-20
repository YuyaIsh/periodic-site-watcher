/**
 * x-bookmarks サイトのオプションスキーマ定義
 *
 * オプション画面で動的読み込みされ、サイト固有の設定項目を追加する。
 * ChatGPT Project URL はコード内で固定。Slack は処理結果（本文・ChatGPT リンク）専用。
 */
(function (g) {
  g.__SITE_OPTIONS__ = g.__SITE_OPTIONS__ || {};
  g.__SITE_OPTIONS__['x-bookmarks'] = [
    { key: 'maxPostsPerRun', label: '1回の処理件数（空欄で3）', type: 'number', min: 1, max: 10 },
    { key: 'slackWebhookUrl', label: 'Slack Webhook URL（処理結果通知）', type: 'url' },
    { key: 'promptPrefix', label: 'Prompt Prefix（空なら既定の解説依頼）', type: 'text' }
  ];
})(typeof window !== 'undefined' ? window : self);
