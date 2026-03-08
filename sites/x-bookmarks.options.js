/**
 * x-bookmarks サイトのオプションスキーマ定義
 *
 * オプション画面で動的読み込みされ、サイト固有の設定項目を追加する。
 */
(function (g) {
  g.__SITE_OPTIONS__ = g.__SITE_OPTIONS__ || {};
  g.__SITE_OPTIONS__['x-bookmarks'] = [
    { key: 'apiUrl', label: 'API URL', type: 'url' }
  ];
})(typeof window !== 'undefined' ? window : self);
