'use strict';

const express = require('express');
const cors    = require('cors');
const puppeteer = require('puppeteer');
const { URL } = require('url');

const app = express();
app.use(cors());
app.use(express.json());

// ===================================================
// 定数
// ===================================================
const MAX_CONCURRENT  = 3;
const PDF_TIMEOUT_MS  = 90_000;   // 90秒
const SCROLL_TIMEOUT  = 10_000;   // 10秒
const GOTO_TIMEOUT    = 30_000;   // 30秒（networkidle2 / フォールバック用）

// 同時リクエスト数のカウンター
let activeRequests = 0;

// ===================================================
// 🔒 SSRFリスク対策: URLの安全チェック
//   - IPv4 プライベート／ループバック
//   - IPv6 ループバック・リンクローカル・IPv4マップドアドレス
//   - クラウドメタデータエンドポイント
// ===================================================
const BLOCKED_HOSTNAME_PATTERNS = [
    // IPv4
    /^localhost$/i,
    /^127\./,
    /^0\.0\.0\.0$/,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^169\.254\./,                      // リンクローカル (APIPA)

    // IPv6（括弧除去後）
    /^::1$/,                            // ループバック
    /^fe80:/i,                          // リンクローカル
    /^fc00:/i,                          // ユニークローカル
    /^fd[0-9a-f]{2}:/i,                 // ユニークローカル
    /^::ffff:127\./i,                   // IPv4マップドループバック
    /^::ffff:10\./i,                    // IPv4マップドプライベート
    /^::ffff:192\.168\./i,
    /^::ffff:172\.(1[6-9]|2\d|3[01])\./i,
    /^::ffff:169\.254\./i,

    // クラウドメタデータ
    /^metadata\.google\.internal$/i,    // GCP
    /^169\.254\.169\.254$/,             // AWS / Azure IMDSv1
];

function isSafeUrl(urlString) {
    try {
        const parsed = new URL(urlString);

        // http / https のみ許可
        if (!['http:', 'https:'].includes(parsed.protocol)) return false;

        // IPv6アドレスの括弧を除去して正規化
        const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();

        return !BLOCKED_HOSTNAME_PATTERNS.some(pattern => pattern.test(host));
    } catch {
        return false;
    }
}

// ===================================================
// 🖱️ 無限スクロール対策つき自動スクロール関数
// ===================================================
async function autoScroll(page) {
    await page.evaluate(async (maxTime) => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 100;
            const start    = Date.now();

            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;

                const reachedBottom = totalHeight >= scrollHeight - window.innerHeight;
                const timedOut      = Date.now() - start > maxTime;

                if (reachedBottom || timedOut) {
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
        });
    }, SCROLL_TIMEOUT);
}

