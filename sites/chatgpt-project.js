const CHATGPT_PROJECT_LOG_PREFIX = '[サイト巡回] x-bookmarks chatgpt';
const INPUT_WAIT_MS = 10000;
const INPUT_POLL_MS = 300;
const IMAGE_PREVIEW_WAIT_MS = 3000;
const SEND_KEY_WAIT_MS = 2000;
const CONVERSATION_POLL_MS = 500;
const CONVERSATION_POLL_MAX_MS = 30000;
const MAX_IMAGE_ATTACH = 4;

async function collect_chatgpt_project(site = {}) {
  console.log(`${CHATGPT_PROJECT_LOG_PREFIX} 送信開始`);

  const payload = site.__chatgptPostPayload;
  if (!payload || !payload.prompt) {
    throw new Error('ChatGPT送信用payloadがありません');
  }

  try {
    const inputReady = await waitForChatgptInput(INPUT_WAIT_MS, INPUT_POLL_MS);
    if (!inputReady) {
      return { ok: false, error: 'ChatGPT入力欄の表示待ちがタイムアウトしました' };
    }

    const { attachedImageUrls, failedImageUrls } = await attachImages(payload.post?.imageUrls || []);

    const filled = await fillPrompt(payload.prompt);
    if (!filled) {
      return { ok: false, error: 'プロンプトの入力に失敗しました' };
    }

    const beforeHref = location.href;
    const beforeConvHrefs = collectConversationHrefs();

    const sent = await submitChatgptMessage(beforeConvHrefs);
    if (!sent) {
      return { ok: false, error: '送信操作に失敗しました' };
    }

    const conversationUrl = await waitForConversationUrl(beforeHref, beforeConvHrefs);
    if (!conversationUrl) {
      return { ok: false, error: 'conversation URL not found' };
    }

    const title = extractConversationTitle() || payload.fallbackTitle || null;

    console.log(`${CHATGPT_PROJECT_LOG_PREFIX} 送信成功 conversationUrl=${conversationUrl}`);
    return {
      ok: true,
      conversationUrl,
      title,
      attachedImageUrls,
      failedImageUrls
    };
  } catch (e) {
    console.warn(`${CHATGPT_PROJECT_LOG_PREFIX} 送信失敗`, e);
    return { ok: false, error: e.message || String(e) };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForChatgptInput(maxMs, pollMs) {
  return new Promise((resolve) => {
    const tryFind = () =>
      document.querySelector('#prompt-textarea') ||
      document.querySelector('.ProseMirror[contenteditable="true"]');

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

function getPromptElements() {
  const editable =
    document.querySelector('#prompt-textarea.ProseMirror') ||
    document.querySelector('.ProseMirror[contenteditable="true"]');
  const hidden = document.querySelector('textarea[name="prompt-textarea"]');
  return { editable, hidden };
}

async function fillPrompt(text) {
  const { editable, hidden } = getPromptElements();
  if (!editable) return false;

  editable.focus();

  if (document.execCommand) {
    try {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
    } catch (_) {
      editable.textContent = text;
    }
  } else {
    editable.textContent = text;
  }

  editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  if (hidden) {
    hidden.value = text;
    hidden.dispatchEvent(new Event('input', { bubbles: true }));
    hidden.dispatchEvent(new Event('change', { bubbles: true }));
  }

  return (editable.innerText || editable.textContent || '').trim().length > 0;
}

async function attachImages(imageUrls) {
  const urls = (imageUrls || []).filter((u) => /^https?:\/\//i.test(u)).slice(0, MAX_IMAGE_ATTACH);
  const attachedImageUrls = [];
  const failedImageUrls = [];

  if (urls.length === 0) return { attachedImageUrls, failedImageUrls };

  for (const imageUrl of urls) {
    try {
      const ok = await attachSingleImage(imageUrl);
      if (ok) attachedImageUrls.push(imageUrl);
      else failedImageUrls.push(imageUrl);
    } catch (_) {
      failedImageUrls.push(imageUrl);
    }
  }

  return { attachedImageUrls, failedImageUrls };
}

async function attachSingleImage(imageUrl) {
  const res = await fetch(imageUrl);
  if (!res.ok) return false;
  const blob = await res.blob();
  const ext = guessImageExtension(blob.type, imageUrl);
  const file = new File([blob], `x-image.${ext}`, { type: blob.type || 'image/jpeg' });

  let fileInput = document.querySelector('input#upload-files');
  if (!fileInput) {
    const plusBtn = document.querySelector('[data-testid="composer-plus-btn"]');
    if (plusBtn) plusBtn.click();
    await sleep(300);
    fileInput = document.querySelector('input#upload-files');
  }
  if (!fileInput) return false;

  const dt = new DataTransfer();
  dt.items.add(file);
  fileInput.files = dt.files;
  fileInput.dispatchEvent(new Event('change', { bubbles: true }));

  await sleep(IMAGE_PREVIEW_WAIT_MS);
  return hasImagePreview();
}

function guessImageExtension(mime, url) {
  if (mime?.includes('png')) return 'png';
  if (mime?.includes('webp')) return 'webp';
  if (mime?.includes('gif')) return 'gif';
  const m = url.match(/\.(jpe?g|png|webp|gif)(\?|$)/i);
  if (m) {
    const ext = m[1].toLowerCase();
    return ext === 'jpeg' ? 'jpg' : ext;
  }
  return 'jpg';
}

function hasImagePreview() {
  const composer = document.querySelector('[data-composer-surface="true"]') || document.body;
  return !!(
    composer.querySelector('img[src^="blob:"]') ||
    composer.querySelector('[data-testid*="attachment"]') ||
    composer.querySelector('[class*="attachment"] img')
  );
}

function isSubmitButton(btn) {
  const label = (btn.getAttribute('aria-label') || '').trim();
  if (!label) return false;
  if (/音声|voice|dictat/i.test(label)) return false;
  return /(送信|send|submit)/i.test(label);
}

function isPromptCleared(editable) {
  if (!editable) return false;
  const text = (editable.innerText || editable.textContent || '').trim();
  return text.length === 0;
}

function isSendingUiVisible() {
  return !!(
    document.querySelector('[data-testid="stop-button"]') ||
    document.querySelector('button[aria-label*="停止"]') ||
    document.querySelector('button[aria-label*="Stop"]')
  );
}

async function detectSendStarted(beforeConvHrefs) {
  const deadline = Date.now() + SEND_KEY_WAIT_MS;
  const { editable } = getPromptElements();

  while (Date.now() < deadline) {
    if (isPromptCleared(editable) || isSendingUiVisible()) return true;

    for (const a of document.querySelectorAll('a[href*="/c/"]')) {
      const href = normalizeHref(a.href || a.getAttribute('href') || '');
      if (href && /\/c\//.test(href) && !beforeConvHrefs.has(href)) return true;
    }

    if (/\/c\//.test(location.href)) return true;

    await sleep(200);
  }
  return false;
}

async function clickSubmitFallback() {
  for (const btn of document.querySelectorAll('button[aria-label]')) {
    if (!isSubmitButton(btn)) continue;
    btn.click();
    return true;
  }

  const formBtn = document.querySelector('form button[type="submit"]');
  if (formBtn) {
    formBtn.click();
    return true;
  }

  return false;
}

async function submitChatgptMessage(beforeConvHrefs) {
  const { editable } = getPromptElements();
  if (editable) {
    editable.focus();
    editable.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      })
    );
  }

  if (await detectSendStarted(beforeConvHrefs)) return true;

  return clickSubmitFallback();
}

function collectConversationHrefs() {
  const set = new Set();
  for (const a of document.querySelectorAll('a[href*="/c/"]')) {
    const href = a.href || a.getAttribute('href') || '';
    if (href) set.add(normalizeHref(href));
  }
  return set;
}

function normalizeHref(href) {
  try {
    return new URL(href, location.origin).href;
  } catch (_) {
    return href;
  }
}

async function waitForConversationUrl(beforeHref, beforeConvHrefs) {
  const deadline = Date.now() + CONVERSATION_POLL_MAX_MS;
  const normalizedBefore = normalizeHref(beforeHref);

  while (Date.now() < deadline) {
    const current = normalizeHref(location.href);
    if (current !== normalizedBefore && /\/c\//.test(current)) {
      return current;
    }

    for (const a of document.querySelectorAll('a[href*="/c/"]')) {
      const href = normalizeHref(a.href || a.getAttribute('href') || '');
      if (href && /\/c\//.test(href) && !beforeConvHrefs.has(href)) {
        return href.startsWith('http') ? href : new URL(href, location.origin).href;
      }
    }

    await sleep(CONVERSATION_POLL_MS);
  }

  return null;
}

function extractConversationTitle() {
  const fromDom =
    document.querySelector('[data-testid="conversation-title"]')?.textContent?.trim() ||
    document.querySelector('h1')?.textContent?.trim();
  if (fromDom) return fromDom;
  const docTitle = (document.title || '').trim();
  if (docTitle && !/^ChatGPT$/i.test(docTitle)) return docTitle;
  return null;
}
