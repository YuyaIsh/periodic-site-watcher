/**
 * 組み込みサイト定義（Service Worker / Options Page 共通）
 *
 * 対応サイトはコード実装で決まる。storage に存在しても未実装 siteId は正規化で除去する。
 */

/** @readonly 表示・実行順（昇順） */
const BUILTIN_SITE_IDS = Object.freeze([
  'moneyforward',
  'moneyforward-balance',
  'moneytree-vault',
  'rakuten-card',
  'x-bookmarks'
]);

/** 組み込みサイトの巡回 URL（コード固定） */
const BUILTIN_SITE_URLS = Object.freeze({
  moneyforward:
    'https://moneyforward.com/accounts/show/PcahB6adgVbq9ti28FGAXWM6sUfdwasEn8Nw2m8IsUc',
  'moneyforward-balance': 'https://moneyforward.com/accounts',
  'moneytree-vault': 'https://app.getmoneytree.com/app/vault',
  'rakuten-card':
    'https://www.rakuten-card.co.jp/e-navi/members/statement/index.xhtml?l-id=enavi_all_glonavi_statement',
  'x-bookmarks': 'https://x.com/i/bookmarks'
});

/** siteId ごとの schedule 初期値（未指定時は DEFAULT_SITE_CONFIG.schedule） */
const SITE_SCHEDULE_DEFAULTS = Object.freeze({
  'moneyforward-balance': {
    type: 'daily',
    every: 1,
    at: '06:00'
  }
});

/** siteId ごとの timeoutSec 初期値 */
const SITE_TIMEOUT_DEFAULTS = Object.freeze({
  'moneyforward-balance': 130,
  'moneytree-vault': 60
});

/** オプションから削除した URL キー（storage 正規化で除去） */
const DEPRECATED_SITE_OPTION_KEYS = Object.freeze([
  'ifaApiUrl',
  'householdApiUrl'
]);

/** 共通デフォルト */
const DEFAULT_SITE_CONFIG = Object.freeze({
  enabled: false,
  timeoutSec: 30,
  schedule: {
    type: 'hourly',
    minute: 0,
    every: 1
  }
});

/**
 * @param {string} siteId
 * @returns {boolean}
 */
function isBuiltinSiteId(siteId) {
  return BUILTIN_SITE_IDS.includes(siteId);
}

/**
 * 組み込みサイトの巡回 URL を返す
 *
 * @param {string} siteId
 * @returns {string}
 */
function getBuiltinSiteUrl(siteId) {
  return BUILTIN_SITE_URLS[siteId] || '';
}

/**
 * 組み込みサイトの初期設定を生成する
 *
 * @param {string} siteId
 * @returns {Object}
 */
function createDefaultSiteConfig(siteId) {
  const scheduleDefault =
    SITE_SCHEDULE_DEFAULTS[siteId] || DEFAULT_SITE_CONFIG.schedule;
  const timeoutSec = SITE_TIMEOUT_DEFAULTS[siteId] ?? DEFAULT_SITE_CONFIG.timeoutSec;
  return {
    url: getBuiltinSiteUrl(siteId),
    ...DEFAULT_SITE_CONFIG,
    timeoutSec,
    schedule: { ...scheduleDefault }
  };
}

/**
 * settings / state を組み込みサイト定義に合わせて正規化する
 *
 * - 未知 siteId を settings.sites / state.bySite から削除
 * - 欠落している組み込みサイトをデフォルト設定で追加
 * - 既存の組み込みサイト設定は上書きしない（url はコード固定値で常に同期）
 *
 * @param {Object} settings
 * @param {Object} state
 * @param {number} [now=Date.now()]
 * @returns {{ settings: Object, state: Object, changed: boolean, removedSiteIds: string[] }}
 */
function normalizeBuiltinSites(settings, state, now = Date.now()) {
  let changed = false;
  const removedSiteIds = [];

  settings = settings || { sites: {} };
  settings.sites = settings.sites || {};
  state = state || { bySite: {} };
  state.bySite = state.bySite || {};

  for (const siteId of Object.keys(settings.sites)) {
    if (!isBuiltinSiteId(siteId)) {
      delete settings.sites[siteId];
      removedSiteIds.push(siteId);
      changed = true;
    }
  }

  for (const siteId of Object.keys(state.bySite)) {
    if (!isBuiltinSiteId(siteId)) {
      delete state.bySite[siteId];
      changed = true;
    }
  }

  for (const siteId of BUILTIN_SITE_IDS) {
    if (!settings.sites[siteId]) {
      settings.sites[siteId] = createDefaultSiteConfig(siteId);
      changed = true;
    } else {
      const builtinUrl = getBuiltinSiteUrl(siteId);
      if (settings.sites[siteId].url !== builtinUrl) {
        settings.sites[siteId].url = builtinUrl;
        changed = true;
      }
      if (settings.sites[siteId].schedule?.every == null) {
        settings.sites[siteId].schedule = {
          ...settings.sites[siteId].schedule,
          every: 1
        };
        changed = true;
      }
      for (const key of DEPRECATED_SITE_OPTION_KEYS) {
        if (Object.prototype.hasOwnProperty.call(settings.sites[siteId], key)) {
          delete settings.sites[siteId][key];
          changed = true;
        }
      }
    }
    if (!state.bySite[siteId]) {
      const schedule = settings.sites[siteId].schedule;
      state.bySite[siteId] = {
        nextRun: computeNextRunAfterSuccess(now, schedule, { mode: 'initial' })
      };
      changed = true;
    }
  }

  return { settings, state, changed, removedSiteIds };
}
