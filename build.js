import fs from 'fs-extra';
import path from 'path';
import frontMatter from 'front-matter';
import {
    config,
    isDev,
    shouldClean,
    forceRegenerate,
    assetManifest,
    subscribers,
    hashContent,
    shouldRegenerateFile,
    generateImageSizes,
    processContentFile,
    processFile
} from './lib/index.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Available command line flags:
// --watch: Enable watch mode for development
// --clean: Clean output directory before building
// --force-regenerate: Force regeneration of all images (useful for Windows debugging)

// Создаем выходную директорию
fs.ensureDirSync(config.outputDir);

// Helper to adjust paths for multi-language content
// New structure: {contentType}/{slug}/{lang}.md (for posts and projects)
// Output:
//   - Default lang: {contentType}/{slug}/index.md (will become {contentType}/{slug}/index.html)
//   - Other lang:   {lang}/{contentType}/{slug}/index.md (will become {lang}/{contentType}/{slug}/index.html)
// If frontmatter contains slug override, use it in output path
function adjustPathForLanguage(relPath, srcFullPath = null) {
    const languages = config.languages || [];
    if (languages.length === 0) return relPath;

    const defaultLang = languages[0];
    const pathParts = relPath.split(path.sep);

    // Pattern: {contentType}/{folderSlug}/{lang}.md (for posts and projects)
    const contentTypes = ['posts', 'projects'];
    if (contentTypes.includes(pathParts[0]) && pathParts.length >= 3) {
        const contentType = pathParts[0];
        const folderSlug = pathParts[1];
        const filename = pathParts[2];

        // Check if this is a language .md file (e.g., en.md, ru.md)
        if (filename.endsWith('.md')) {
            const lang = filename.replace('.md', '');

            if (languages.includes(lang)) {
                // Read frontmatter to get slug override if available
                let slug = folderSlug;
                if (srcFullPath && fs.existsSync(srcFullPath)) {
                    try {
                        const content = fs.readFileSync(srcFullPath, 'utf-8');
                        const { attributes } = frontMatter(content);
                        if (attributes.slug) {
                            slug = attributes.slug;
                        }
                    } catch { /* use default folderSlug */ }
                }

                if (lang === defaultLang) {
                    // Default language: {contentType}/{slug}/{lang}.md -> {contentType}/{slug}/index.md
                    return path.join(contentType, slug, 'index.md');
                } else {
                    // Other language: {contentType}/{slug}/{lang}.md -> {lang}/{contentType}/{slug}/index.md
                    return path.join(lang, contentType, slug, 'index.md');
                }
            }
        }

        // Handle other files in the folder (media, etc.)
        // They go to {contentType}/{folderSlug}/
        return relPath;
    }

    return relPath;
}

// Helper to walk source directory recursively
async function processDir(srcDir) {
    const entries = await fs.readdir(srcDir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(srcDir, entry.name);
        const relPath = path.relative(config.sourceDir, fullPath);

        // Adjust path for multi-language content (pass full path for frontmatter reading)
        const adjustedRelPath = adjustPathForLanguage(relPath, fullPath);
        const destPath = path.join(config.outputDir, adjustedRelPath);

        if (entry.isDirectory()) {
            await fs.ensureDir(destPath);
            await processDir(fullPath);
        } else if (entry.isFile()) {
            // Ensure destination directory exists
            await fs.ensureDir(path.dirname(destPath));
            // Отслеживаем обработанные файлы
            await processContentFile(fullPath, destPath, adjustedRelPath, entry, forceRegenerate, (filePath) => {
                processedFiles.add(filePath);
            });
        }
    }
}

// Функция для безопасного копирования статических файлов
async function copyStaticFiles() {
    const staticDest = path.join(config.outputDir, 'static');
    await fs.ensureDir(staticDest);

    // Сначала копируем статические файлы из модуля k-engine
    const kEngineStaticSrc = path.join(__dirname, 'static');
    if (fs.existsSync(kEngineStaticSrc)) {
        console.log('Copying static files from k-engine module...');
        await copyStaticDirectory(kEngineStaticSrc, staticDest);
    }

    // Затем копируем статические файлы из текущего проекта (могут дополнять или перезаписывать)
    const projectStaticSrc = 'static';
    if (fs.existsSync(projectStaticSrc)) {
        console.log('Copying static files from project directory...');
        await copyStaticDirectory(projectStaticSrc, staticDest);
    }

    if (!fs.existsSync(kEngineStaticSrc) && !fs.existsSync(projectStaticSrc)) {
        console.log('No static files found, skipping static file copy');
        return;
    }
}

