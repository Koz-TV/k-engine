import fs from 'fs-extra';
import path from 'path';
import { marked } from 'marked';
import frontMatter from 'front-matter';
import sizeOf from 'image-size';
import { config } from './config.js';
import { createImageHtml, createSrcset, createSizes } from './images.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let currentMdDir = '';

// Настраиваем marked для обработки ссылок
const renderer = new marked.Renderer();
const originalLinkRenderer = renderer.link.bind(renderer);
renderer.link = (href, title, text) => {
    // Если ссылка начинается с /, убираем слеш
    if (href.startsWith('/')) {
        href = href.substring(1);
    }
    // Remove index.html at end of href
    if (href.endsWith('index.html')) {
        href = href.slice(0, -'index.html'.length);
    }
    return originalLinkRenderer(href, title, text);
};

const originalImageRenderer = renderer.image.bind(renderer);
renderer.image = (href, title, text) => {
    return createImageHtml(href, title, text, currentMdDir, 'content');
};

marked.setOptions({ renderer });

// Функция для чтения шаблона
function loadTemplate() {
    return loadPartial('page');
}

// Функция для чтения partials (включений)
function loadPartial(partialName) {
    const cwd = process.cwd();
    console.log(`[k-engine] Looking for partial: ${partialName}.html`);
    console.log(`[k-engine] Current working directory: ${cwd}`);
    const localPath = path.resolve(cwd, 'templates', `${partialName}.html`);
    if (fs.existsSync(localPath)) {
        try {
            return fs.readFileSync(localPath, 'utf-8');
        } catch (e) {
            console.warn(`Partial ${partialName}.html not found in local`);
            return '';
        }
    }
    console.log(`[k-engine] Using module template: ${path.resolve(__dirname, '..', 'templates', `${partialName}.html`)}`);
    try {
        return fs.readFileSync(path.resolve(__dirname, '..', 'templates', `${partialName}.html`), 'utf-8');
    } catch (e) {
        console.warn(`Partial ${partialName}.html not found in module`);
        return '';
    }
}


// Простая функция для поиска файлов шаблонов
function getTemplatePath(templatePath) {
    // Сначала ищем в рабочей директории проекта
    const cwd = process.cwd();
    const localPath = path.resolve(cwd, templatePath);
    console.log(`[k-engine] Looking for template: ${templatePath}`);
    console.log(`[k-engine] Current working directory: ${cwd}`);
    console.log(`[k-engine] Local path: ${localPath}`);
    if (fs.existsSync(localPath)) {
        console.log(`[k-engine] Found local template: ${localPath}`);
        return localPath;
    }
    // Если не найден, используем шаблон из модуля
    const modulePath = path.resolve(__dirname, '..', templatePath);
    console.log(`[k-engine] Using module template: ${modulePath}`);
    return modulePath;
}

// Функция для обработки включений в шаблоне
function processPartials(template, variables) {
    return template.replace(/\{\{>\s*(\w+)\s*\}\}/g, (match, partialName) => {
        const partialContent = loadPartial(partialName);
        // Подставляем переменные в partial
        return partialContent
            .replace(/{{root}}/g, variables.root || '')
            .replace(/{{year}}/g, variables.year || '');
    });
}

