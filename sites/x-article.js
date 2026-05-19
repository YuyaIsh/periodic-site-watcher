const X_ARTICLE_LOG_PREFIX = '[サイト巡回] x-bookmarks article';
const ARTICLE_WAIT_MS = 15000;
const ARTICLE_POLL_MS = 500;

async function collect_x_article(_site = {}) {
  const url = window.location.href;
  console.log(`${X_ARTICLE_LOG_PREFIX} 取得開始 url=${url}`);

  try {
    const root =
      (await waitForElement(
        '[data-testid="twitterArticleReadView"], [data-testid="twitter-article-title"]',
        ARTICLE_WAIT_MS,
        ARTICLE_POLL_MS
      )) || null;

    if (!root) {
      return { ok: false, url, error: '記事本文の表示待ちがタイムアウトしました' };
    }

    const readView = document.querySelector('[data-testid="twitterArticleReadView"]');
    const titleEl =
      document.querySelector('[data-testid="twitter-article-title"]') ||
      readView?.querySelector('[data-testid="twitter-article-title"]');
    const title = (titleEl?.innerText || titleEl?.textContent || '').trim();

    const richText = document.querySelector('[data-testid="twitterArticleRichTextView"]');
    const bodyParts = [];
    if (richText) {
      for (const span of richText.querySelectorAll('span[data-text="true"]')) {
        const part = (span.textContent || '').trim();
        if (part) bodyParts.push(part);
      }
    }
    const bodyText = bodyParts.join('\n\n');

    const authorEl =
      readView?.querySelector('[data-testid="User-Name"]') ||
      document.querySelector('[data-testid="User-Name"]');
    const author = extractArticleAuthor(authorEl);

    const publishedAt = extractArticlePublishedAt(readView || root);

    if (!title && !bodyText) {
      return { ok: false, url, error: '記事タイトル・本文を取得できませんでした' };
    }

    console.log(`${X_ARTICLE_LOG_PREFIX} 取得成功 title=${title.slice(0, 60)} bodyLen=${bodyText.length}`);
    return {
      ok: true,
      url,
      title: title || null,
      bodyText: bodyText || null,
      author,
      publishedAt
    };
  } catch (e) {
    console.warn(`${X_ARTICLE_LOG_PREFIX} 取得失敗`, e);
    return { ok: false, url, error: e.message || String(e) };
  }
}

function extractArticleAuthor(userElement) {
  if (!userElement) return null;
  const displayName = (
    userElement.querySelector('span')?.innerText ||
    userElement.querySelector('span')?.textContent ||
    ''
  ).trim();
  let screenName = '';
  for (const link of userElement.querySelectorAll('a[href^="/"]')) {
    const href = link.getAttribute('href') || '';
    const match = href.match(/^\/([^/]+)$/);
    if (match?.[1] && !match[1].includes('status')) {
      screenName = match[1];
      break;
    }
  }
  if (!displayName && !screenName) return null;
  return { displayName, screenName };
}

function extractArticlePublishedAt(scope) {
  const searchRoot = scope || document;
  const header =
    searchRoot.querySelector('[data-testid="twitter-article-title"]')?.closest('article') ||
    searchRoot.closest('article') ||
    searchRoot;
  const timeEl = header.querySelector('time[datetime]') || searchRoot.querySelector('time[datetime]');
  const datetime = timeEl?.getAttribute('datetime') || null;
  if (!datetime) return null;
  const d = new Date(datetime);
  return Number.isNaN(d.getTime()) ? null : datetime;
}

function waitForElement(selector, maxMs, pollMs) {
  return new Promise((resolve) => {
    const tryFind = () => document.querySelector(selector);

    const existing = tryFind();
    if (existing) {
      resolve(existing);
      return;
    }

    let settled = false;
    const finish = (el) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearInterval(intervalId);
      clearTimeout(timeoutId);
      resolve(el || null);
    };

    const observer = new MutationObserver(() => {
      const el = tryFind();
      if (el) finish(el);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    const intervalId = setInterval(() => {
      const el = tryFind();
      if (el) finish(el);
    }, pollMs);

    const timeoutId = setTimeout(() => finish(tryFind()), maxMs);
  });
}