// Вспомогательная функция для копирования директории статических файлов
async function copyStaticDirectory(srcDir, destDir) {
    async function walk(dir) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const srcPath = path.join(dir, entry.name);
            const relPath = path.relative(srcDir, srcPath).replace(/\\/g, '/');
            const destPath = path.join(destDir, relPath);

            if (entry.isDirectory()) {
                await fs.ensureDir(destPath);
                await walk(srcPath);
                continue;
            }

            // Отслеживаем обработанные статические файлы
            processedFiles.add(destPath);
            await processFile(srcPath, destPath, relPath, entry, forceRegenerate, (filePath) => {
                processedFiles.add(filePath);
            });
        }
    }

    await walk(srcDir);
}

// Глобальная переменная для отслеживания обработанных файлов
let processedFiles = new Set();

// Функция для очистки файлов и папок в docs, которые больше не должны существовать
async function cleanupRemovedFiles() {
    if (!fs.existsSync(config.outputDir)) {
        return;
    }

    async function cleanupDir(dirPath) {
        if (!fs.existsSync(dirPath)) {
            return;
        }

        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            
            if (entry.isDirectory()) {
                // Рекурсивно очищаем подпапки
                await cleanupDir(fullPath);
                
                // Проверяем, остались ли файлы в папке после очистки
                const remainingEntries = await fs.readdir(fullPath, { withFileTypes: true });
                if (remainingEntries.length === 0) {
                    console.log(`Removing empty directory from docs: ${fullPath}`);
                    await fs.remove(fullPath);
                }
            } else if (entry.isFile()) {
                // Удаляем файлы, которые не были обработаны в текущем билде
                if (!processedFiles.has(fullPath)) {
                    console.log(`Removing file from docs: ${fullPath}`);
                    await fs.remove(fullPath);
                }
            }
        }
    }

    await cleanupDir(config.outputDir);
}

// Обрабатываем все Markdown файлы и копируем ресурсы
async function build() {
    // Очищаем список обработанных файлов в начале каждого билда
    processedFiles.clear();
    
    if (shouldClean) {
        await fs.emptyDir(config.outputDir);
    } else {
        await fs.ensureDir(config.outputDir);
    }
    
    await copyStaticFiles();
    await processDir(config.sourceDir);

    // Create .nojekyll file for GitHub Pages
    const nojekyllPath = path.join(config.outputDir, '.nojekyll');
    await fs.writeFile(nojekyllPath, '# This file tells GitHub Pages not to use Jekyll');
    processedFiles.add(nojekyllPath);

    // Create CNAME file for custom domain if configured
    if (config.cname) {
        const cnamePath = path.join(config.outputDir, 'CNAME');
        await fs.writeFile(cnamePath, config.cname);
        processedFiles.add(cnamePath);
        console.log(`Created CNAME file with domain: ${config.cname}`);
    } else {
        console.log('CNAME not configured, skipping CNAME file creation');
    }

    // В конце очищаем файлы и папки, которые больше не должны существовать
    await cleanupRemovedFiles();

    // Generate sitemap.xml and robots.txt
    await generateSitemap();
    await generateRobotsTxt();
}

