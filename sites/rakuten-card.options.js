/**
 * 楽天カード サイトのオプションスキーマ定義
 *
 * オプション画面で動的読み込みされ、サイト固有の設定項目を追加する。
 * ログイン情報・API キーは Doppler で管理します。
 */
(function (g) {
  g.__SITE_OPTIONS__ = g.__SITE_OPTIONS__ || {};
  g.__SITE_OPTIONS__['rakuten-card'] = [
    { key: 'rcMonthsToFetch', label: '取得月数（空欄で2）', type: 'number', min: 1, max: 60 },
    { key: 'rcMinYearMonth', label: '最小対象年月 YYYY-MM（空欄で2026-03）', type: 'text' }
  ];
})(typeof window !== 'undefined' ? window : self);
