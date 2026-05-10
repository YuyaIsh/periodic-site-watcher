/**
 * x-bookmarks サイトのオプションスキーマ定義
 *
 * オプション画面で動的読み込みされ、サイト固有の設定項目を追加する。
 * XブックマークURL、処理件数、スクロール間隔は要件として固定するため、
 * ここでは環境ごとに必要な値だけを設定させる。
 */
(function (g) {
  g.__SITE_OPTIONS__ = g.__SITE_OPTIONS__ || {};
  g.__SITE_OPTIONS__['x-bookmarks'] = [
    { key: 'chatgptProjectUrl', label: 'ChatGPT Project URL', type: 'url' },
    { key: 'slackWebhookUrl', label: 'Slack Webhook URL', type: 'url' },
    { key: 'promptPrefix', label: 'Prompt Prefix（空なら既定の解説依頼）', type: 'text' }
  ];
})(typeof window !== 'undefined' ? window : self);
