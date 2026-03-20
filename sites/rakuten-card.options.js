/**
 * 楽天カード サイトのオプションスキーマ定義
 *
 * オプション画面で動的読み込みされ、サイト固有の設定項目を追加する。
 */
(function (g) {
  g.__SITE_OPTIONS__ = g.__SITE_OPTIONS__ || {};
  g.__SITE_OPTIONS__['rakuten-card'] = [
    { key: 'householdApiUrl', label: 'Household API URL', type: 'url' },
    { key: 'householdApiKey', label: 'Household API Key', type: 'password' },
    { key: 'loginPassword', label: 'ログインパスワード', type: 'password' }
  ];
})(typeof window !== 'undefined' ? window : self);
