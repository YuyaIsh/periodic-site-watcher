/**
 * MoneyForward ME 口座残高（住信SBIネット銀行）抽出
 */

const LOG_PREFIX = '[サイト巡回]';
const SITE_ID = 'moneyforward-balance';
const BANK_NAME = '住信SBIネット銀行';
const STALE_MS = 24 * 60 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 120000;
const REFRESH_POLL_MS = 500;

/**
 * @param {string} raw
 * @returns {number}
 */
function parseBalanceAmount(raw) {
  const text = (raw || '').trim();
  if (!text) {
    throw new Error(`${SITE_ID}: 残高が空です`);
  }
  const digits = text.replace(/[^\d-]/g, '');
  if (!digits || digits === '-') {
    throw new Error(`${SITE_ID}: 残高のパースに失敗: ${text}`);
  }
  return parseInt(digits, 10);
}

/**
 * (MM/DD HH:mm) を JST の Date に変換（年は now 基準で推定）
 *
 * @param {string} raw
 * @param {Date} now
 * @returns {Date}
 */
function parseLastFetchAt(raw, now) {
  const m = (raw || '').trim().match(/^\((\d{2})\/(\d{2})\s+(\d{2}):(\d{2})\)$/);
  if (!m) {
    throw new Error(`${SITE_ID}: 最終取得日時の形式が不正: ${raw}`);
  }
  const month = parseInt(m[1], 10);
  const day = parseInt(m[2], 10);
  const hour = parseInt(m[3], 10);
  const minute = parseInt(m[4], 10);
  let year = now.getFullYear();
  let candidate = new Date(
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`
  );
  if (candidate.getTime() > now.getTime() + 60 * 60 * 1000) {
    year -= 1;
    candidate = new Date(
      `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`
    );
  }
  return candidate;
}

/**
 * @param {Date} date
 * @returns {string}
 */
function toJstIsoString(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}+09:00`;
}

/**
 * @returns {HTMLTableRowElement}
 */
function findSbiNetBankRow() {
  const rows = document.querySelectorAll('#account-table tbody tr');
  for (const row of rows) {
    const link = row.querySelector('td.service a');
    if (link && (link.textContent || '').trim() === BANK_NAME) {
      return row;
    }
  }
  throw new Error(`${SITE_ID}: ${BANK_NAME} の行が見つかりません`);
}

/**
 * @param {HTMLTableRowElement} row
 * @returns {string}
 */
function readLastFetchText(row) {
  const ps = row.querySelectorAll('td.created p');
  if (ps.length < 2) {
    throw new Error(`${SITE_ID}: 最終取得日時が見つかりません`);
  }
  return (ps[1].textContent || '').trim();
}

/**
 * @param {HTMLTableRowElement} row
 * @returns {Promise<void>}
 */
function waitForAccountRefresh(row, previousLastFetchText) {
  const accountId = row.id;
  if (!accountId) {
    throw new Error(`${SITE_ID}: 口座行 ID が取得できません`);
  }

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + REFRESH_TIMEOUT_MS;

    const pollId = setInterval(() => {
      const statusSpan = document.getElementById(`js-status-sentence-span-${accountId}`);
      const statusText = (statusSpan?.textContent || '').trim();
      const currentText = readLastFetchText(row);
      const loading = document.getElementById(`js-hidden-loading-${accountId}`);
      const isLoading = loading && loading.style.display !== 'none';

      if (statusText === '正常' && !isLoading && currentText !== previousLastFetchText) {
        clearInterval(pollId);
        resolve();
        return;
      }

      if (Date.now() >= deadline) {
        clearInterval(pollId);
        reject(new Error(`${SITE_ID}: 口座更新の完了待ちがタイムアウトしました`));
      }
    }, REFRESH_POLL_MS);
  });
}

/**
 * @param {HTMLTableRowElement} row
 * @returns {Promise<boolean>} refreshed したか
 */
async function refreshIfStale(row) {
  const now = new Date();
  const lastFetchText = readLastFetchText(row);
  const lastFetchAt = parseLastFetchAt(lastFetchText, now);
  if (now.getTime() - lastFetchAt.getTime() <= STALE_MS) {
    return false;
  }

  const accountId = row.id;
  const form = document.getElementById(`js-recorrect-form-${accountId}`);
  const submit = form?.querySelector('input[type="submit"]');
  if (!submit) {
    throw new Error(`${SITE_ID}: 更新ボタンが見つかりません`);
  }

  console.warn(`${LOG_PREFIX} ${SITE_ID} 最終取得が24時間超のため更新`, { lastFetchText });
  submit.click();
  await waitForAccountRefresh(row, lastFetchText);
  return true;
}

async function collect_moneyforward_balance(_site = {}) {
  const row = findSbiNetBankRow();
  const refreshed = await refreshIfStale(row);

  const amountRaw = row.querySelector('td.number')?.textContent || '';
  const balanceAmount = parseBalanceAmount(amountRaw);
  const lastFetchText = readLastFetchText(row);
  const recordedAt = toJstIsoString(parseLastFetchAt(lastFetchText, new Date()));

  return {
    balanceAmount,
    recordedAt,
    note: 'MoneyForward sync',
    refreshed
  };
}

if (typeof window !== 'undefined') {
  window.collect_moneyforward_balance = collect_moneyforward_balance;
}
