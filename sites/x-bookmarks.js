/**
 * X ブックマーク一覧から未処理ポストを収集する（本命アダプタ）。
 *
 * 旧 Notion 連携実装は廃止済み。
 * Service Worker がタブ連携で ChatGPT Project / X 記事ページと組み合わせる前提。
 */

const LOG_PREFIX = '[サイト巡回]';
const SITE_ID = 'x-bookmarks';
const DEFAULT_MAX_POSTS_PER_RUN = 3;
const MAX_SCROLL_STEPS = 120;
const MAX_STALL_COUNT = 3;
const SCROLL_WAIT_MS = 1200;
/** 「さらに表示」クリック後の DOM 更新待ち */
const EXPAND_TEXT_WAIT_MS = 400;
const EXPAND_TEXT_MAX_ROUNDS = 8;
const TWITTER_MEDIA_URL_PREFIX = 'https://pbs.twimg.com/media/';

/**
 * オプションから1回の処理件数を取得する
 * @param {Object} [site] - サイト設定（オプション画面の値）
 * @returns {{ maxPostsPerRun: number }}
 */
function getXBookmarksOptions(site = {}) {
  const raw = site?.maxPostsPerRun;
  const maxPostsPerRun =
    raw !== '' && raw != null
      ? Math.max(1, Math.min(10, parseInt(String(raw), 10) || DEFAULT_MAX_POSTS_PER_RUN))
      : DEFAULT_MAX_POSTS_PER_RUN;
  return { maxPostsPerRun };
}

async function collect_x_bookmarks(site = {}) {
  const { maxPostsPerRun } = getXBookmarksOptions(site);
  console.log(`${LOG_PREFIX} ${SITE_ID} 取得開始`);

  const processedTweetIds = site.processedTweetIds || {};
  const processedSet = new Set(Object.keys(processedTweetIds));
  const collected = new Map();
  const visibleOrder = [];
  let reachedProcessedPost = false;
  let reachedScrollEnd = false;

  let stallCount = 0;
  let prevScrollY = -1;
  let prevScrollHeight = -1;
  let prevTweetCount = 0;

  for (let step = 0; step < MAX_SCROLL_STEPS; step++) {
    const visiblePosts = await collectVisiblePosts();
    for (const post of visiblePosts) {
      if (!post.tweetId) continue;
      if (!collected.has(post.tweetId)) {
        collected.set(post.tweetId, post);
        visibleOrder.push(post.tweetId);
      }
      if (processedSet.has(post.tweetId)) {
        reachedProcessedPost = true;
      }
    }

    if (reachedProcessedPost) {
      console.log(`${LOG_PREFIX} ${SITE_ID} 処理済みポスト検出 scrollStep=${step}`);
      break;
    }

    window.scrollTo(0, document.body.scrollHeight);
    await sleep(SCROLL_WAIT_MS);

    const currentScrollY = window.scrollY;
    const currentScrollHeight = document.body.scrollHeight;
    const currentTweetCount = collected.size;
    const scrollNotMoved = Math.abs(currentScrollY - prevScrollY) < 10;
    const heightNotChanged = Math.abs(currentScrollHeight - prevScrollHeight) < 10;
    const tweetsNotIncreased = currentTweetCount === prevTweetCount;

    if (scrollNotMoved && heightNotChanged && tweetsNotIncreased) {
      stallCount += 1;
    } else {
      stallCount = 0;
    }

    console.log(`${LOG_PREFIX} ${SITE_ID} スクロール ${step + 1}/${MAX_SCROLL_STEPS} 収集=${currentTweetCount} stall=${stallCount}`);

    if (stallCount >= MAX_STALL_COUNT) {
      reachedScrollEnd = true;
      console.log(`${LOG_PREFIX} ${SITE_ID} これ以上スクロールできないと判定`);
      break;
    }

    prevScrollY = currentScrollY;
    prevScrollHeight = currentScrollHeight;
    prevTweetCount = currentTweetCount;
  }

  const orderedPosts = visibleOrder.map((tweetId) => collected.get(tweetId)).filter(Boolean);
  const unprocessed = orderedPosts.filter((post) => !processedSet.has(post.tweetId));
  const posts = unprocessed.reverse().slice(0, maxPostsPerRun);

  const mockLabel = window.__COLLECT_MOCK_MODE__ === true ? ' モック' : '';
  console.log(`${LOG_PREFIX} ${SITE_ID} 完了 収集=${collected.size} 未処理=${unprocessed.length} 処理対象=${posts.length}${mockLabel}`);

  return {
    posts,
    reachedProcessedPost,
    reachedScrollEnd,
    scrollStepsLimit: MAX_SCROLL_STEPS,
    collectedCount: collected.size,
    unprocessedCount: unprocessed.length
  };
}