// Функция для конвертации Markdown в HTML
// langOptions: { lang, slug, folderSlug, type } for language switcher support
function convertMarkdownToHtml(markdown, metadata, mdDirRel, rootPrefix = '', langOptions = {}) {
    const prevDir = currentMdDir;
    currentMdDir = mdDirRel || '';
    const content = marked.parse(markdown);
    currentMdDir = prevDir;
    let dateStr = metadata.date || '';
    if (dateStr instanceof Date) {
        dateStr = dateStr.toISOString().slice(0, 10);
    }
    const devScript = '';
    const yearStr = new Date().getFullYear();

    // Language support
    const languages = config.languages || [];
    const defaultLang = languages[0] || 'en';
    const currentLang = langOptions.lang || defaultLang;
    const isDefaultLang = currentLang === defaultLang;
    const langPrefix = isDefaultLang ? '' : `/${currentLang}`;

    // Generate language switcher if applicable
    // Pass folderSlug for translation lookup (allows per-language slug overrides)
    // For pages (including homepage), generate switcher even without slug
    const langSwitcher = languages.length > 1
        ? generateLanguageSwitcher(currentLang, langOptions.slug, langOptions.type || 'page', langOptions.folderSlug)
        : '';

    // Подготавливаем переменные для шаблона
    const templateVariables = {
        title: metadata.title || '',
        date: dateStr,
        bodyClass: metadata.bodyClass || '',
        year: yearStr,
        devReload: devScript,
        content: content,
        root: rootPrefix,
        lang: currentLang,
        langPrefix: langPrefix,
        langSwitcher: langSwitcher,
        googleAnalytics: config.googleAnalytics ?
            `<script async src="https://www.googletagmanager.com/gtag/js?id=${config.googleAnalytics}"></script>
    <script>
        window.dataLayer = window.dataLayer || [];
        function gtag(){dataLayer.push(arguments);}
        gtag('js', new Date());
        gtag('config', '${config.googleAnalytics}');
    </script>` : ''
    };

    // Читаем шаблон каждый раз заново
    const template = loadTemplate();

    // Сначала обрабатываем partials
    let processedTemplate = processPartials(template, templateVariables);

    // Затем подставляем остальные переменные
    return processedTemplate
        .replace(/{{title}}/g, templateVariables.title)
        .replace(/{{date}}/g, templateVariables.date)
        .replace(/{{bodyClass}}/g, templateVariables.bodyClass)
        .replace(/{{year}}/g, templateVariables.year)
        .replace(/{{devReload}}/g, templateVariables.devReload)
        .replace(/{{googleAnalytics}}/g, templateVariables.googleAnalytics)
        .replace(/{{root}}/g, templateVariables.root || '')
        .replace(/{{lang}}/g, templateVariables.lang)
        .replace(/{{langPrefix}}/g, templateVariables.langPrefix)
        .replace(/{{langSwitcher}}/g, templateVariables.langSwitcher)
        .replace('{{content}}', templateVariables.content);
}

