const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();

// ★修正ポイント：exposedHeadersを追加
app.use(cors({
    exposedHeaders: ['Content-Disposition']
}));

app.use(express.json());

async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 100;
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;
                if (totalHeight >= scrollHeight - window.innerHeight) {
                    clearInterval(timer); resolve();
                }
            }, 100);
        });
    });
}

app.post('/api/generate-pdf', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).send({ error: 'URLが必要です' });

    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-web-security']
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1200, height: 800 });
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        await autoScroll(page);
        await page.evaluate(() => window.scrollTo(0, 0));
        await new Promise(r => setTimeout(r, 2000));

        await page.addStyleTag({
            content: `@media print {
                p, li, blockquote, figure, table, tr, img, pre, code, .wp-block-image, .wp-block-group { page-break-inside: avoid !important; break-inside: avoid !important; }
                h1, h2, h3, h4, h5, h6 { page-break-after: avoid !important; break-after: avoid !important; page-break-inside: avoid !important; break-inside: avoid !important; }
                * { max-width: 100% !important; overflow-wrap: break-word !important; }
                table { width: 100% !important; table-layout: fixed !important; }
            }`
        });

        const pageData = await page.evaluate(() => {
            document.querySelectorAll('*').forEach(el => {
                const s = window.getComputedStyle(el);
                if (s.position === 'fixed' || s.position === 'sticky') el.style.setProperty('position', 'static', 'important');
            });

            const killSelectors = ['header', 'footer', 'aside', 'nav', '[class*="footer" i]', '[id*="footer" i]', '#colophon', '[class*="sidebar" i]', '[id*="sidebar" i]', '.widget-area', '[class*="ads" i]', '[class*="comment" i]', '[class*="share" i]', '[class*="related" i]', '[class*="pagination" i]', '[class*="author" i]', '[class*="popup" i]'].join(',');
            document.querySelectorAll(killSelectors).forEach(el => {
                const tag = el.tagName.toLowerCase();
                const id = el.id ? el.id.toLowerCase() : '';
                const cls = el.className && typeof el.className === 'string' ? el.className.toLowerCase() : '';
                if (['body', 'html', 'main', 'article'].includes(tag) || ['content', 'main', 'page'].includes(id) || cls.includes('site-main') || cls.includes('entry-content') || cls.includes('post-content')) return;
                el.remove();
            });

            document.querySelectorAll('img').forEach(img => {
                if(img.width < 50 || img.height < 50) return;
                img.style.setProperty('max-width', '40%', 'important');
                img.style.setProperty('width', 'auto', 'important');
                img.style.setProperty('height', 'auto', 'important');
                img.style.setProperty('display', 'block', 'important');
                const src = img.src || img.getAttribute('data-src');
                if(!src) return;
                const div = document.createElement('div');
                div.style.fontSize = '10px'; div.style.color = '#555'; div.style.marginBottom = '15px';
                div.textContent = `画像URL: ${src}`;
                img.after(div);
            });

            return { title: document.title };
        });

        await page.evaluateHandle('document.fonts.ready');
        await page.emulateMediaType('screen');

        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '15mm', right: '15mm', bottom: '15mm', left: '15mm' }
        });

        // 日付生成
        const jstDate = new Date(Date.now() + (9 * 60 * 60 * 1000));
        const dateStr = `${jstDate.getUTCFullYear()}${String(jstDate.getUTCMonth() + 1).padStart(2, '0')}${String(jstDate.getUTCDate()).padStart(2, '0')}`;

        let cleanTitle = pageData.title.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().substring(0, 50);
        const fileName = `${dateStr}_${cleanTitle}.pdf`;

        // ★重要：Content-Dispositionヘッダーを送信
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
        res.send(pdfBuffer);

    } catch (e) {
        console.error(e);
        res.status(500).send({ error: '生成失敗' });
    } finally {
        await browser.close();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
