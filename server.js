const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const { URL } = require('url');

const app = express();
app.use(cors());
app.use(express.json());

const MAX_CONCURRENT = 1;
const PDF_TIMEOUT_MS = 120000;

let activeRequests = 0;

function isSafeUrl(urlString) {
    try {
        const parsed = new URL(urlString);
        if (!['http:', 'https:'].includes(parsed.protocol)) return false;
        const blockedPattern = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/;
        return !blockedPattern.test(parsed.hostname);
    } catch { return false; }
}

async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 400;
            const maxTime = 8000;
            const start = Date.now();
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;
                if (totalHeight >= scrollHeight - window.innerHeight || Date.now() - start > maxTime) {
                    clearInterval(timer);
                    resolve();
                }
            }, 150);
        });
    });
}

async function generatePdf(targetUrl, imageWidthPercent) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });

        const page = await browser.newPage();
        page.setDefaultNavigationTimeout(90000); 
        await page.setViewport({ width: 1200, height: 800 });

        console.log('サイトにアクセス中...');
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

        console.log('スクロール実行中...');
        await autoScroll(page);
        await page.evaluate(() => window.scrollTo(0, 0));
        await new Promise(r => setTimeout(r, 2000));

        console.log('PDF整形中（画像サイズ・URL表示・改行調整）...');
        
        await page.evaluate((imgMaxPct) => {
            // 不要要素の削除
            const killSelectors = 'header,footer,aside,nav,script,style,iframe,form,button,.adsbygoogle';
            document.querySelectorAll(killSelectors).forEach(el => el.remove());

            const containerW = document.documentElement.clientWidth || 1200;
            const targetWidthPx = (containerW * imgMaxPct) / 100;

            document.querySelectorAll('img').forEach(img => {
                if (!img.src && img.dataset.src) img.src = img.dataset.src;
                const url = img.src;
                if (!url) return;

                // 画像サイズの制御
                const naturalW = img.naturalWidth;
                if (naturalW > targetWidthPx) {
                    img.style.setProperty('width', 'auto', 'important');
                    img.style.setProperty('max-width', '100%', 'important');
                } else {
                    img.style.setProperty('width', imgMaxPct + '%', 'important');
                    img.style.setProperty('max-width', '100%', 'important');
                }
                img.style.setProperty('height', 'auto', 'important');
                img.style.setProperty('display', 'block', 'important');
                img.style.setProperty('margin', '10px 0 2px 0', 'important');
                
                img.removeAttribute('width');
                img.removeAttribute('height');

                // --- 写真URLと強制改行用のコンテナ ---
                const urlDiv = document.createElement('div');
                urlDiv.className = 'pdf-image-url';
                urlDiv.textContent = `[Image URL: ${url}]`;
                
                // スタイル設定：display: block と clear: both で確実に改行させ、margin-bottom で空白行を作る
                urlDiv.style.cssText = `
                    font-size: 8px !important;
                    color: #666 !important;
                    word-break: break-all !important;
                    margin-top: 0 !important;
                    margin-bottom: 24px !important; /* 数値（px）を大きくすることで広い改行（空白行）になります */
                    line-height: 1.2 !important;
                    display: block !important;
                    clear: both !important; /* 回り込みを強制解除 */
                `;

                const parent = img.parentNode;
                const insertTarget = (parent && parent.tagName.toLowerCase() === 'a') ? parent : img;
                if (insertTarget.parentNode) {
                    insertTarget.parentNode.insertBefore(urlDiv, insertTarget.nextSibling);
                }
            });
        }, imageWidthPercent);

        // 基本スタイルの注入
        await page.addStyleTag({
            content: `
                head, style, script, noscript, meta, title { display: none !important; }

                body *, body *::before, body *::after {
                    float: none !important; position: static !important; display: block !important;
                    max-width: 100% !important; background: transparent !important; box-shadow: none !important; border: none !important;
                }
                
                a, span, strong, em, b, i, u, s, label { display: inline !important; }
                
                /* URL表示用クラスは block 指定を優先し、改行を維持 */
                .pdf-image-url { 
                    display: block !important; 
                    clear: both !important;
                }

                table { display: table !important; width: 100% !important; border-collapse: collapse !important; }
                tr { display: table-row !important; }
                th, td { display: table-cell !important; padding: 6px !important; border: 1px solid #999 !important; }
                li { display: list-item !important; }
                
                html, body { background: #fff !important; color: #000 !important; font-size: 14px !important; display: block !important; }
                
                @media print {
                    p, li, img, tr, .pdf-image-url { page-break-inside: avoid !important; break-inside: avoid !important; }
                }
            `
        });

        let pageTitle = (await page.title() || 'document')
            .replace(/[\\/:*?"<>|]/g, '_').trim().substring(0, 50);

        await page.emulateMediaType('print');

        return {
            pdfBuffer: await page.pdf({
                format: 'A4',
                printBackground: false,
                margin: { top: '15mm', right: '15mm', bottom: '15mm', left: '15mm' },
                timeout: 60000
            }),
            pageTitle
        };
    } finally {
        if (browser) await browser.close();
    }
}

app.post('/api/generate-pdf', async (req, res) => {
    const targetUrl = req.body.url;
    let imageWidthPercent = parseInt(req.body.imageWidthPercent, 10);

    if (isNaN(imageWidthPercent) || imageWidthPercent < 30 || imageWidthPercent > 100) {
        imageWidthPercent = 40;
    }
    imageWidthPercent = Math.round(imageWidthPercent / 5) * 5;

    if (!targetUrl || !isSafeUrl(targetUrl)) {
        return res.status(400).send({ error: '有効なURLを指定してください。' });
    }
    if (activeRequests >= MAX_CONCURRENT) {
        return res.status(429).send({ error: '現在混雑しています。少し時間を置いてお試しください。' });
    }

    activeRequests++;
    try {
        const result = await Promise.race([
            generatePdf(targetUrl, imageWidthPercent),
            new Promise((_, reject) => setTimeout(() => reject(new Error('PDF生成がタイムアウトしました。')), PDF_TIMEOUT_MS))
        ]);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(result.pageTitle)}.pdf"`);
        res.send(result.pdfBuffer);
    } catch (error) {
        res.status(500).send({ error: error.message });
    } finally {
        activeRequests--;
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
