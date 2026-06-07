/**
 * Doppler secrets 管理（SSOT）
 *
 * - オプションには service token のみ永続化
 * - 取得した secrets は chrome.storage.local.dopplerSecretsCache にキャッシュ
 * - 実行時は applyDopplerSecretsToSettings() で effective settings を組み立てる
 */

const DOPPLER_API_BASE = 'https://api.doppler.com/v3/configs/config/secrets/download';
const DOPPLER_CACHE_STORAGE_KEY = 'dopplerSecretsCache';
const DOPPLER_FETCH_TIMEOUT_MS = 10000;
/** スケジュール実行時のキャッシュ TTL（6時間） */
const DOPPLER_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** @readonly Doppler 側で用意する secret 名の一覧（SSOT） */
const DOPPLER_SECRET_SCHEMA = Object.freeze([
  {
    key: 'API_KEY',
    label: '外部 API キー（本番）',
    required: true,
    usedBy: ['moneyforward', 'moneyforward-balance', 'moneytree-vault', 'rakuten-card']
  },
  {
    key: 'API_KEY_LOCAL',
    label: '外部 API キー（ローカル）',
    required: false,
    usedBy: ['同上（localMode 時。未設定なら API_KEY にフォールバック）']
  },
  {
    key: 'SLACK_ERROR_WEBHOOK_URL',
    label: 'Slack Webhook（エラー・0件通知）',
    required: false,
    usedBy: ['全サイト（グローバル）']
  },
  {
    key: 'SLACK_SUCCESS_WEBHOOK_URL',
    label: 'Slack Webhook（成功・稼働確認）',
    required: false,
    usedBy: ['全サイト（グローバル）']
  },
  {
    key: 'X_BOOKMARKS_SLACK_WEBHOOK_URL',
    label: 'Slack Webhook（Xブックマーク処理結果）',
    required: false,
    usedBy: ['x-bookmarks']
  },
  {
    key: 'RAKUTEN_LOGIN_PASSWORD',
    label: '楽天カード ログインパスワード',
    required: false,
    usedBy: ['rakuten-card']
  },
  {
    key: 'MONEYTREE_LOGIN_EMAIL',
    label: 'Moneytree ログインメール',
    required: false,
    usedBy: ['moneytree-vault']
  },
  {
    key: 'MONEYTREE_LOGIN_PASSWORD',
    label: 'Moneytree ログインパスワード',
    required: false,
    usedBy: ['moneytree-vault']
  }
]);

const DOPPLER_SECRET_KEYS = Object.freeze(
  DOPPLER_SECRET_SCHEMA.map((entry) => entry.key)
);

/** storage 正規化で削除するグローバル secret キー */
const DEPRECATED_GLOBAL_SECRET_KEYS = Object.freeze([
  'slackWebhookUrl',
  'slackSuccessWebhookUrl'
]);

/** storage 正規化で削除するサイト別 secret キー */
const DEPRECATED_SITE_SECRET_KEYS = Object.freeze([
  'ifaApiKey',
  'ifaApiKeyLocal',
  'householdApiKey',
  'householdApiKeyLocal',
  'loginEmail',
  'loginPassword',
  'slackWebhookUrl'
]);

/**
 * @returns {string}
 */
function buildDopplerSecretsQuery() {
  const params = new URLSearchParams({
    format: 'json',
    secrets: DOPPLER_SECRET_KEYS.join(',')
  });
  return `${DOPPLER_API_BASE}?${params.toString()}`;
}

/**
 * @param {Object} settings
 * @returns {string}
 */
function getDopplerServiceToken(settings) {
  return (settings?.doppler?.serviceToken || '').trim();
}

/**
 * @param {Record<string, string>} values
 * @returns {{ ok: true, values: Record<string, string> } | { ok: false, missing: string[] }}
 */
function validateDopplerSecretValues(values) {
  const missing = [];
  for (const entry of DOPPLER_SECRET_SCHEMA) {
    if (!entry.required) continue;
    const v = (values[entry.key] || '').trim();
    if (!v) missing.push(entry.key);
  }
  if (missing.length > 0) {
    return { ok: false, missing };
  }
  return { ok: true, values };
}

/**
 * @param {Record<string, string>} raw
 * @returns {Record<string, string>}
 */
function normalizeDopplerSecretValues(raw) {
  const values = {};
  for (const key of DOPPLER_SECRET_KEYS) {
    values[key] = typeof raw?.[key] === 'string' ? raw[key] : '';
  }
  return values;
}

/**
 * @param {Object|null|undefined} cache
 * @param {number} [now=Date.now()]
 * @returns {boolean}
 */
function isDopplerCacheValid(cache, serviceToken, now = Date.now()) {
  if (!cache || !cache.values || typeof cache.expiresAt !== 'number') {
    return false;
  }
  if ((cache.serviceToken || '') !== (serviceToken || '').trim()) {
    return false;
  }
  return cache.expiresAt > now;
}

/**
 * @returns {Promise<Object|null>}
 */
async function loadDopplerSecretsCache() {
  const got = await chrome.storage.local.get(DOPPLER_CACHE_STORAGE_KEY);
  return got[DOPPLER_CACHE_STORAGE_KEY] || null;
}

/**
 * @param {Record<string, string>} values
 * @param {number} [now=Date.now()]
 * @returns {Promise<void>}
 */
async function saveDopplerSecretsCache(values, serviceToken, now = Date.now()) {
  await chrome.storage.local.set({
    [DOPPLER_CACHE_STORAGE_KEY]: {
      values,
      serviceToken: (serviceToken || '').trim(),
      fetchedAt: now,
      expiresAt: now + DOPPLER_CACHE_TTL_MS
    }
  });
}

