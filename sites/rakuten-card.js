/**
 * 楽天カード ご利用明細抽出（単一ページ分）
 *
 * 複数月の遷移と API 送信は Service Worker 側で行う。
 */

const LOG_PREFIX = '[サイト巡回]';
const SITE_ID = 'rakuten-card';

/**
 * オプションから最小対象年月を取得する
 * @param {Object} [site] - サイト設定（オプション画面の値）
 * @returns {string}
 */
function getRcMinYearMonth(site = {}) {
  const raw = (site?.rcMinYearMonth || '').trim();
  return /^\d{4}-\d{2}$/.test(raw) ? raw : '2026-03';
}

/**
 * @param {string} s
 * @returns {string}
 */
function normalizeUseTarget(s) {
  if (!s) return '';
  return s
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 100);
}

/**
 * @returns {string|null} "YYYY-MM" または null
 */
function getDisplayedYearMonth() {
  const el = document.querySelector('#statement-month');
  if (!el) return null;
  const v = (el.value || '').trim();
  if (v.length !== 6 || !/^\d{6}$/.test(v)) return null;
  return v.slice(0, 4) + '-' + v.slice(4, 6);
}

/**
 * @returns {string} YYYYMM
 */
function getStatementMonthYyyymm() {
  const el = document.querySelector('#statement-month');
  if (!el) return '';
  const v = (el.value || '').trim();
  return v.length === 6 && /^\d{6}$/.test(v) ? v : '';
}

/**
 * @returns {string|null} YYYY-MM-DD
 */
