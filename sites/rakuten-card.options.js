/**
 * 楽天カード サイトのオプションスキーマ定義
 *
 * オプション画面で動的読み込みされ、サイト固有の設定項目を追加する。
 */
(function (g) {
  g.__SITE_OPTIONS__ = g.__SITE_OPTIONS__ || {};
  g.__SITE_OPTIONS__['rakuten-card'] = [
    { key: 'rcMonthsToFetch', label: '取得月数（空欄で2）', type: 'number', min: 1, max: 60 },
    { key: 'rcMinYearMonth', label: '最小対象年月 YYYY-MM（空欄で2026-03）', type: 'text' },
    { key: 'householdApiUrl', label: 'Household API URL', type: 'url' },
    { key: 'householdApiKey', label: 'Household API Key', type: 'password' },
    { key: 'householdApiKeyLocal', label: 'Household API Key（ローカル手動・任意）', type: 'password' },
    { key: 'loginPassword', label: 'ログインパスワード', type: 'password' }
  ];
})(typeof window !== 'undefined' ? window : self);
