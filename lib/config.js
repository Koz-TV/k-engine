// Конфигурация
import path from 'path';
import fs from 'fs-extra';
import merge from 'lodash.merge';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


// Функция для чтения внешней конфигурации
function loadExternalConfig() {
    const configFiles = ['k-engine.config.json', 'config.json'];
    
    for (const configFile of configFiles) {
        try {
            if (fs.existsSync(configFile)) {
                const externalConfig = fs.readJsonSync(configFile);
                console.log(`Loaded configuration from ${configFile}`);
                return externalConfig;
            }
        } catch (e) {
            console.warn(`Failed to load ${configFile}:`, e.message);
        }
    }
    
    return {};
}

const defaultConfig = {
    sourceDir: 'content',
    outputDir: 'docs',
    // Настройка CNAME для кастомного домена
    cname: null, // null означает, что CNAME файл не будет создан
    // Google Analytics ID
    googleAnalytics: null,
    // Multi-language support
    // First language is default (no URL prefix), others get /{lang}/ prefix
    // Example: ['en', 'ru'] - English at /posts/slug/, Russian at /ru/posts/slug/
    languages: null, // null means single-language site (no i18n)
    // Конфигурация изображений
    images: {
        // Размеры для генерации (в пикселях)
        sizes: [480, 960],
        // Дополнительный размер для featured проектов (для Retina)
        featuredSize: null,
        // Максимальный размер (если исходное изображение больше, используем его)
        maxSize: 960,
        // Качество для разных форматов
        quality: {
            webp: 82,
            avif: 55
        },
        // Настройки для responsive изображений
        responsive: {
            // Брейкпоинты (ширина экрана в пикселях)
            breakpoints: [
                { maxWidth: 480, width: '96vw' },
                { maxWidth: 960, width: '90vw' }
            ],
            // Максимальная ширина изображения на больших экранах
            maxWidth: '960px'
        }
    }
};

const externalConfig = loadExternalConfig();

// Глубокое слияние дефолтной и внешней конфигурации
const config = merge({}, defaultConfig, externalConfig);

// Флаги командной строки
const isDev = process.argv.includes('--watch');
const shouldClean = process.argv.includes('--clean');
const forceRegenerate = process.argv.includes('--force-regenerate');

// Глобальные переменные
const assetManifest = {}; // original relative path -> hashed path
let currentMdDir = '';

// Чтение статистики по подписчикам
let subscribers = {};
try {
    subscribers = fs.readJsonSync('subscribers.json');
} catch (e) {
    subscribers = {};
}

export {
    config,
    isDev,
    shouldClean,
    forceRegenerate,
    assetManifest,
    currentMdDir,
    subscribers
}; 