// Generate HTML list of posts sorted by date desc
// New structure: posts/{folderSlug}/{lang}.md
// If lang is the default (first in config.languages), URLs have no prefix
// Otherwise URLs are prefixed with /{lang}/
function generatePostsMarkdownList(lang = null) {
    const languages = config.languages || [];
    const defaultLang = languages[0] || null;
    const isDefaultLang = !lang || lang === defaultLang;
    const currentLang = lang || defaultLang || 'en';

    // Posts root is always posts/ (no language subfolder in new structure)
    const postsRoot = path.join(config.sourceDir, 'posts');

    if (!fs.existsSync(postsRoot)) {
        return '';
    }

    // Get all post folders (each folder is a post, may contain multiple {lang}.md files)
    const folderSlugs = fs.readdirSync(postsRoot, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

    const metas = folderSlugs.map(folderSlug => {
        // Look for {lang}.md file in the folder
        const mdPath = path.join(postsRoot, folderSlug, `${currentLang}.md`);
        try {
            const mdContent = fs.readFileSync(mdPath, 'utf-8');
            const { attributes } = frontMatter(mdContent);
            const date = attributes.date || '1970-01-01';
            const title = attributes.title || folderSlug;
            // Use frontmatter slug if provided, otherwise use folder slug
            const slug = attributes.slug || folderSlug;
            return { slug, title, date };
        } catch {
            return null;
        }
    }).filter(Boolean);

    metas.sort((a, b) => {
        const ta = Date.parse(a.date);
        const tb = Date.parse(b.date);
        return tb - ta;
    });

    // URL prefix for non-default languages
    const urlPrefix = isDefaultLang ? '' : `/${lang}`;

    return metas.map(m => `<li><a href="${urlPrefix}/posts/${m.slug}/">${m.title}</a></li>`).join('\n');
}

// Get available languages for a post (for language switcher)
// Returns languages that have a translation file in posts/{folderSlug}/
function getPostLanguages(folderSlug) {
    const languages = config.languages || [];
    if (languages.length === 0) return [];

    const postDir = path.join(config.sourceDir, 'posts', folderSlug);
    if (!fs.existsSync(postDir)) return [];

    return languages.filter(lang => {
        const mdPath = path.join(postDir, `${lang}.md`);
        return fs.existsSync(mdPath);
    });
}

// Get translations map for a post: { lang: slug }
// Each language version can have its own slug override via frontmatter
function getPostTranslations(folderSlug) {
    const languages = config.languages || [];
    if (languages.length === 0) return {};

    const postDir = path.join(config.sourceDir, 'posts', folderSlug);
    if (!fs.existsSync(postDir)) return {};

    const translations = {};

    for (const file of fs.readdirSync(postDir)) {
        if (!file.endsWith('.md')) continue;
        const lang = file.replace('.md', '');
        if (!languages.includes(lang)) continue;

        const mdPath = path.join(postDir, file);
        try {
            const mdContent = fs.readFileSync(mdPath, 'utf-8');
            const { attributes } = frontMatter(mdContent);
            // Use frontmatter slug if provided, otherwise use folder slug
            translations[lang] = attributes.slug || folderSlug;
        } catch {
            translations[lang] = folderSlug;
        }
    }

    return translations; // {en: "setup-ssh", ru: "nastroyka-ssh"}
}

// Get translations map for a project: { lang: slug }
// Each language version can have its own slug override via frontmatter
function getProjectTranslations(folderSlug) {
    const languages = config.languages || [];
    if (languages.length === 0) return {};

    const projectDir = path.join(config.sourceDir, 'projects', folderSlug);
    if (!fs.existsSync(projectDir)) return {};

    const translations = {};

    for (const file of fs.readdirSync(projectDir)) {
        if (!file.endsWith('.md')) continue;
        const lang = file.replace('.md', '');
        if (!languages.includes(lang)) continue;

        const mdPath = path.join(projectDir, file);
        try {
            const mdContent = fs.readFileSync(mdPath, 'utf-8');
            const { attributes } = frontMatter(mdContent);
            // Use frontmatter slug if provided, otherwise use folder slug
            translations[lang] = attributes.slug || folderSlug;
        } catch {
            translations[lang] = folderSlug;
        }
    }

    return translations;
}

// Generate language switcher HTML
// For posts/projects: uses folderSlug to get translations map with per-language slug overrides
// slug: the slug for the current language (used if folderSlug not provided)
// folderSlug: the folder name in posts/ or projects/ (used to lookup translations)
// type: 'post', 'project', or 'page'
function generateLanguageSwitcher(currentLang, slug, type = 'post', folderSlug = null) {
    const languages = config.languages || [];
    if (languages.length <= 1) return '';

    const defaultLang = languages[0];

    // For posts/projects, get translations map using folderSlug
    // Each language may have its own slug via frontmatter override
    let translations = {};
    let availableLangs = languages;

    if (type === 'post') {
        const lookupSlug = folderSlug || slug;
        translations = getPostTranslations(lookupSlug);
        availableLangs = Object.keys(translations);
    } else if (type === 'project') {
        const lookupSlug = folderSlug || slug;
        translations = getProjectTranslations(lookupSlug);
        availableLangs = Object.keys(translations);
    }

    if (availableLangs.length <= 1) return '';

    const langNames = {
        en: 'English',
        ru: 'Русский',
        de: 'Deutsch',
        zh: '中文',
        es: 'Español',
        fr: 'Français',
        ja: '日本語',
        ko: '한국어'
    };

    // Map type to URL path segment
    const typeToPath = { post: 'posts', project: 'projects' };
    const pathSegment = typeToPath[type] || '';

    const links = availableLangs.map(lang => {
        const isDefault = lang === defaultLang;
        const isCurrent = lang === currentLang;
        const urlPrefix = isDefault ? '' : `/${lang}`;
        // Use per-language slug from translations map, or fallback to current slug
        const langSlug = translations[lang] || slug;
        const href = pathSegment ? `${urlPrefix}/${pathSegment}/${langSlug}/` : `${urlPrefix}/`;
        const name = langNames[lang] || lang.toUpperCase();

        if (isCurrent) {
            return `<span class="lang-current">${name}</span>`;
        }
        return `<a href="${href}" class="lang-link">${name}</a>`;
    });

    return `<div class="lang-switcher">${links.join(' | ')}</div>`;
}

// Generate HTML markup for projects section
// New structure: projects/{slug}/{lang}.md
function generateProjectsMarkup(lang = null) {
    const languages = config.languages || [];
    const defaultLang = languages[0] || 'en';
    const currentLang = lang || defaultLang;
    const isDefaultLang = currentLang === defaultLang;
    // URL prefix for non-default languages
    const urlPrefix = isDefaultLang ? '' : `/${currentLang}`;

    const projectsRoot = path.join(config.sourceDir, 'projects');
    if (!fs.existsSync(projectsRoot)) return { featured: '', grid: '' };

    const dirs = fs.readdirSync(projectsRoot, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);

    const metas = dirs.map(folderSlug => {
        // New structure: projects/{slug}/{lang}.md
        const mdPath = path.join(projectsRoot, folderSlug, `${currentLang}.md`);
        let title = folderSlug;
        let date = '1970-01-01';
        let featured = false;
        let slug = folderSlug;

        if (fs.existsSync(mdPath)) {
            const { attributes } = frontMatter(fs.readFileSync(mdPath, 'utf-8'));
            title = attributes.title || title;
            date = attributes.date || date;
            featured = !!attributes.featured;
            slug = attributes.slug || folderSlug;
        } else {
            // No translation for this language - skip
            return null;
        }

        // find cover image
        const dirFiles = fs.readdirSync(path.join(projectsRoot, folderSlug));
        let cover = dirFiles.find(f => /^cover\.(png|jpe?g|gif|svg|webp)$/i.test(f));
        if (!cover) {
            cover = dirFiles.find(f => /image1\.(png|jpe?g|gif|svg|webp)$/i.test(f));
        }
        const hasVideo = fs.existsSync(path.join(projectsRoot, folderSlug, 'video.mp4'));

        return { slug, folderSlug, title, date, cover, hasVideo, featured };
    }).filter(Boolean);

    metas.sort((a,b)=> Date.parse(b.date) - Date.parse(a.date));

    let featuredProject = metas.find(m=>m.featured);
    if(!featuredProject && metas.length) featuredProject = metas[0];
    const others = metas.filter(m=>m!==featuredProject);

    const makeAnchor = m => {
        const videoAttr = m.hasVideo ? ' data-video' : '';
        // Use absolute paths with / prefix so they work from any language version
        const imgSrc = m.cover ? `/projects/${m.folderSlug}/${m.cover}` : '';
        let dimAttr = '';
        if (imgSrc) {
            try {
                const { width, height } = sizeOf(path.join(projectsRoot, m.folderSlug, m.cover));
                if (width && height) {
                    dimAttr = ` width="${width}" height="${height}" style="aspect-ratio:${width}/${height}"`;
                }
            } catch {}
        }
        const ratioStyle = m.cover && dimAttr ? ` style="aspect-ratio:${dimAttr.match(/width=\"(\d+)/)[1]}/${dimAttr.match(/height=\"(\d+)/)[1]}"` : '';
        let imgTag = '';
        if (imgSrc) {
            // Используем контекст для определения оптимального размера
            const context = m === featuredProject ? 'featured' : 'grid';
            imgTag = createImageHtml(imgSrc, m.title, m.title, '', context);
        }
        // Use language prefix for project URLs
        return `<a class="project-item${m===featuredProject?' full':''}" href="${urlPrefix}/projects/${m.slug}/"${videoAttr}${ratioStyle}>${imgTag}<span class="caption">${m.title}</span></a>`;
    };

    return {
        featured: featuredProject ? makeAnchor(featuredProject) : '',
        grid: others.map(makeAnchor).join('\n\n')
    };
}

export {
    convertMarkdownToHtml,
    generatePostsMarkdownList,
    generateProjectsMarkup,
    getPostLanguages,
    getPostTranslations,
    getProjectTranslations,
    generateLanguageSwitcher
}; 