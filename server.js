const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const { URL } = require('url');

const app = express();
app.use(cors());
app.use(express.json());

// ===================================================
// 定数
// ===================================================
const MAX_CONCURRENT = 3;      // 同時処理の上限
const PDF_TIMEOUT_MS = 90000;  // 全体タイムアウト: 90秒

// 同時リクエスト数のカウンター
let activeRequests = 0;

// ===================================================
// 🔒 SSRFリスク対策: URLの安全チェック
// ===================================================
function isSafeUrl(urlString) {
    try {
        const parsed = new URL(urlString);

        // http / https のみ許可
        if (!['http:', 'https:'].includes(parsed.protocol)) return false;

        // ローカル・内部アドレスをブロック
        const blockedPattern = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/;
        if (blockedPattern.test(parsed.hostname)) return false;

        return true;
    } catch {
        return false;
    }
}

// ===================================================
// 🖱️ 無限スクロール対策つき自動スクロール関数
// ===================================================
async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 100;
            const maxTime = 10000; // 最大10秒でスクロール終了
            const start = Date.now();

            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;

                const reachedBottom = totalHeight >= scrollHeight - window.innerHeight;
                const timedOut = Date.now() - start > maxTime;

                if (reachedBottom || timedOut) {
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
        });
    });
}

// ===================================================
// 📄 PDF生成の本体処理
// ===================================================
async function generatePdf(targetUrl, imageWidthPercent) {
    let browser;

    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1200, height: 800 });

        console.log('サイトにアクセスしています...');
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });

        console.log('画像を読み込むためにスクロールしています...');
        await autoScroll(page);
        await page.evaluate(() => window.scrollTo(0, 0));
        await new Promise(r => setTimeout(r, 2000));

        console.log('PDF用にページを整形しています...');

        // 印刷用CSSの注入
        await page.addStyleTag({
            content: `
                /* ===== レイアウトリセット: 段組み・グリッド・フレックスを解除 ===== */
                *, *::before, *::after {
                    float: none !important;
                    position: static !important;
                    display: block !important;
                    grid-template-columns: none !important;
                    grid-template-rows: none !important;
                    grid-column: auto !important;
                    grid-row: auto !important;
                    column-count: 1 !important;
                    flex-direction: column !important;
                    max-width: 100% !important;
                    width: auto !important;
                    margin-left: 0 !important;
                    margin-right: 0 !important;
                    padding-left: 0 !important;
                    padding-right: 0 !important;
                    box-sizing: border-box !important;
                    overflow: visible !important;
                    /* 背景色・背景画像を除去 */
                    background: transparent !important;
                    background-color: transparent !important;
                    background-image: none !important;
                    box-shadow: none !important;
                    text-shadow: none !important;
                    border: none !important;
                    outline: none !important;
                }

                /* インライン要素はインラインのまま許可 */
                a, span, strong, em, b, i, u, s, small, sup, sub,
                abbr, cite, code, mark, time, label {
                    display: inline !important;
                }

                /* テーブル系は適切に表示 */
                table  { display: table  !important; width: 100% !important; border-collapse: collapse !important; }
                thead  { display: table-header-group !important; }
                tbody  { display: table-row-group !important; }
                tfoot  { display: table-footer-group !important; }
                tr     { display: table-row !important; }
                th, td { display: table-cell !important; padding: 6px 8px !important; border: 1px solid #999 !important; word-break: break-word !important; }

                /* ul/ol は list-item で */
                li { display: list-item !important; }

                /* body / html */
                html, body {
                    width: 100% !important;
                    background: #ffffff !important;
                    color: #000000 !important;
                    font-family: "Helvetica Neue", Arial, "Hiragino Kaku Gothic ProN", "Hiragino Sans", sans-serif !important;
                    font-size: 14px !important;
                    line-height: 1.7 !important;
                }

                /* 見出し */
                h1 { font-size: 22px !important; font-weight: bold !important; margin: 16px 0 8px !important; color: #000 !important; }
                h2 { font-size: 18px !important; font-weight: bold !important; margin: 14px 0 7px !important; color: #000 !important; }
                h3 { font-size: 16px !important; font-weight: bold !important; margin: 12px 0 6px !important; color: #000 !important; }
                h4, h5, h6 { font-size: 14px !important; font-weight: bold !important; margin: 10px 0 5px !important; color: #000 !important; }

                /* 段落・リスト */
                p  { margin: 0 0 10px !important; }
                ul, ol { padding-left: 20px !important; margin: 0 0 10px !important; }
                blockquote {
                    margin: 10px 0 10px 10px !important;
                    padding-left: 12px !important;
                    border-left: 3px solid #aaa !important;
                    color: #444 !important;
                    font-style: italic !important;
                }

                /* コードブロック */
                pre, code {
                    font-family: monospace !important;
                    white-space: pre-wrap !important;
                    word-break: break-all !important;
                }
                pre {
                    background: #f4f4f4 !important;
                    padding: 10px !important;
                    border: 1px solid #ddd !important;
                    border-radius: 4px !important;
                    margin: 10px 0 !important;
                }

                /* 画像 */
                img {
                    max-width: ${imageWidthPercent}% !important;
                    height: auto !important;
                    display: block !important;
                    margin: 10px 0 !important;
                }

                /* リンク */
                a { color: #0000EE !important; text-decoration: underline !important; word-break: break-all !important; }

                /* 改ページ制御 */
                @media print {
                    h1, h2, h3, h4, h5, h6 {
                        page-break-after: avoid !important;
                        break-after: avoid !important;
                    }
                    p, li, blockquote, img, pre, table, tr {
                        page-break-inside: avoid !important;
                        break-inside: avoid !important;
                    }
                    p, li { orphans: 2 !important; widows: 2 !important; }
                }
            `
        });

        // DOM操作
        await page.evaluate((imgMaxPct) => {
            // ===== 不要な要素を削除 =====
            const killSelectors = [
                'header', 'footer', 'aside', 'nav',
                '[class*="footer" i]', '[id*="footer" i]', '#colophon',
                '[class*="sidebar" i]', '[id*="sidebar" i]', '.widget-area', '[class*="widget" i]',
                '[class*="banner" i]', '[id*="banner" i]',
                '[class*="ads" i]', '.adsbygoogle', '[class*="advert" i]', '[class*="sponsor" i]',
                '[class*="comment" i]', '[id*="comment" i]',
                '[class*="share" i]', '[class*="social" i]', '[class*="sns" i]',
                '[class*="related" i]', '[class*="pagination" i]',
                '[class*="author" i]', '[class*="popup" i]', '[class*="modal" i]', '[class*="overlay" i]',
                'script', 'style', 'noscript', 'svg', 'canvas',
                '[class*="breadcrumb" i]', '[class*="tag" i]', '[class*="category" i]',
                '[class*="menu" i]', '[id*="menu" i]',
                '[class*="toc" i]', '[id*="toc" i]',
                '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
                'form', 'button', 'input', 'select', 'textarea'
            ].join(',');

            document.querySelectorAll(killSelectors).forEach(el => {
                const tag = el.tagName.toLowerCase();
                const id = el.id ? el.id.toLowerCase() : '';
                const cls = el.className && typeof el.className === 'string' ? el.className.toLowerCase() : '';

                // 本文コンテナは保護する
                if (
                    ['body', 'html', 'main', 'article'].includes(tag) ||
                    ['content', 'main', 'page'].includes(id) ||
                    cls.includes('site-main') ||
                    cls.includes('entry-content') ||
                    cls.includes('post-content') ||
                    cls.includes('article-body') ||
                    cls.includes('article-content')
                ) return;

                el.remove();
            });

            // ===== インラインスタイルを全て除去（CSS注入が優先されるようにするため） =====
            document.querySelectorAll('*').forEach(el => {
                el.removeAttribute('style');
                el.removeAttribute('bgcolor');
                el.removeAttribute('color');
                el.removeAttribute('background');
                el.removeAttribute('align');
                el.removeAttribute('valign');
                el.removeAttribute('width');
                el.removeAttribute('height');
            });

            // ===== 動画をURLテキストに置換 =====
            document.querySelectorAll('iframe[src*="youtube"], iframe[src*="vimeo"], video').forEach(vid => {
                const url = vid.src || vid.currentSrc || 'URL不明';
                const textNode = document.createElement('div');
                textNode.style.cssText = 'padding:10px;border:1px solid #ccc;margin-bottom:10px;';
                textNode.innerHTML = `<strong>【動画】</strong><br><span>${url}</span>`;
                vid.parentNode && vid.parentNode.replaceChild(textNode, vid);
            });

            // ===== 残ったiframeを削除 =====
            document.querySelectorAll('iframe').forEach(el => el.remove());

            // ===== 画像処理: 元サイズより小さい倍率指定の場合は元サイズを保持 =====
            document.querySelectorAll('img').forEach(img => {
                // 表示上の幅を取得（naturalWidth も参考に）
                const naturalW = img.naturalWidth || 0;
                const containerW = document.body.clientWidth || 800;
                const maxPxFromPercent = containerW * imgMaxPct / 100;

                // 元画像が指定倍率より小さい場合はそのまま（縮小しない）
                const finalMaxPx = (naturalW > 0 && naturalW < maxPxFromPercent)
                    ? naturalW
                    : maxPxFromPercent;

                img.style.cssText = `
                    max-width: ${finalMaxPx}px !important;
                    width: auto !important;
                    height: auto !important;
                    display: block !important;
                    margin: 10px 0 !important;
                `;

                // 画像URL表示
                const url = img.src || img.getAttribute('data-src');
                if (!url) return;

                const urlDiv = document.createElement('div');
                urlDiv.style.cssText = 'font-size:10px;color:#555;word-break:break-all;margin-bottom:15px;';
                urlDiv.textContent = `画像URL: ${url}`;

                const parent = img.parentNode;
                if (parent) {
                    const insertAfter = (parent.tagName && parent.tagName.toLowerCase() === 'a')
                        ? parent
                        : img;
                    insertAfter.parentNode && insertAfter.parentNode.insertBefore(urlDiv, insertAfter.nextSibling);
                }
            });

            // ===== lazy-load 画像の src 復元 =====
            document.querySelectorAll('img[data-src]').forEach(img => {
                if (!img.src && img.dataset.src) img.src = img.dataset.src;
            });

        }, imageWidthPercent);

        console.log('フォントの読み込み待機...');
        await page.evaluateHandle('document.fonts.ready');
        await new Promise(r => setTimeout(r, 1000));

        let pageTitle = await page.title();
        if (!pageTitle) pageTitle = 'document';
        pageTitle = pageTitle.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().substring(0, 50);

        await page.emulateMediaType('print');

        console.log('PDFデータを生成中...');
        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: false,
            margin: { top: '15mm', right: '15mm', bottom: '15mm', left: '15mm' }
        });

        return { pdfBuffer, pageTitle };

    } finally {
        if (browser) await browser.close();
    }
}

