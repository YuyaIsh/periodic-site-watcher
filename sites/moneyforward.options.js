/**
 * MoneyForward サイトのオプションスキーマ定義
 *
 * オプション画面で動的読み込みされ、サイト固有の設定項目を追加する。
 */
(function (g) {
  g.__SITE_OPTIONS__ = g.__SITE_OPTIONS__ || {};
  g.__SITE_OPTIONS__['moneyforward'] = [
    { key: 'ifaApiUrl', label: 'IFA API URL', type: 'url' },
    { key: 'ifaApiKey', label: 'IFA API Key', type: 'password' }
  ];
})(typeof window !== 'undefined' ? window : self);