async function collectVisiblePosts() {
  const elements = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));

  for (const element of elements) {
    if (findShowMoreButtonsInElement(element).length > 0) {
      await expandTweetTextInElement(element);
    }
  }

  const tweetIdMap = new Map();
  for (const element of elements) {
    const tweetId = extractTweetId(element);
    if (tweetId) tweetIdMap.set(tweetId, element);
  }

  const posts = [];
  for (const element of elements) {
    const post = await extractPost(element, tweetIdMap);
    if (post) posts.push(post);
  }
  return posts;
}

/**
 * ポスト本文の「さらに表示」をクリックして全文を展開する
 * @param {Element} tweetElement - article[data-testid="tweet"]
 */
async function expandTweetTextInElement(tweetElement) {
  if (!tweetElement) return;

  let expandedTotal = 0;
  for (let round = 0; round < EXPAND_TEXT_MAX_ROUNDS; round++) {
    const buttons = findShowMoreButtonsInElement(tweetElement);
    if (buttons.length === 0) break;
    expandedTotal += buttons.length;

    for (const btn of buttons) {
      try {
        btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        btn.click();
      } catch (_) {}
    }

    await sleep(EXPAND_TEXT_WAIT_MS);
  }

  if (expandedTotal > 0) {
    const tweetId = extractTweetId(tweetElement);
    console.log(
      `${LOG_PREFIX} ${SITE_ID} さらに表示を展開 tweetId=${tweetId || '?'} clicks=${expandedTotal}`
    );
  }
}

/**
 * @param {Element} root
 * @returns {HTMLElement[]}
 */
function findShowMoreButtonsInElement(root) {
  const buttons = [];
  const seen = new Set();

  const add = (el) => {
    if (!el || seen.has(el)) return;
    if (!root.contains(el)) return;
    seen.add(el);
    buttons.push(el);
  };

  for (const el of root.querySelectorAll('[data-testid="tweet-text-show-more-link"]')) {
    add(el);
  }

  for (const textEl of root.querySelectorAll('[data-testid="tweetText"]')) {
    const parent = textEl.parentElement;
    if (!parent) continue;
    for (const btn of parent.querySelectorAll('button[role="button"]')) {
      const label = (btn.innerText || btn.textContent || '').trim();
      if (isShowMoreLabel(label)) add(btn);
    }
  }

  return buttons;
}

function isShowMoreLabel(text) {
  const t = (text || '').trim();
  if (!t) return false;
  if (t === 'さらに表示' || t === 'もっと表示') return true;
  return /^show\s*more$/i.test(t);
}

/**
 * メインポストの tweetText（引用カード内の本文は除外）
 * @param {Element} tweetElement
 * @returns {Element|null}
 */
function getMainTweetTextElement(tweetElement) {
  const quoteRoot = findQuoteLabelContainer(tweetElement);
  const all = tweetElement.querySelectorAll('[data-testid="tweetText"]');
  for (const el of all) {
    if (quoteRoot && quoteRoot.contains(el)) continue;
    return el;
  }
  return all[0] || null;
}

async function extractPost(tweetElement, tweetIdMap = new Map()) {
  const tweetId = extractTweetId(tweetElement);
  if (!tweetId) return null;
  return {
    tweetId,
    url: extractTweetUrl(tweetElement, tweetId),
    text: extractTweetText(tweetElement),
    author: extractAuthorInfo(tweetElement),
    postedAt: extractPostedAt(tweetElement),
    imageUrls: extractTweetImageUrls(tweetElement),
    externalLinks: extractExternalLinks(tweetElement),
    xArticleUrls: extractXArticleUrls(tweetElement),
    quotedPost: await extractQuotedPost(tweetElement, tweetIdMap)
  };
}

