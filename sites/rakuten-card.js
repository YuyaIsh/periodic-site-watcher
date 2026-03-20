/**
 * 楽天カード ご利用明細抽出（単一ページ分）
 *
 * 複数月の遷移と API 送信は Service Worker 側で行う。
 */

const RC_MIN_YEARMONTH = '2026-02';

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
  const yyyymm = getStatementMonthYyyymm();
  const defaultPay = parseCardPaymentDateFromPage();
  const fallbackPay = defaultCardPaymentDateFromMonth(yyyymm);
  const cardPaymentDate = defaultPay || fallbackPay || '';

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
      cardPaymentDate: cardPaymentDate,
      amount: amount,
      transferBank: 'GMO_AOZORA',
      useTarget: normalizeUseTarget(storeTitle)
    });
  }

  return out;
}

async function collect_rakuten_card() {
  const displayedYearMonth = getDisplayedYearMonth();

  let items = [];
  if (displayedYearMonth != null && displayedYearMonth >= RC_MIN_YEARMONTH) {
    items = extractStatementItems();
  }

  const prevEl = document.querySelector('.stmt-head-calendar__prev');
  const prevMonthHref = prevEl ? prevEl.getAttribute('href') : null;

  return {
    items: items,
    prevMonthHref: prevMonthHref,
    displayedYearMonth: displayedYearMonth
  };
}

window['collect_rakuten-card'] = collect_rakuten_card;
