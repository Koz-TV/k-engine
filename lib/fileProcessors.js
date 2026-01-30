import fs from 'fs-extra';
import path from 'path';
import CleanCSS from 'clean-css';
import esbuild from 'esbuild';
import { config, assetManifest, subscribers } from './config.js';
import { hashContent } from './hash.js';
import { generateImageSizes } from './images.js';
import frontMatter from 'front-matter';
import { convertMarkdownToHtml, generatePostsMarkdownList, generateProjectsMarkup, generateLanguageSwitcher } from './markdown.js';
import { generateSocialIconsHtml } from './socials.js';

// Общая функция для обработки изображений
async function processImage(srcPath, destPath, relPath, entry, forceRegenerate, addToProcessed) {
    console.log(`Processing image: ${relPath}`);
    await generateImageSizes(srcPath, destPath, forceRegenerate, addToProcessed);
}

// Обработчики для разных типов файлов
const fileProcessors = {
    // CSS файлы
    '.css': async (srcPath, destPath, relPath, entry, forceRegenerate, addToProcessed) => {
        const cssSrc = await fs.readFile(srcPath, 'utf-8');
        const hash = hashContent(cssSrc);
        const hashedName = entry.name.replace(/\.css$/, `.${hash}.css`);
        const finalDest = path.join(path.dirname(destPath), hashedName);
        
        // Добавляем в манифест для замены в HTML
        assetManifest[`static/${relPath}`] = `static/${path.posix.join(path.dirname(relPath), hashedName)}`;
        
        if (!fs.existsSync(finalDest)) {
            const minified = new CleanCSS({ level: 2 }).minify(cssSrc).styles;
            await fs.writeFile(finalDest, minified);
        }
        if (addToProcessed) addToProcessed(finalDest);
    },

    // JavaScript файлы
    '.js': async (srcPath, destPath, relPath, entry, forceRegenerate, addToProcessed) => {
        const jsSrc = await fs.readFile(srcPath, 'utf-8');
        const hash = hashContent(jsSrc);
        const hashedName = entry.name.replace(/\.js$/, `.${hash}.js`);
        const finalDest = path.join(path.dirname(destPath), hashedName);
        
        // Добавляем в манифест для замены в HTML
        assetManifest[`static/${relPath}`] = `static/${path.posix.join(path.dirname(relPath), hashedName)}`;
        
        if (!fs.existsSync(finalDest)) {
            const result = await esbuild.build({
                stdin: { contents: jsSrc, resolveDir: path.dirname(srcPath), sourcefile: entry.name },
                bundle: false,
                minify: true,
                write: false,
                format: 'iife',
                target: 'es2018'
            });
            const js = result.outputFiles[0].text;
            await fs.writeFile(finalDest, js);
        }
        if (addToProcessed) addToProcessed(finalDest);
    },

    // Markdown файлы
    '.md': async (srcPath, destPath, relPath, entry, forceRegenerate, addToProcessed) => {
        const content = await fs.readFile(srcPath, 'utf-8');
        const { attributes, body } = frontMatter(content);
        let mdBody = body;

        // Detect language and slug from the adjusted relPath
        // relPath is already adjusted by build.js:
        // - posts/slug/index.md (default language)
        // - ru/posts/slug/index.md (non-default language)
        const languages = config.languages || [];
        const defaultLang = languages[0] || 'en';
        let currentLang = defaultLang;
        let slug = null;

        if (languages.length > 0) {
            const pathParts = relPath.split(path.sep);

            // Pattern: {lang}/posts/slug/index.md (non-default language)
            if (pathParts.length >= 3 && languages.includes(pathParts[0]) && pathParts[1] === 'posts') {
                currentLang = pathParts[0];
                slug = pathParts[2];
            }
            // Pattern: posts/slug/index.md (default language)
            else if (pathParts[0] === 'posts' && pathParts.length >= 2) {
                currentLang = defaultLang;
                slug = pathParts[1];
            }
        }

        // Специальная обработка для главной страницы
        const isHomePage = relPath === 'index.md' ||
            (languages.length > 0 && languages.some(l => relPath === `${l}${path.sep}index.md`));

        if (isHomePage) {
            const proj = generateProjectsMarkup();
            mdBody = mdBody
                .replace(/{{postsList}}/g, generatePostsMarkdownList(currentLang))
                .replace(/{{projectsFeatured}}/g, proj.featured)
                .replace(/{{projectsGrid}}/g, proj.grid);
        }

        const depth = path.relative(config.outputDir, path.dirname(destPath)).split(path.sep).filter(Boolean).length;
        const rootPrefix = depth === 0 ? '' : Array(depth).fill('..').join('/') + '/';

        // Language options for template
        const langOptions = languages.length > 0 ? {
            lang: currentLang,
            slug: slug,
            type: slug ? 'post' : 'page'
        } : {};

        let html = convertMarkdownToHtml(mdBody, {
            ...attributes,
            bodyClass: isHomePage ? 'home' : (attributes.bodyClass || '')
        }, path.dirname(relPath), rootPrefix, langOptions);

        if (assetManifest['static/css/style.css']) {
            const stylePath = rootPrefix + assetManifest['static/css/style.css'];
            html = html.replace(/{{styleCss}}/g, stylePath);
        } else {
            html = html.replace(/{{styleCss}}/g, rootPrefix + 'static/css/style.css');
        }
        // root уже подставлен в convertMarkdownToHtml
        for (const [orig, hashed] of Object.entries(assetManifest)) {
            const origPath1 = rootPrefix + orig;
            const hashedPath1 = rootPrefix + hashed;
            html = html.split(origPath1).join(hashedPath1);
            html = html.split(orig).join(hashed);
        }
        if (isHomePage) {
            html = html.replace(/{{socialsWithSubscribers}}/g, generateSocialIconsHtml(subscribers));
        }
        const htmlDest = destPath.replace(/\.md$/, '.html');
        await fs.ensureDir(path.dirname(htmlDest));
        await fs.writeFile(htmlDest, html);
        if (addToProcessed) addToProcessed(htmlDest);
        console.log(`Built: ${htmlDest}`);

        // Удаляем оригинальный .md файл из docs, если он был скопирован
        if (fs.existsSync(destPath)) {
            await fs.remove(destPath);
        }
    },

    // Изображения
    '.png': processImage,
    '.jpg': processImage,
    '.jpeg': processImage
};

// Обработчик по умолчанию (копирование файла как есть)
const defaultProcessor = async (srcPath, destPath, relPath, entry, forceRegenerate, addToProcessed) => {
    await fs.copy(srcPath, destPath);
    if (addToProcessed) addToProcessed(destPath);
};

// Главная функция для обработки файла
async function processFile(srcPath, destPath, relPath, entry, forceRegenerate = false, addToProcessed = null) {
    const ext = path.extname(entry.name).toLowerCase();
    const processor = fileProcessors[ext] || defaultProcessor;
    
    try {
        await processor(srcPath, destPath, relPath, entry, forceRegenerate, addToProcessed);
    } catch (error) {
        console.error(`Error processing ${relPath}:`, error.message);
        // Fallback к копированию в случае ошибки, но не для markdown файлов
        if (ext !== '.md') {
            await defaultProcessor(srcPath, destPath);
        }
    }
}

// Главная функция для обработки контентного файла (теперь просто вызывает processFile)
async function processContentFile(srcPath, destPath, relPath, entry, forceRegenerate = false, addToProcessed = null) {
    return await processFile(srcPath, destPath, relPath, entry, forceRegenerate, addToProcessed);
}

export {
    processFile,
    processContentFile,
    fileProcessors
}; 