// ===================================================
// 🛡️ HTML文字列のエスケープ（XSS対策）
// ===================================================
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ===================================================
// 📄 PDF生成の本体処理
//   - タイムアウトは必ず finally でクリア
//   - ブラウザは必ず finally でクローズ
// ===================================================
async function generatePdf(targetUrl) {
    let browser   = null;
    let timeoutId = null;

    try {
        // --------- タイムアウト用 Promise ---------
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(
                () => reject(new Error(`PDF生成が${PDF_TIMEOUT_MS / 1000}秒を超えたためタイムアウトしました。`)),
                PDF_TIMEOUT_MS
            );
        });

        // --------- PDF生成タスク ---------
        const pdfTask = async () => {
            browser = await puppeteer.launch({
                headless: true,
                // ⚠️ 本番環境では root ユーザー以外で実行することを推奨
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                ]
            });

            const page = await browser.newPage();
            await page.setViewport({ width: 1200, height: 800 });

            // ---- ページ取得（networkidle2 失敗時は domcontentloaded にフォールバック）----
            console.log(`[PDF] ページ取得中: ${targetUrl}`);
            try {
                await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: GOTO_TIMEOUT });
            } catch (e) {
                console.warn('[PDF] networkidle2 タイムアウト。domcontentloaded で再試行します...');
                await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT });
            }

            // ---- スクロールで遅延読み込み画像を展開 ----
            console.log('[PDF] 自動スクロール中...');
            await autoScroll(page);
            await page.evaluate(() => window.scrollTo(0, 0));
            await new Promise(r => setTimeout(r, 2000));

            // ---- 印刷用CSSの注入 ----
            await page.addStyleTag({
                content: `
                    @media print {
                        p, li, blockquote, figure, table, tr, img, pre, code,
                        .wp-block-image, .wp-block-group {
                            page-break-inside: avoid !important;
                            break-inside:      avoid !important;
                        }
                        h1, h2, h3, h4, h5, h6 {
                            page-break-after:  avoid !important;
                            break-after:       avoid !important;
                            page-break-inside: avoid !important;
                            break-inside:      avoid !important;
                        }
                        p, li {
                            orphans: 2 !important;
                            widows:  2 !important;
                        }
                        * {
                            max-width:        100% !important;
                            overflow-wrap:    break-word !important;
                            word-wrap:        break-word !important;
                            word-break:       break-word !important;
                        }
                        table {
                            width:        100% !important;
                            max-width:    100% !important;
                            table-layout: fixed !important;
                        }
                    }
                `
            });

            // ---- DOM整形 ----
            // ※ page.evaluate 内は Puppeteer サンドボックス外なので
            //    escapeHtml を文字列として渡して再定義する
            await page.evaluate((escapeHtmlSrc) => {
                // eslint-disable-next-line no-eval
                const escapeHtml = eval(`(${escapeHtmlSrc})`);

                // fixed / sticky 要素を static に変換
                document.querySelectorAll('*').forEach(el => {
                    const pos = window.getComputedStyle(el).position;
                    if (pos === 'fixed' || pos === 'sticky') {
                        el.style.setProperty('position', 'static', 'important');
                    }
                });

                // 不要な要素を削除
                const killSelectors = [
                    'header', 'footer', 'aside', 'nav',
                    '[class*="footer" i]', '[id*="footer" i]', '#colophon',
                    '[class*="sidebar" i]', '[id*="sidebar" i]', '.widget-area', '[class*="widget" i]',
                    '[class*="banner" i]', '[id*="banner" i]',
                    '[class*="ads" i]', '.adsbygoogle', '[class*="advert" i]', '[class*="sponsor" i]',
                    '[class*="comment" i]', '[id*="comment" i]',
                    '[class*="share" i]', '[class*="social" i]', '[class*="sns" i]',
                    '[class*="related" i]', '[class*="pagination" i]',
                    '[class*="author" i]', '[class*="popup" i]', '[class*="modal" i]', '[class*="overlay" i]'
                ].join(',');

                document.querySelectorAll(killSelectors).forEach(el => {
                    const tag = el.tagName.toLowerCase();
                    const id  = (el.id || '').toLowerCase();
                    const cls = typeof el.className === 'string' ? el.className.toLowerCase() : '';

                    // 本文コンテナは保護
                    if (
                        ['body', 'html', 'main', 'article'].includes(tag) ||
                        ['content', 'main', 'page'].includes(id)          ||
                        cls.includes('site-main')                          ||
                        cls.includes('entry-content')                      ||
                        cls.includes('post-content')
                    ) return;

                    el.remove();
                });

                // 動画を URL テキストに置換（XSS対策: innerHTML 不使用）
                document.querySelectorAll('iframe[src*="youtube"], iframe[src*="vimeo"], video').forEach(vid => {
                    const rawUrl = vid.src || vid.currentSrc || 'URL不明';

                    const wrapper = document.createElement('div');
                    wrapper.style.cssText = 'padding:10px;border:1px solid #ccc;background:#f9f9f9;margin-bottom:10px;';

                    const label = document.createElement('strong');
                    label.textContent = '【動画】';

                    const urlSpan = document.createElement('span');
                    urlSpan.style.wordBreak = 'break-all';
                    urlSpan.textContent = rawUrl; // textContent でエスケープ済み

                    wrapper.appendChild(label);
                    wrapper.appendChild(document.createElement('br'));
                    wrapper.appendChild(urlSpan);

                    vid.parentNode.replaceChild(wrapper, vid);
                });

                // 画像のサイズ制限と URL 表示
                document.querySelectorAll('img').forEach(img => {
                    if (img.width < 50 || img.height < 50) return;

                    img.style.setProperty('max-width', '40%',   'important');
                    img.style.setProperty('width',     'auto',   'important');
                    img.style.setProperty('height',    'auto',   'important');
                    img.style.setProperty('display',   'block',  'important');

                    const rawUrl = img.src || img.getAttribute('data-src');
                    if (!rawUrl) return;

                    const urlDiv = document.createElement('div');
                    urlDiv.style.cssText = 'font-size:10px;color:#555;word-break:break-all;margin-top:2px;margin-bottom:15px;';
                    urlDiv.textContent = `画像URL: ${rawUrl}`; // textContent でエスケープ済み

                    const anchor = img.parentNode?.tagName?.toLowerCase() === 'a' ? img.parentNode : img;
                    anchor.parentNode?.insertBefore(urlDiv, anchor.nextSibling);
                });

            }, escapeHtml.toString()); // escapeHtml を文字列として渡す（今回は textContent で代替済み）

            // ---- フォント待機 ----
            console.log('[PDF] フォント読み込み待機中...');
            await page.evaluateHandle('document.fonts.ready');
            await new Promise(r => setTimeout(r, 1000));

            // ---- ページタイトル取得・サニタイズ ----
            let pageTitle = (await page.title()) || 'document';
            pageTitle = pageTitle
                .replace(/[\\/:*?"<>|]/g, '_')
                .replace(/\s+/g, ' ')
                .trim()
                .substring(0, 50);

            // ---- PDF生成 ----
            await page.emulateMediaType('screen');
            console.log('[PDF] PDF生成中...');
            const pdfBuffer = await page.pdf({
                format: 'A4',
                printBackground: true,
                margin: { top: '15mm', right: '15mm', bottom: '15mm', left: '15mm' }
            });

            return { pdfBuffer, pageTitle };
        };

        // タイムアウトと PDF タスクを競合させる
        // ★ Promise.race はここ（generatePdf 内）に置く
        //    → finally が必ず実行されブラウザが確実にクローズされる
        return await Promise.race([pdfTask(), timeoutPromise]);

    } finally {
        // タイムアウトタイマーを必ずクリア
        if (timeoutId) clearTimeout(timeoutId);
        // ブラウザを必ずクローズ（エラー・タイムアウト問わず）
        if (browser) {
            console.log('[PDF] ブラウザを終了します...');
            await browser.close().catch(e => console.error('[PDF] ブラウザ終了エラー:', e.message));
        }
    }
}

