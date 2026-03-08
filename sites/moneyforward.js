/**
 * MoneyForward ME カード明細抽出
 *
 * カードごと前月以降のカード明細を取得し、mf-import APIへ送信する。
 * API側の処理: externalIdで照合して保存されていないもののみ追加する。
 */

const MF_MONTHS_TO_FETCH = 2; // 当月 + 前月の2ヶ月分

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
 * MoneyForward明細をAPIに送信する
 *
 * @param {Object} instrument - 支払い手段情報
 * @param {string} instrument.instrumentName - 支払い手段名
 * @param {string} instrument.instrumentType - 'CREDIT_CARD' | 'BANK_ACCOUNT' | 'CASH'
 * @param {Array} items - 明細データ配列
 * @returns {Promise<Object>} APIレスポンス
 * @throws {Error} 設定がない場合、またはAPIエラー時
 */
async function sendMfExpenseLogs(instrument, items) {
  const { settings } = await chrome.storage.local.get('settings');
  const siteConfig = settings?.sites?.['moneyforward'];

  const requestBody = {
    instrument,
    items,
  };

  // モックモードの場合は fetch せず console.log で出力
  const mockMode = window.__COLLECT_MOCK_MODE__ === true;
  if (mockMode) {
    const mockLog = {
      url: siteConfig?.ifaApiUrl || '(URL未設定)',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer [REDACTED]',
      },
      body: requestBody
    };
    // Content Script のコンソールにも出力
    console.log('[Mock] Would POST to', mockLog.url, mockLog);
    // Service Worker のコンソールにも出力されるようにメッセージを送信
    try {
      chrome.runtime.sendMessage({
        type: 'MOCK_LOG',
        message: `[Mock] Would POST to ${mockLog.url}`,
        data: mockLog
      }).catch(() => {
        // Service Worker が応答しない場合（通常の実行時など）は無視
      });
    } catch (e) {
      // メッセージ送信に失敗した場合は無視
    }
    return { result: 'ok', mock: true };
  }

  // モックモードでない場合のみ環境変数をチェック
  if (!siteConfig?.ifaApiUrl) {
    throw new Error('IFA API URLが設定されていません。オプション画面で設定してください。');
  }
  if (!siteConfig?.ifaApiKey) {
    throw new Error('IFA API Keyが設定されていません。オプション画面で設定してください。');
  }

  const response = await fetch(siteConfig.ifaApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${siteConfig.ifaApiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'レスポンス取得失敗');
    if (response.status === 401) {
      throw new Error(`認証エラー: IFA API Keyが無効です (${response.status})`);
    }
    if (response.status === 400) {
      throw new Error(`リクエストエラー: ${errorText} (${response.status})`);
    }
    throw new Error(`IFA APIエラー: ${errorText} (${response.status})`);
  }

  const result = await response.json();

  if (result.result === 'partial') {
    console.warn('IFA API: 部分的に処理されました', result);
  }

  return result;
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
  const currentData = extractTableData();
  for (const row of currentData) {
    if (!seenIds.has(row.id)) {
      seenIds.add(row.id);
      allRows.push(row);
    }
  }

  for (let i = 0; i < MF_MONTHS_TO_FETCH - 1; i++) {
    btnPrev.click();
    await waitForTableUpdate();
    const monthData = extractTableData();
    for (const row of monthData) {
      if (!seenIds.has(row.id)) {
        seenIds.add(row.id);
        allRows.push(row);
      }
    }
  }

  const byCardType = {};
  for (const row of allRows) {
    const ct = row.cardType;
    if (!ct) continue;
    if (!byCardType[ct]) byCardType[ct] = [];
    byCardType[ct].push(row);
  }

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
    // 失敗時は throw して全体を失敗とする（共通 Slack 通知に載せるため）
    await sendMfExpenseLogs(instrument, apiItems);
  }
}