function extractTweetId(tweetElement) {
  const links = tweetElement.querySelectorAll('a[href*="/status/"]');
  for (const link of links) {
    const href = link.getAttribute('href') || '';
    const match = href.match(/\/status\/(\d+)/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractTweetUrl(tweetElement, tweetId) {
  const screenName = extractScreenName(tweetElement);
  if (screenName) return `https://x.com/${screenName}/status/${tweetId}`;
  return `https://x.com/i/web/status/${tweetId}`;
}

function extractTweetText(tweetElement) {
  const textElement = getMainTweetTextElement(tweetElement);
  return (textElement?.innerText || textElement?.textContent || '').trim();
}

function extractAuthorInfo(tweetElement) {
  const userElement = tweetElement.querySelector('[data-testid="User-Name"]');
  const displayName = (
    userElement?.querySelector('span')?.innerText ||
    userElement?.querySelector('span')?.textContent ||
    ''
  ).trim();
  const screenName = extractScreenName(tweetElement) || '';
  return { displayName, screenName };
}

function extractScreenName(tweetElement) {
  const userElement = tweetElement.querySelector('[data-testid="User-Name"]');
  const links = userElement ? userElement.querySelectorAll('a[href^="/"]') : tweetElement.querySelectorAll('a[href^="/"]');
  for (const link of links) {
    const href = link.getAttribute('href') || '';
    const text = link.innerText || link.textContent || '';
    const match = href.match(/^\/([^\/]+)$/);
    if (match?.[1] && !match[1].includes('status') && (text.includes('@') || userElement)) {
      return match[1];
    }
  }
  return null;
}

function extractPostedAt(tweetElement) {
  const datetime = tweetElement.querySelector('time[datetime]')?.getAttribute('datetime') || null;
  if (!datetime) return null;
  const d = new Date(datetime);
  return Number.isNaN(d.getTime()) ? null : datetime;
}

function extractTweetImageUrls(tweetElement) {
  const urls = [];
  const seen = new Set();
  const avatar = tweetElement.querySelector('[data-testid="UserAvatar"]');
  for (const img of tweetElement.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (!src) continue;
    if (avatar && avatar.contains(img)) continue;
    if (src.includes('profile_images') || src.includes('profile_banners')) continue;
    if (!src.startsWith(TWITTER_MEDIA_URL_PREFIX)) continue;
    if (seen.has(src)) continue;
    seen.add(src);
    urls.push(src);
  }
  return urls;
}

function extractExternalLinks(tweetElement) {
  const urls = [];
  const seen = new Set();
  for (const link of tweetElement.querySelectorAll('a[href]')) {
    const href = link.href || link.getAttribute('href') || '';
    if (!href) continue;
    if (isXInternalUrl(href)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    urls.push(href);
  }
  return urls;
}

function extractXArticleUrls(tweetElement) {
  const urls = [];
  const seen = new Set();

  for (const link of tweetElement.querySelectorAll('a[href]')) {
    const href = link.href || link.getAttribute('href') || '';
    if (!href) continue;
    if (!isXArticleUrl(href)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    urls.push(href);
  }

  if (urls.length === 0 && tweetElement.querySelector('[data-testid="article-cover-image"]')) {
    const screenName = extractScreenName(tweetElement);
    const tweetId = extractTweetId(tweetElement);
    if (screenName && tweetId) {
      const built = `https://x.com/${screenName}/article/${tweetId}`;
      if (!seen.has(built)) urls.push(built);
    }
  }

  return urls;
}

async function extractQuotedPost(tweetElement, tweetIdMap) {
  const quoteLabelContainer = findQuoteLabelContainer(tweetElement);
  const fromQuoteUi = await extractQuotedPostFromQuoteUi(tweetElement, tweetIdMap, quoteLabelContainer);
  if (fromQuoteUi) return fromQuoteUi;

  const fromCard = await extractQuotedPostFromCardWrapper(tweetElement, tweetIdMap, quoteLabelContainer);
  if (fromCard) return fromCard;

  return null;
}

function isQuoteLabelText(text) {
  const t = (text || '').trim();
  if (t === '引用') return true;
  return /^quote$/i.test(t);
}

function findQuoteLabelContainer(tweetElement) {
  return findQuoteRootFromLabel(tweetElement);
}

function findQuoteRootFromLabel(tweetElement) {
  const mainTweetText = tweetElement.querySelector('[data-testid="tweetText"]');
  for (const span of tweetElement.querySelectorAll('span')) {
    if (!isQuoteLabelText(span.textContent)) continue;
    let el = span.parentElement;
    while (el && el !== tweetElement) {
      const hasLink = el.querySelector('[role="link"]');
      const hasTweetText = el.querySelector('[data-testid="tweetText"]');
      if (hasLink && hasTweetText && !(mainTweetText && el.contains(mainTweetText))) {
        return el;
      }
      el = el.parentElement;
    }
  }
  return null;
}

function extractTweetIdFromQuoteRoot(quoteRoot, tweetIdMap) {
  for (const link of quoteRoot.querySelectorAll('a[href*="/status/"]')) {
    const href = link.getAttribute('href') || '';
    const match = href.match(/\/status\/(\d+)/);
    if (match?.[1]) return match[1];
  }

  const textEl = quoteRoot.querySelector('[data-testid="tweetText"]');
  const text = textEl?.innerText || textEl?.textContent || '';
  const urlMatch = text.match(/(?:x\.com|twitter\.com)\/([^/?#\s]+)\/status\/(\d+)/i);
  if (urlMatch?.[2]) {
    const fromMap = tweetIdMap.get(urlMatch[2]);
    if (fromMap && fromMap !== quoteRoot) return urlMatch[2];
    return urlMatch[2];
  }

  return null;
}

async function buildQuotedPostFromRoot(quoteRoot, tweetId, tweetIdMap, tweetElement) {
  const quotedElement = tweetId ? tweetIdMap.get(tweetId) : null;
  const source =
    quotedElement && quotedElement !== tweetElement ? quotedElement : quoteRoot;

  await expandTweetTextInElement(source);

  const text =
    source.matches && source.matches('article[data-testid="tweet"]')
      ? extractTweetText(source)
      : extractTweetTextFromRoot(source);
  const author = extractAuthorInfo(source);
  if (!tweetId && !text && !author?.displayName && !author?.screenName) return null;

  const screenName = extractScreenName(source) || author?.screenName || null;
  const url = tweetId
    ? screenName
      ? `https://x.com/${screenName}/status/${tweetId}`
      : `https://x.com/i/web/status/${tweetId}`
    : null;

  return {
    tweetId: tweetId || null,
    url,
    text,
    author: author?.displayName || author?.screenName ? author : null,
    postedAt: extractPostedAt(source),
    imageUrls: extractTweetImageUrls(source),
    externalLinks: extractExternalLinks(source),
    xArticleUrls: extractXArticleUrls(source)
  };
}

async function extractQuotedPostFromQuoteUi(tweetElement, tweetIdMap, quoteLabelContainer) {
  const quoteRoot = findQuoteRootFromLabel(tweetElement);
  if (!quoteRoot) return null;
  const tweetId = extractTweetIdFromQuoteRoot(quoteRoot, tweetIdMap);
  return buildQuotedPostFromRoot(quoteRoot, tweetId, tweetIdMap, tweetElement);
}

async function extractQuotedPostFromCardWrapper(tweetElement, tweetIdMap, quoteLabelContainer) {
  const cards = tweetElement.querySelectorAll('[data-testid="card.wrapper"]');
  for (const card of cards) {
    if (quoteLabelContainer && quoteLabelContainer.contains(card)) continue;
    const statusLink = card.querySelector('a[href*="/status/"]');
    if (!statusLink) continue;

    const href = statusLink.getAttribute('href') || '';
    const match = href.match(/\/status\/(\d+)/);
    const tweetId = match?.[1] || null;
    if (!tweetId) continue;

    const fallbackUrl = href.startsWith('http') ? href : `https://x.com${href}`;
    const quotedElement = tweetIdMap.get(tweetId);
    if (!quotedElement || quotedElement === tweetElement) {
      await expandTweetTextInElement(card);
      const textFromCard = extractTweetTextFromRoot(card);
      return {
        tweetId,
        url: fallbackUrl,
        text: textFromCard,
        author: null,
        postedAt: null,
        imageUrls: [],
        externalLinks: [],
        xArticleUrls: []
      };
    }
    await expandTweetTextInElement(quotedElement);
    return {
      tweetId,
      url: extractTweetUrl(quotedElement, tweetId),
      text: extractTweetText(quotedElement),
      author: extractAuthorInfo(quotedElement),
      postedAt: extractPostedAt(quotedElement),
      imageUrls: extractTweetImageUrls(quotedElement),
      externalLinks: extractExternalLinks(quotedElement),
      xArticleUrls: extractXArticleUrls(quotedElement)
    };
  }
  return null;
}

/** 引用カード等、article 以外のルートから本文を取る */
function extractTweetTextFromRoot(root) {
  const textEl = root.querySelector('[data-testid="tweetText"]');
  return (textEl?.innerText || textEl?.textContent || '').trim();
}

function isXInternalUrl(url) {
  try {
    const u = new URL(url, location.href);
    return ['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'].includes(u.hostname);
  } catch (_) {
    return false;
  }
}

function isXArticleUrl(url) {
  try {
    const u = new URL(url, location.href);
    const isXHost = ['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'].includes(u.hostname);
    if (!isXHost) return false;
    if (/\/i\/article\//.test(u.pathname)) return true;
    if (/\/articles\//.test(u.pathname)) return true;
    if (/\/compose\/articles\//.test(u.pathname)) return true;
    return /^\/[^/]+\/article\/\d+/.test(u.pathname);
  } catch (_) {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
