const LOG_PREFIX = '[サイト巡回]';
const SITE_ID = 'x-bookmarks';
const MAX_POSTS_PER_RUN = 3;
const MAX_SCROLL_STEPS = 120;
const MAX_STALL_COUNT = 3;
const SCROLL_WAIT_MS = 1200;
const TWITTER_MEDIA_URL_PREFIX = 'https://pbs.twimg.com/media/';

async function collect_x_bookmarks(site = {}) {
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
    const visiblePosts = collectVisiblePosts();
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
  const posts = unprocessed.reverse().slice(0, MAX_POSTS_PER_RUN);

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

function collectVisiblePosts() {
  const elements = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  const tweetIdMap = new Map();
  for (const element of elements) {
    const tweetId = extractTweetId(element);
    if (tweetId) tweetIdMap.set(tweetId, element);
  }

  const posts = [];
  for (const element of elements) {
    const post = extractPost(element, tweetIdMap);
    if (post) posts.push(post);
  }
  return posts;
}

function extractPost(tweetElement, tweetIdMap = new Map()) {
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
    quotedPost: extractQuotedPost(tweetElement, tweetIdMap)
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
  const textElement = tweetElement.querySelector('[data-testid="tweetText"]');
  return (textElement?.innerText || textElement?.textContent || '').trim();
}

function extractAuthorInfo(tweetElement) {
  const userElement = tweetElement.querySelector('[data-testid="User-Name"]');
  const displayName = (userElement?.querySelector('span')?.innerText || userElement?.querySelector('span')?.textContent || '').trim();
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

  // TODO: X内記事カードのDOMを実ページで確認して精度を上げる。
  // 要件:
  // - X内記事が貼られている場合、その記事ページに遷移できるURLを取得する。
  // - 取得したURLはService Workerで別タブを開き、sites/x-article.jsで本文取得を試みる。
  // - 記事本文取得に失敗しても、ポスト本文・ポストURL・記事URLだけでChatGPT送信を続行する。
  // 実ページで確認する操作:
  // 1. XブックマークでX内記事カード付きポストを開く。
  // 2. 記事カードのa[href]、role、data-testid、aria-labelをDevToolsで確認する。
  // 3. /i/article/、/articles/、/compose/articles/ など実際のURL形式を確認する。
  // 4. 記事カードと通常の外部リンクカードを区別できる属性を確認する。
  for (const link of tweetElement.querySelectorAll('a[href]')) {
    const href = link.href || link.getAttribute('href') || '';
    if (!href) continue;
    if (!isXArticleUrl(href)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    urls.push(href);
  }
  return urls;
}

function extractQuotedPost(tweetElement, tweetIdMap) {
  // TODO: 引用ポストのDOMを実ページで確認して完全反映する。
  // 要件:
  // - 引用リツイートだった場合は引用元も取得する。
  // - 取得対象はURL、tweetId、本文、投稿者、投稿日時、画像URL。
  // - 引用元本文がDOMに展開されていれば本文まで取得する。
  // - 引用元本文がDOMに無くカードだけの場合はURLとtweetIdだけ返す。
  // - 引用ポスト内にさらに引用がある場合は、初期実装では1階層まででよい。
  // 実ページで確認する操作:
  // 1. Xブックマークで引用付きポストを開く。
  // 2. article[data-testid="tweet"] 内の引用カード要素をDevToolsで確認する。
  // 3. 引用元本文が [data-testid="tweetText"] として取得できるか確認する。
  // 4. 通常の外部カードやX内記事カードと引用カードを区別できる属性を確認する。
  const card = tweetElement.querySelector('[data-testid="card.wrapper"]');
  if (!card) return null;
  const link = card.querySelector('a[href*="/status/"]');
  const href = link?.getAttribute('href') || '';
  const match = href.match(/\/status\/(\d+)/);
  const tweetId = match?.[1] || null;
  if (!tweetId) return null;
  const url = href.startsWith('http') ? href : `https://x.com${href}`;
  const quotedElement = tweetIdMap.get(tweetId);
  if (!quotedElement || quotedElement === tweetElement) {
    return { tweetId, url, text: '', author: null, postedAt: null, imageUrls: [] };
  }
  return {
    tweetId,
    url,
    text: extractTweetText(quotedElement),
    author: extractAuthorInfo(quotedElement),
    postedAt: extractPostedAt(quotedElement),
    imageUrls: extractTweetImageUrls(quotedElement)
  };
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
    return isXHost && (/\/i\/article\//.test(u.pathname) || /\/articles\//.test(u.pathname) || /\/compose\/articles\//.test(u.pathname));
  } catch (_) {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
