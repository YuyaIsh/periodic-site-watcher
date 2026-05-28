/**
 * Moneytree Vault サイトのオプションスキーマ定義
 */
(function (g) {
  g.__SITE_OPTIONS__ = g.__SITE_OPTIONS__ || {};
  g.__SITE_OPTIONS__['moneytree-vault'] = [
    { key: 'loginEmail', label: 'ログインメールアドレス', type: 'text' },
    { key: 'loginPassword', label: 'ログインパスワード', type: 'password' },
    { key: 'ifaApiKey', label: 'IFA API Key', type: 'password' },
    { key: 'ifaApiKeyLocal', label: 'IFA API Key（ローカル手動・任意）', type: 'password' }
  ];
})(typeof window !== 'undefined' ? window : self);
