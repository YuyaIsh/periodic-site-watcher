/**
 * MoneyForward ME カード明細抽出
 *
 * カードごと前月以降のカード明細を取得し、mf-import APIへ送信する。
 * API側の処理: externalIdで照合して保存されていないもののみ追加する。
 */

const MF_MONTHS_TO_FETCH = 2; // 当月 + 前月の2ヶ月分
/**
 * 対象とする最小年月（この月を含む）
 * - 取得対象: 表示月が `MF_MIN_YEARMONTH` 以上（例: 2026-02 なら 2026-02, 2026-03, ...）
 * - 取得しない: 表示月が `MF_MIN_YEARMONTH` 未満（例: 2026-01, 2025-12, ...）
 */
const MF_MIN_YEARMONTH = '2026-02';

function normalizeCardType(dataOriginalTitle) {
  if (!dataOriginalTitle || dataOriginalTitle.trim() === '') {
    return null;
  }
  if (dataOriginalTitle.includes('Amazon') && dataOriginalTitle.includes('ゴールド')) {
    return 'Amazonゴールド';
  }
  if (dataOriginalTitle.includes('プラチナプリファード')) {
    return '三井住友NLプラチナプリファード';
  }
  if (dataOriginalTitle.includes('ゴールド') && dataOriginalTitle.includes('NL')) {
    return '三井住友NLゴールド';
  }
  if (dataOriginalTitle.includes('オーナーズ')) {
    return '三井住友オーナーズ';
  }
  return null;
}

/**
 * テーブルから明細データを抽出する
 *
 * @returns {Array<{id: string, usedOn: string, amount: string, cardType: string|null}>}
 */
function extractTableData() {
  const rows = document.querySelectorAll('tr.transaction_list');
  const results = [];
  for (const tr of rows) {
    const idAttr = tr.getAttribute('id');
    if (!idAttr || !idAttr.startsWith('js-transaction-')) continue;
    const id = idAttr.replace('js-transaction-', '');
    const dateTd = tr.querySelector('td.date[data-table-sortable-value]');
    const amountSpan = tr.querySelector('td.amount span.offset');
    const noteTd = tr.querySelector('td.note.calc[data-original-title]');
    if (!dateTd || !amountSpan) continue;
    const sortValue = dateTd.getAttribute('data-table-sortable-value') || '';
    const datePart = sortValue.split('-')[0];
    if (!datePart) continue;
    const usedOn = datePart.replace(/\//g, '-');
    const amountRaw = amountSpan.textContent?.trim() || '';
    // 正負を反転: 数値に変換して符号を反転
    const amount = amountRaw ? String(-parseFloat(amountRaw.replace(/,/g, ''))) : '';
    const dataOriginalTitle = noteTd?.getAttribute('data-original-title') || '';
    const cardType = normalizeCardType(dataOriginalTitle);
    if (cardType === null && dataOriginalTitle) {
      console.warn('Unknown card type, skipping:', dataOriginalTitle);
      continue;
    }
    if (cardType === null) continue;
    results.push({ id, usedOn, amount, cardType });
  }
  return results;
}

/**
 * batches を構築するヘルパー（API送信はService Workerで実行する）
 * Content Scriptはページコンテキストで動作するため、別オリジンへのfetchがCORSでブロックされる。
 * そのためデータ抽出のみ行い、実際のAPI送信はService Workerに委譲する。
 *
 * @param {Object} instrument - 支払い手段情報
 * @param {Array} items - 明細データ配列
 * @returns {{instrument: Object, items: Array}} リクエストボディ
 */
function buildMfExpenseBatch(instrument, items) {
  return { instrument, items };
}

/**
 * .fc-header-title h2 の表示（例: "2026/01/01 - 2026/01/31"）から表示中の年月を取得する
 * @returns {string|null} "YYYY-MM" または取得できない場合は null
 */
function getDisplayedYearMonth() {
  const headerTitle = document.querySelector('.fc-header-title h2');
  if (!headerTitle) return null;
  const text = (headerTitle.textContent || '').trim();
  const startPart = text.split(/\s+-\s+/)[0];
  if (!startPart) return null;
  const ymd = startPart.replace(/\//g, '-');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  return ymd.slice(0, 7);
}

async function collect_moneyforward() {
  const TABLE_UPDATE_TIMEOUT_MS = 10000;

  function waitForTableUpdate() {
    return new Promise((resolve) => {
      const headerTitle = document.querySelector('.fc-header-title h2');
      if (!headerTitle) {
        resolve();
        return;
      }
      const observer = new MutationObserver(() => {
        observer.disconnect();
        resolve();
      });
      observer.observe(headerTitle, {
        attributes: true,
        childList: true,
        subtree: true,
        characterData: true
      });
      setTimeout(() => {
        observer.disconnect();
        resolve();
      }, TABLE_UPDATE_TIMEOUT_MS);
    });
  }

  const allRows = [];
  const seenIds = new Set();

  const btnToday = document.querySelector('.fc-button-today');
  const btnPrev = document.querySelector('.fc-button-prev');
  if (!btnToday || !btnPrev) {
    throw new Error('MoneyForward: 今月/前月ボタンが見つかりません');
  }

  btnToday.click();
  await waitForTableUpdate();
  const currentYearMonth = getDisplayedYearMonth();
  // 表示月が `MF_MIN_YEARMONTH` 以上（含む）のときだけその月を取得する
  if (currentYearMonth != null && currentYearMonth >= MF_MIN_YEARMONTH) {
    const currentData = extractTableData();
    for (const row of currentData) {
      if (!seenIds.has(row.id)) {
        seenIds.add(row.id);
        allRows.push(row);
      }
    }
  } else if (currentYearMonth != null) {
    console.log('MoneyForward: 表示月が対象外のため取得をスキップ', { 表示月: currentYearMonth, 最小対象: MF_MIN_YEARMONTH });
  }

  for (let i = 0; i < MF_MONTHS_TO_FETCH - 1; i++) {
    btnPrev.click();
    await waitForTableUpdate();
    const displayedYearMonth = getDisplayedYearMonth();
    if (displayedYearMonth != null && displayedYearMonth >= MF_MIN_YEARMONTH) {
      const monthData = extractTableData();
      for (const row of monthData) {
        if (!seenIds.has(row.id)) {
          seenIds.add(row.id);
          allRows.push(row);
        }
      }
    } else if (displayedYearMonth != null) {
      console.log('MoneyForward: 表示月が対象外のため取得をスキップ', { 表示月: displayedYearMonth, 最小対象: MF_MIN_YEARMONTH });
    }
  }

  const byCardType = {};
  for (const row of allRows) {
    const ct = row.cardType;
    if (!ct) continue;
    if (!byCardType[ct]) byCardType[ct] = [];
    byCardType[ct].push(row);
  }

  const batches = [];
  for (const [cardType, items] of Object.entries(byCardType)) {
    const instrument = {
      instrumentName: 'MF:' + cardType,
      instrumentType: 'CREDIT_CARD'
    };
    const apiItems = items.map((r) => ({
      externalId: 'mf:' + r.id,
      usedOn: r.usedOn,
      amount: r.amount
    }));
    batches.push(buildMfExpenseBatch(instrument, apiItems));
  }

  return { batches };
}
