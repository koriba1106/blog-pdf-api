const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const { URL } = require('url');

const app = express();
app.use(cors());
app.use(express.json());

const MAX_CONCURRENT = 1;      // 無料プランのリソース制限を考慮し1に設定
const PDF_TIMEOUT_MS = 120000; // 全体タイムアウトを120秒に延長

let activeRequests = 0;

function isSafeUrl(urlString) {
    try {
        const parsed = new URL(urlString);
        if (!['http:', 'https:'].includes(parsed.protocol)) return false;
        const blockedPattern = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/;
        return !blockedPattern.test(parsed.hostname);
    } catch { return false; }
}

// 高速化したスクロール関数
async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 400; // 一度のスクロール量を増やして高速化
            const maxTime = 8000; // 最大8秒で切り上げ
            const start = Date.now();

            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;

                if (totalHeight >= scrollHeight - window.innerHeight || Date.now() - start > maxTime) {
                    clearInterval(timer);
                    resolve();
                }
            }, 150); // 間隔を少し広げてCPU負荷を軽減
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
        // 個別のナビゲーションタイムアウトを設定
        page.setDefaultNavigationTimeout(90000); 
        await page.setViewport({ width: 1200, height: 800 });

        console.log('サイトにアクセス中...');
        // networkidle2だと画像が多い場合に終わらないため、DOMContentLoadedで進める
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

        console.log('スクロール実行中...');
        await autoScroll(page);
        await page.evaluate(() => window.scrollTo(0, 0));
        await new Promise(r => setTimeout(r, 2000)); // 画像のレンダリング待ち

        console.log('PDF整形中...');
        // CSS注入
        await page.addStyleTag({
            content: `
                *, *::before, *::after {
                    float: none !important; position: static !important; display: block !important;
                    max-width: 100% !important; width: auto !important;
                    background: transparent !important; box-shadow: none !important; border: none !important;
                }
                a, span, strong, em, b, i, u, s, label { display: inline !important; }
                table { display: table !important; width: 100% !important; border-collapse: collapse !important; }
                tr { display: table-row !important; }
                th, td { display: table-cell !important; padding: 6px !important; border: 1px solid #999 !important; }
                li { display: list-item !important; }
                html, body { background: #fff !important; color: #000 !important; font-size: 14px !important; }
                img { max-width: ${imageWidthPercent}% !important; height: auto !important; display: block !important; margin: 10px 0 !important; }
                @media print {
                    p, li, img, tr { page-break-inside: avoid !important; break-inside: avoid !important; }
                }
            `
        });

        // DOM操作（不要要素削除・遅延読み込み画像復元）
        await page.evaluate((imgMaxPct) => {
            const killSelectors = 'header,footer,aside,nav,script,style,iframe,form,button,.adsbygoogle';
            document.querySelectorAll(killSelectors).forEach(el => el.remove());
            
            document.querySelectorAll('img').forEach(img => {
                if (!img.src && img.dataset.src) img.src = img.dataset.src;
                img.removeAttribute('style');
            });
        }, imageWidthPercent);

        let pageTitle = (await page.title() || 'document')
            .replace(/[\\/:*?"<>|]/g, '_').trim().substring(0, 50);

        await page.emulateMediaType('print');

        console.log('PDFバイナリ生成中...');
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
    let imageWidthPercent = parseInt(req.body.imageWidthPercent, 10) || 40;

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
