/**
 * x-bookmarks サイトのオプションスキーマ定義
 *
 * Slack Webhook は Doppler（X_BOOKMARKS_SLACK_WEBHOOK_URL）で管理します。
 */
(function (g) {
  g.__SITE_OPTIONS__ = g.__SITE_OPTIONS__ || {};
  g.__SITE_OPTIONS__['x-bookmarks'] = [
    { key: 'maxPostsPerRun', label: '1回の処理件数（空欄で3）', type: 'number', min: 1, max: 10 },
    { key: 'promptPrefix', label: 'Prompt Prefix（空なら既定の解説依頼）', type: 'text' }
  ];
})(typeof window !== 'undefined' ? window : self);
