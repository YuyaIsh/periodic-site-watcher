/**
 * MoneyForward サイトのオプションスキーマ定義
 *
 * オプション画面で動的読み込みされ、サイト固有の設定項目を追加する。
 */
(function (g) {
  g.__SITE_OPTIONS__ = g.__SITE_OPTIONS__ || {};
  g.__SITE_OPTIONS__['moneyforward'] = [
    { key: 'mfMonthsToFetch', label: '取得月数（空欄で2）', type: 'number', min: 1, max: 24 },
    { key: 'mfMinYearMonth', label: '最小対象年月 YYYY-MM（空欄で2025-03）', type: 'text' },
    { key: 'ifaApiUrl', label: 'IFA API URL', type: 'url' },
    { key: 'ifaApiKey', label: 'IFA API Key', type: 'password' },
    { key: 'ifaApiKeyLocal', label: 'IFA API Key（ローカル手動・任意）', type: 'password' }
  ];
})(typeof window !== 'undefined' ? window : self);