// ===================================================
// ❤️ ヘルスチェックエンドポイント
// ===================================================
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', activeRequests });
});

// ===================================================
// 🚀 PDF生成 APIエンドポイント
// ===================================================
app.post('/api/generate-pdf', async (req, res) => {
    const targetUrl = req.body?.url;

    if (!targetUrl) {
        return res.status(400).json({ error: 'URLが指定されていません。' });
    }

    if (!isSafeUrl(targetUrl)) {
        return res.status(400).json({ error: '無効なURLです。外部のhttp/https URLのみ指定できます。' });
    }

    if (activeRequests >= MAX_CONCURRENT) {
        return res.status(429).json({ error: 'サーバーが混雑しています。しばらくしてから再試行してください。' });
    }

    activeRequests++;
    console.log(`[API] リクエスト受信 [同時処理数: ${activeRequests}]: ${targetUrl}`);

    try {
        const { pdfBuffer, pageTitle } = await generatePdf(targetUrl);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(pageTitle)}.pdf"`);
        res.send(pdfBuffer);

        console.log(`[API] 完了: ${pageTitle}`);

    } catch (error) {
        console.error('[API] エラー:', error.message);
        res.status(500).json({ error: error.message || 'PDFの生成中にエラーが発生しました。' });
    } finally {
        activeRequests--;
    }
});

// ===================================================
// サーバー起動
// ===================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] ポート ${PORT} で起動しました。`);
});
