/**
 * 外部 API エンドポイント URL（コード固定）
 */

const EXTERNAL_API_BASE = 'https://ishima-family-app.vercel.app/api/external';

/** @readonly */
const EXTERNAL_API_URLS = Object.freeze({
  STATEMENT_IMPORT: `${EXTERNAL_API_BASE}/statement-import`,
  HOUSEHOLD_STATEMENT_IMPORT: `${EXTERNAL_API_BASE}/household-statement-import`,
  BALANCE_SNAPSHOT: `${EXTERNAL_API_BASE}/balance-snapshot`,
  PAYMENT_SCHEDULE: `${EXTERNAL_API_BASE}/payment-schedule`
});