// Generate sitemap.xml from all HTML files in output directory
async function generateSitemap() {
    const siteUrl = config.cname ? `https://${config.cname}` : 'http://localhost:3000';
    const urls = [];

    async function scanDir(dir, baseUrl = '') {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const urlPath = baseUrl + '/' + entry.name;

            if (entry.isDirectory()) {
                // Skip hidden directories and static
                if (entry.name.startsWith('.') || entry.name === 'static') continue;
                await scanDir(fullPath, urlPath);
            } else if (entry.name === 'index.html') {
                // Get file modification time for lastmod
                const stats = await fs.stat(fullPath);
                const lastmod = stats.mtime.toISOString().split('T')[0];

                // URL is the directory path (without index.html)
                const url = baseUrl === '' ? '/' : baseUrl + '/';

                // Determine priority based on path depth
                const depth = url.split('/').filter(Boolean).length;
                const priority = depth === 0 ? '1.0' : depth === 1 ? '0.8' : '0.6';

                urls.push({ url, lastmod, priority });
            }
        }
    }

    await scanDir(config.outputDir);

    // Sort URLs: homepage first, then alphabetically
    urls.sort((a, b) => {
        if (a.url === '/') return -1;
        if (b.url === '/') return 1;
        return a.url.localeCompare(b.url);
    });

    // Generate sitemap XML
    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(({ url, lastmod, priority }) => `  <url>
    <loc>${siteUrl}${url}</loc>
    <lastmod>${lastmod}</lastmod>
    <priority>${priority}</priority>
  </url>`).join('\n')}
</urlset>`;

    const sitemapPath = path.join(config.outputDir, 'sitemap.xml');
    await fs.writeFile(sitemapPath, sitemap);
    processedFiles.add(sitemapPath);
    console.log(`Generated sitemap.xml with ${urls.length} URLs`);
}

// Generate robots.txt with sitemap reference
async function generateRobotsTxt() {
    const siteUrl = config.cname ? `https://${config.cname}` : 'http://localhost:3000';

    const robotsTxt = `User-agent: *
Allow: /

Sitemap: ${siteUrl}/sitemap.xml
`;

    const robotsPath = path.join(config.outputDir, 'robots.txt');
    await fs.writeFile(robotsPath, robotsTxt);
    processedFiles.add(robotsPath);
    console.log('Generated robots.txt');
}

// Функция для наблюдения за изменениями
async function watch() {
    console.log('Watching for changes...');

    // WebSocket server removed - live reload now handled by BrowserSync
    function notifyClients() {
        /* no-op */
    }

    // Debounce / queue to избегать одновременных билдов
    let building = false;
    let buildQueued = false;
    async function safeBuild() {
        if (building) {
            buildQueued = true;
            return;
        }
        building = true;
        try {
            await build();
        } catch (err) {
            console.error('Build failed:', err);
        } finally {
            building = false;
            if (buildQueued) {
                buildQueued = false;
                // Запускаем ещё один билд, если был запланирован
                safeBuild();
            } else {
                // Шлём уведомление только после успешного (последнего) билда
                notifyClients();
            }
        }
    }
    
    // Наблюдаем за изменениями в директории с контентом (рекурсивно на Windows/mac)
    fs.watch(config.sourceDir, { recursive: true }, async (eventType, filename) => {
        if (filename) {
            console.log(`Change detected in ${filename}`);
            safeBuild();
        }
    });
    
    // Наблюдаем за изменениями во всех шаблонах
    const templatesDir = fs.existsSync('templates') ? 'templates' : path.join(__dirname, 'templates');
    if (fs.existsSync(templatesDir)) {
        fs.watch(templatesDir, async (eventType, filename) => {
            if (filename && filename.endsWith('.html')) {
                console.log(`Template ${filename} has been changed`);
                safeBuild();
            }
        });
    }
    
    // Наблюдаем за изменениями во всех CSS
    const staticDir = fs.existsSync('static') ? 'static' : path.join(__dirname, 'static');
    if (fs.existsSync(staticDir)) {
        fs.watch(path.join(staticDir, 'css'), async (eventType, filename) => {
            if (filename && filename.endsWith('.css')) {
                console.log(`CSS ${filename} has been changed`);
                safeBuild();
            }
        });
        
        // Наблюдаем за изменениями в статических файлах (остальное)
        fs.watch(staticDir, async (eventType, filename) => {
            if (filename && !filename.endsWith('.css')) {
                console.log(`Static file ${filename} has been changed`);
                safeBuild();
            }
        });
    }
}

// Проверяем, запущен ли скрипт в режиме наблюдения
if (process.argv.includes('--watch')) {
    build().then(watch).catch(console.error);
} else {
    build().catch(console.error);
} 