// ===================================================
// 🚀 APIエンドポイント
// ===================================================
app.post('/api/generate-pdf', async (req, res) => {
    const targetUrl = req.body.url;

    // imageWidthPercent: 20〜100の整数（5刻み）、デフォルト40
    let imageWidthPercent = parseInt(req.body.imageWidthPercent, 10);
    if (isNaN(imageWidthPercent) || imageWidthPercent < 20 || imageWidthPercent > 100) {
        imageWidthPercent = 40;
    }
    // 5刻みに丸める
    imageWidthPercent = Math.round(imageWidthPercent / 5) * 5;

    // URLの存在チェック
    if (!targetUrl) {
        return res.status(400).send({ error: 'URLが指定されていません。' });
    }

    // SSRFリスク対策
    if (!isSafeUrl(targetUrl)) {
        return res.status(400).send({ error: '無効なURLです。外部のhttp/httpsURLのみ指定できます。' });
    }

    // 同時接続数の制限
    if (activeRequests >= MAX_CONCURRENT) {
        return res.status(429).send({ error: 'サーバーが混雑しています。しばらくしてから再試行してください。' });
    }

    activeRequests++;
    console.log(`リクエスト受信 [同時処理数: ${activeRequests}] [画像幅: ${imageWidthPercent}%]: ${targetUrl}`);

    try {
        // 全体タイムアウト (90秒)
        const { pdfBuffer, pageTitle } = await Promise.race([
            generatePdf(targetUrl, imageWidthPercent),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('PDF生成がタイムアウトしました。')), PDF_TIMEOUT_MS)
            )
        ]);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(pageTitle)}.pdf"`);
        res.send(pdfBuffer);

        console.log(`完了: クライアントにPDFを返却しました。[${pageTitle}]`);

    } catch (error) {
        console.error('エラー発生:', error.message);
        res.status(500).send({ error: error.message || 'PDFの生成中にエラーが発生しました。' });
    } finally {
        activeRequests--;
    }
});

// ===================================================
// サーバー起動
// ===================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`APIサーバーがポート ${PORT} で起動しました。`);
});