/**
 * @param {string} serviceToken
 * @returns {Promise<Record<string, string>>}
 */
async function fetchDopplerSecretsFromNetwork(serviceToken) {
  const token = (serviceToken || '').trim();
  if (!token) {
    throw new Error('Doppler Service Token が未設定です。オプション画面で設定してください。');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DOPPLER_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(buildDopplerSecretsQuery(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      },
      signal: controller.signal
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error('Doppler Service Token が無効、または権限不足です');
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Doppler 取得失敗 (${response.status})${text ? `: ${text}` : ''}`);
    }

    const body = await response.json();
    const values = normalizeDopplerSecretValues(body);
    const validated = validateDopplerSecretValues(values);
    if (!validated.ok) {
      throw new Error(`Doppler secrets に不足があります: ${validated.missing.join(', ')}`);
    }
    return validated.values;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Doppler 取得がタイムアウトしました');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * @param {Object} settings
 * @param {{ forceRefresh?: boolean, allowStaleOnError?: boolean }} [options]
 * @returns {Promise<Record<string, string>>}
 */
async function ensureDopplerSecrets(settings, options = {}) {
  const forceRefresh = options.forceRefresh === true;
  const allowStaleOnError = options.allowStaleOnError === true;
  const serviceToken = getDopplerServiceToken(settings);
  const now = Date.now();
  const cache = await loadDopplerSecretsCache();

  if (!forceRefresh && isDopplerCacheValid(cache, serviceToken, now)) {
    return cache.values;
  }

  try {
    const values = await fetchDopplerSecretsFromNetwork(serviceToken);
    await saveDopplerSecretsCache(values, serviceToken, now);
    return values;
  } catch (err) {
    const token = (serviceToken || '').trim();
    const cacheToken = (cache?.serviceToken || '').trim();
    if (allowStaleOnError && cache?.values && cacheToken && cacheToken === token) {
      console.warn('[Doppler] 取得失敗。同一トークンのキャッシュを使用します:', err.message || String(err));
      return cache.values;
    }
    throw err;
  }
}

/**
 * @param {Record<string, string>} secrets
 * @param {boolean} localMode
 * @returns {string}
 */
function resolveApiKey(secrets, localMode) {
  const local = (secrets.API_KEY_LOCAL || '').trim();
  const primary = (secrets.API_KEY || '').trim();
  return localMode && local ? local : primary;
}

/**
 * Doppler secrets を settings へ反映した実行用 settings を返す（永続 storage には書かない）
 *
 * @param {Object} settings
 * @param {Record<string, string>} secrets
 * @returns {Object}
 */
function applyDopplerSecretsToSettings(settings, secrets) {
  const next = JSON.parse(JSON.stringify(settings || { sites: {} }));
  next.sites = next.sites || {};

  next.slackWebhookUrl = (secrets.SLACK_ERROR_WEBHOOK_URL || '').trim();
  next.slackSuccessWebhookUrl = (secrets.SLACK_SUCCESS_WEBHOOK_URL || '').trim();

  if (!next.sites['x-bookmarks']) {
    next.sites['x-bookmarks'] = {};
  }
  next.sites['x-bookmarks'].slackWebhookUrl = (secrets.X_BOOKMARKS_SLACK_WEBHOOK_URL || '').trim();

  if (!next.sites['rakuten-card']) {
    next.sites['rakuten-card'] = {};
  }
  next.sites['rakuten-card'].loginPassword = (secrets.RAKUTEN_LOGIN_PASSWORD || '').trim();

  if (!next.sites['moneytree-vault']) {
    next.sites['moneytree-vault'] = {};
  }
  next.sites['moneytree-vault'].loginEmail = (secrets.MONEYTREE_LOGIN_EMAIL || '').trim();
  next.sites['moneytree-vault'].loginPassword = (secrets.MONEYTREE_LOGIN_PASSWORD || '').trim();

  return next;
}

/**
 * settings から旧 secret フィールドを除去し doppler 設定を初期化する
 *
 * @param {Object} settings
 * @returns {boolean} changed
 */
function migrateDeprecatedSecretsFromSettings(settings) {
  let changed = false;
  settings = settings || { sites: {} };
  settings.sites = settings.sites || {};

  for (const key of DEPRECATED_GLOBAL_SECRET_KEYS) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) {
      delete settings[key];
      changed = true;
    }
  }

  if (!settings.doppler || typeof settings.doppler !== 'object') {
    settings.doppler = { serviceToken: '' };
    changed = true;
  } else if (typeof settings.doppler.serviceToken !== 'string') {
    settings.doppler.serviceToken = '';
    changed = true;
  }

  for (const siteId of Object.keys(settings.sites)) {
    const site = settings.sites[siteId];
    if (!site || typeof site !== 'object') continue;
    for (const key of DEPRECATED_SITE_SECRET_KEYS) {
      if (Object.prototype.hasOwnProperty.call(site, key)) {
        delete site[key];
        changed = true;
      }
    }
  }

  return changed;
}

/**
 * オプション画面向け: 各キーの設定有無（値は返さない）
 *
 * @param {Record<string, string>|null|undefined} secrets
 * @returns {Array<{ key: string, label: string, configured: boolean, required: boolean, usedBy: string[] }>}
 */
function summarizeDopplerSecretStatus(secrets) {
  return DOPPLER_SECRET_SCHEMA.map((entry) => ({
    key: entry.key,
    label: entry.label,
    configured: !!(secrets && (secrets[entry.key] || '').trim()),
    required: !!entry.required,
    usedBy: entry.usedBy
  }));
}
