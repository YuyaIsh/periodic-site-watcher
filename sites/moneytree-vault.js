/**
 * Moneytree Vault クレジットカード支払予定抽出
 */

const SITE_ID = 'moneytree-vault';
const EXCLUDED_ACCOUNT_NAMES = new Set(['楽天カード(Visa)']);

/**
 * @returns {string} YYYY-MM (JST)
 */
function getCurrentTargetMonthJst() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit'
  }).format(new Date());
}

/**
 * @param {string} raw
 * @returns {number}
 */
function parseDisplayAmount(raw) {
  const text = (raw || '').trim();
  if (!text) return 0;
  const normalized = text.replace(/[¥,\s]/g, '');
  const n = parseInt(normalized, 10);
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

/**
 * @param {string} name
 * @param {number} amount
 * @returns {boolean}
 */
function shouldExcludeAccount(name, amount) {
  if (amount === 0) return true;
  if (EXCLUDED_ACCOUNT_NAMES.has(name)) return true;
  return false;
}

/**
 * クレジットカードセクションを展開し、口座行の描画を待つ
 */
async function ensureCreditCardSectionExpanded() {
  const header = document.querySelector('a[data-test-id="vault-institution-type-credit_card"]');
  if (!header) {
    throw new Error(`${SITE_ID}: クレジットカードセクションが見つかりません`);
  }
  if (!header.classList.contains('active')) {
    header.click();
  }

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const root = getCreditCardSectionRoot();
    const count = root ? root.querySelectorAll('.credential-accounts .mt-account').length : 0;
    if (count > 0) {
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * @returns {HTMLElement|null}
 */
function getCreditCardSectionRoot() {
  const header = document.querySelector('a[data-test-id="vault-institution-type-credit_card"]');
  if (!header) return null;
  const li = header.closest('li');
  return li;
}

/**
 * @returns {Promise<Array<{ targetMonth: string, name: string, paymentType: 'CARD', amount: number }>>}
 */
async function extractCreditCardPaymentItemsAsync() {
  await ensureCreditCardSectionExpanded();
  const root = getCreditCardSectionRoot();
  if (!root) {
    throw new Error(`${SITE_ID}: クレジットカードセクションのルートが見つかりません`);
  }

  const targetMonth = getCurrentTargetMonthJst();
  const items = [];
  const accounts = root.querySelectorAll('.credential-accounts .mt-account');

  for (const accountEl of accounts) {
    const name = (accountEl.querySelector('.display-name')?.textContent || '').trim();
    const amountRaw = accountEl.querySelector('.display-amount-balance')?.textContent || '';
    const amount = parseDisplayAmount(amountRaw);

    if (!name) continue;
    if (shouldExcludeAccount(name, amount)) {
      continue;
    }

    items.push({
      targetMonth,
      name,
      paymentType: 'CARD',
      amount
    });
  }

  return items;
}

async function collect_moneytree_vault(_site = {}) {
  const items = await extractCreditCardPaymentItemsAsync();
  return { items };
}

if (typeof window !== 'undefined') {
  window.collect_moneytree_vault = collect_moneytree_vault;
}