function parseCardPaymentDateFromPage() {
  const el = document.querySelector('.stmt-about-info__date__detail');
  if (!el) return null;
  const text = (el.textContent || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  const m = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  const mo = m[2].length === 1 ? '0' + m[2] : m[2];
  const d = m[3].length === 1 ? '0' + m[3] : m[3];
  return m[1] + '-' + mo + '-' + d;
}

/**
 * @param {string} yyyymm
 * @returns {string} YYYY-MM-25
 */
function defaultCardPaymentDateFromMonth(yyyymm) {
  if (yyyymm.length !== 6 || !/^\d{6}$/.test(yyyymm)) return '';
  return yyyymm.slice(0, 4) + '-' + yyyymm.slice(4, 6) + '-25';
}

/**
 * 「YYYY年MM月以降分」カレンダー表示時の閾値年月（YYYY-MM）。未検出は null。
 * @returns {string|null}
 */
function parseSinceMonthFromCalendarButton() {
  const btn = document.querySelector('#js-payment-calendar-btn');
  if (!btn) return null;
  const text = (btn.textContent || '').replace(/\s+/g, ' ').trim();
  const primary = /(\d{4})年(\d{1,2})月以降/.exec(text);
  if (primary) {
    const y = primary[1];
    const mo = primary[2].padStart(2, '0');
    return `${y}-${mo}`;
  }
  if (!text.includes('以降')) return null;
  const sm = document.querySelector('#statement-month');
  if (!sm) return null;
  const v = (sm.value || '').trim();
  if (v.length !== 6 || !/^\d{6}$/.test(v)) return null;
  return v.slice(0, 4) + '-' + v.slice(4, 6);
}

/**
 * @param {string|null} ymd YYYY-MM-DD
 * @returns {number|null} 1–31
 */
function paymentDayFromYmd(ymd) {
  if (!ymd || ymd.length < 10) return null;
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = parseInt(m[3], 10);
  return d >= 1 && d <= 31 ? d : null;
}

/**
 * 利用月の翌月に支払日を載せ替え（ヘッダー日 or 25、無効日は月末クランプ）
 * @param {string} usedOn YYYY-MM-DD
 * @param {string|null} headerPayYmd
 * @returns {string} YYYY-MM-DD
 */
function cardPaymentDateInMonthAfterUsed(usedOn, headerPayYmd) {
  const day = paymentDayFromYmd(headerPayYmd) ?? 25;
  const parts = usedOn.split('-');
  const y = parseInt(parts[0], 10);
  const mo = parseInt(parts[1], 10);
  const firstOfNext = new Date(y, mo - 1 + 1, 1);
  const py = firstOfNext.getFullYear();
  const pm = firstOfNext.getMonth() + 1;
  const lastDay = new Date(py, pm, 0).getDate();
  const d = Math.min(day, lastDay);
  return `${py}-${String(pm).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * @param {string} raw
 * @returns {number}
 */
function parseAmountFromCell(raw) {
  if (!raw) return NaN;
  const cleaned = String(raw).replace(/[¥,\\\s]/g, '').replace(/[^\d.-]/g, '');
  return parseFloat(cleaned);
}

/**
 * @param {string} dateTitle 例: 2026/02/28
 * @returns {string|null} YYYY-MM-DD
 */
function usedOnFromDateTitle(dateTitle) {
  if (!dateTitle) return null;
  const m = dateTitle.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (!m) return null;
  return m[1] + '-' + m[2] + '-' + m[3];
}

/**
 * @returns {Array<Object>}
 */
function extractStatementItems() {
  const sinceYm = parseSinceMonthFromCalendarButton();
  if (sinceYm != null) {
    console.log(`${LOG_PREFIX} ${SITE_ID} 以降検出 sinceYm=${sinceYm}`);
  }

  const yyyymm = getStatementMonthYyyymm();
  const defaultPay = parseCardPaymentDateFromPage();
  const fallbackPay = defaultCardPaymentDateFromMonth(yyyymm);
  const baseCardPaymentDate = defaultPay || fallbackPay || '';

  const rows = document.querySelectorAll(
    '.stmt-payment-lists__i.js-payment-sort-item'
  );
  const out = [];

  for (const row of rows) {
    const tbl = row.querySelector('.stmt-payment-lists__tbl');
    if (!tbl) continue;
    const cells = tbl.querySelectorAll(':scope > .stmt-payment-lists__data');
    if (cells.length < 5) continue;

    const dateTitle = (cells[0].getAttribute('title') || '').trim();
    const storeTitle = (cells[1].getAttribute('title') || '').trim();
    const amountCell = cells[4];
    const amountRaw =
      amountCell.getAttribute('title') || amountCell.textContent || '';
    const amount = parseAmountFromCell(amountRaw);
    if (Number.isNaN(amount)) continue;

    const usedOn = usedOnFromDateTitle(dateTitle);
    if (!usedOn) continue;

    let cardPaymentDate = baseCardPaymentDate;
    if (sinceYm != null && usedOn.slice(0, 7) === sinceYm) {
      cardPaymentDate = cardPaymentDateInMonthAfterUsed(usedOn, defaultPay);
    }

    const tipBtn = row.querySelector('[data-tooltip-usage-number]');
    let detailNo = tipBtn ? tipBtn.getAttribute('data-tooltip-usage-number') : null;
    if (!detailNo) {
      const copyEl = row.querySelector('.stmt-copy-area-number');
      detailNo = copyEl ? (copyEl.textContent || '').trim() : '';
    }
    if (!detailNo || !yyyymm) continue;

    out.push({
      externalId: yyyymm + ':' + detailNo,
      usedOn: usedOn,
      cardPaymentDate,
      amount: amount,
      transferBank: 'GMO_AOZORA',
      useTarget: normalizeUseTarget(storeTitle)
    });
  }

  return out;
}

/**
 * 0件時の切り分け用（コンソールの警告1本にまとめる）
 * @param {string|null} displayedYearMonth
 */
function logRakutenZeroDiagnostics(displayedYearMonth, rcMinYearMonth) {
  const sm = document.querySelector('#statement-month');
  const rawMonth = sm ? String(sm.value || '').trim() : '';
  const inRange =
    displayedYearMonth != null && displayedYearMonth >= rcMinYearMonth;
  const rows = document.querySelectorAll(
    '.stmt-payment-lists__i.js-payment-sort-item'
  );
  const looseRows = document.querySelectorAll('.stmt-payment-lists__i');
  const yyyymm = getStatementMonthYyyymm();

  /** @type {Record<string, unknown>} */
  const payload = {
    statementMonth: { exists: !!sm, rawValue: rawMonth || '(empty)' },
    displayedYearMonth: displayedYearMonth ?? '(null)',
    minYearMonth: rcMinYearMonth,
    inRange,
    rowCountStrict: rows.length,
    rowCountLoose: looseRows.length,
    yyyymmForExtract: yyyymm || '(empty)'
  };

  if (rows.length > 0 && inRange) {
    const row = rows[0];
    const tbl = row.querySelector('.stmt-payment-lists__tbl');
    const cells = tbl
      ? tbl.querySelectorAll(':scope > .stmt-payment-lists__data')
      : [];
    const dateTitle = cells[0]
      ? (cells[0].getAttribute('title') || '').trim()
      : '';
    const amountCell = cells[4];
    const amountRaw = amountCell
      ? amountCell.getAttribute('title') || amountCell.textContent || ''
      : '';
    const amount = parseAmountFromCell(amountRaw);
    const tipBtn = row.querySelector('[data-tooltip-usage-number]');
    let detailNo = tipBtn ? tipBtn.getAttribute('data-tooltip-usage-number') : null;
    if (!detailNo) {
      const copyEl = row.querySelector('.stmt-copy-area-number');
      detailNo = copyEl ? (copyEl.textContent || '').trim() : '';
    }
    payload.firstRow = {
      hasTbl: !!tbl,
      cellCount: cells.length,
      dateTitle: dateTitle || '(empty)',
      amountRaw: String(amountRaw).slice(0, 120),
      amountIsNaN: Number.isNaN(amount),
      usedOnOk: usedOnFromDateTitle(dateTitle) != null,
      detailNo: detailNo || '(empty)',
      yyyymmOk: !!yyyymm
    };
  }

  console.warn(`${LOG_PREFIX} ${SITE_ID} 0件診断`, payload);
}

async function collect_rakuten_card(site = {}) {
  console.log(`${LOG_PREFIX} ${SITE_ID} 取得開始`);

  const RC_MIN_YEARMONTH = getRcMinYearMonth(site);
  const displayedYearMonth = getDisplayedYearMonth();

  let items = [];
  if (displayedYearMonth != null && displayedYearMonth >= RC_MIN_YEARMONTH) {
    items = extractStatementItems();
  } else if (displayedYearMonth != null) {
    console.log(`${LOG_PREFIX} ${SITE_ID} 表示月が対象外のためスキップ 表示月=${displayedYearMonth}`);
  }

  const prevEl = document.querySelector('.stmt-head-calendar__prev');
  const prevMonthHref = prevEl ? prevEl.getAttribute('href') : null;

  const mockLabel = (typeof window !== 'undefined' && window.__COLLECT_MOCK_MODE__) ? ' モック' : ((typeof window !== 'undefined' && window.__COLLECT_LOCAL_MODE__) ? ' ローカル' : '');
  console.log(`${LOG_PREFIX} ${SITE_ID} 完了 件数=${items.length} 表示月=${displayedYearMonth ?? '-'}${mockLabel}`);

  if (items.length === 0) {
    logRakutenZeroDiagnostics(displayedYearMonth, RC_MIN_YEARMONTH);
  }

  return {
    items: items,
    prevMonthHref: prevMonthHref,
    displayedYearMonth: displayedYearMonth
  };
}

window['collect_rakuten-card'] = collect_rakuten_card;
