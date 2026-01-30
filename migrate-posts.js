#!/usr/bin/env node
/**
 * Migration script: Convert posts from old structure to new structure
 *
 * Old structure: posts/{lang}/{slug}/index.md
 * New structure: posts/{slug}/{lang}.md
 *
 * Usage: node migrate-posts.js [--dry-run] [--content-dir=path]
 *
 * Options:
 *   --dry-run       Show what would be done without making changes
 *   --content-dir   Path to content directory (default: ./content)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse command line arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const contentDirArg = args.find(a => a.startsWith('--content-dir='));
const contentDir = contentDirArg
    ? contentDirArg.split('=')[1]
    : './content';

const postsDir = path.join(contentDir, 'posts');

// Helper to create directory recursively
function mkdirSync(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

// Helper to move/rename
function moveSync(src, dest) {
    mkdirSync(path.dirname(dest));
    fs.renameSync(src, dest);
}

// Helper to copy file
function copyFileSync(src, dest) {
    mkdirSync(path.dirname(dest));
    fs.copyFileSync(src, dest);
}

// Helper to remove directory recursively
function removeSync(dir) {
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// Detect languages from existing directory structure
function detectLanguages() {
    if (!fs.existsSync(postsDir)) {
        console.error(`Posts directory not found: ${postsDir}`);
        process.exit(1);
    }

    const entries = fs.readdirSync(postsDir, { withFileTypes: true });
    const langs = entries
        .filter(e => e.isDirectory())
        .filter(e => {
            // Check if this looks like a language folder (contains slug subdirectories with index.md)
            const langDir = path.join(postsDir, e.name);
            const subdirs = fs.readdirSync(langDir, { withFileTypes: true }).filter(d => d.isDirectory());
            return subdirs.some(d => {
                const indexPath = path.join(langDir, d.name, 'index.md');
                return fs.existsSync(indexPath);
            });
        })
        .map(e => e.name);

    return langs;
}

// Collect all posts from old structure
function collectPosts(languages) {
    const posts = new Map(); // slug -> { lang -> { content, files } }

    for (const lang of languages) {
        const langDir = path.join(postsDir, lang);
        if (!fs.existsSync(langDir)) continue;

        const slugDirs = fs.readdirSync(langDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);

        for (const slug of slugDirs) {
            const postDir = path.join(langDir, slug);
            const indexPath = path.join(postDir, 'index.md');

            if (!fs.existsSync(indexPath)) {
                console.warn(`  Warning: No index.md found in ${postDir}`);
                continue;
            }

            // Get all files in the post directory
            const files = fs.readdirSync(postDir);
            const content = fs.readFileSync(indexPath, 'utf-8');

            // Get or create post entry
            if (!posts.has(slug)) {
                posts.set(slug, new Map());
            }

            posts.get(slug).set(lang, {
                content,
                files: files.filter(f => f !== 'index.md'), // Other files (media)
                sourcePath: postDir
            });
        }
    }

    return posts;
}

// Migrate posts to new structure
async function migrate(languages, posts) {
    console.log(`\nMigrating ${posts.size} posts...`);
    console.log(`Languages: ${languages.join(', ')}`);
    console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}\n`);

    // Create temporary directory for new structure
    const tempDir = path.join(postsDir, '_new_structure');
    if (!dryRun) {
        mkdirSync(tempDir);
    }

    for (const [slug, langVersions] of posts) {
        console.log(`\nPost: ${slug}`);

        const newPostDir = path.join(tempDir, slug);
        if (!dryRun) {
            mkdirSync(newPostDir);
        }

        // Collect all media files (they should be shared)
        const allMedia = new Set();

        for (const [lang, data] of langVersions) {
            console.log(`  ${lang}: ${data.sourcePath}/index.md -> ${slug}/${lang}.md`);

            // Create new language file
            const newFilePath = path.join(newPostDir, `${lang}.md`);
            if (!dryRun) {
                fs.writeFileSync(newFilePath, data.content);
            }

            // Collect media files
            for (const file of data.files) {
                allMedia.add({ file, source: path.join(data.sourcePath, file) });
            }
        }

        // Copy media files (only once, even if present in multiple language dirs)
        const copiedMedia = new Set();
        for (const { file, source } of allMedia) {
            if (copiedMedia.has(file)) continue;

            const dest = path.join(newPostDir, file);
            console.log(`  media: ${file}`);
            if (!dryRun) {
                copyFileSync(source, dest);
            }
            copiedMedia.add(file);
        }
    }

    if (dryRun) {
        console.log('\n--- DRY RUN COMPLETE ---');
        console.log('No changes were made. Run without --dry-run to apply changes.');
        return;
    }

    // Create backup of old structure
    const backupDir = path.join(postsDir, '_old_structure_backup');
    console.log(`\nCreating backup at: ${backupDir}`);

    for (const lang of languages) {
        const langDir = path.join(postsDir, lang);
        if (fs.existsSync(langDir)) {
            const backupLangDir = path.join(backupDir, lang);
            moveSync(langDir, backupLangDir);
        }
    }

    // Move new structure to posts/
    console.log('Moving new structure into place...');
    const newPostDirs = fs.readdirSync(tempDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

    for (const slug of newPostDirs) {
        const src = path.join(tempDir, slug);
        const dest = path.join(postsDir, slug);
        moveSync(src, dest);
    }

    // Remove temp dir
    removeSync(tempDir);

    console.log('\n--- MIGRATION COMPLETE ---');
    console.log(`Backup of old structure: ${backupDir}`);
    console.log('Please verify the new structure and then delete the backup if everything is correct.');
}

// Main
async function main() {
    console.log('=== Posts Migration Script ===');
    console.log(`Content directory: ${path.resolve(contentDir)}`);

    const languages = detectLanguages();

    if (languages.length === 0) {
        console.log('No language directories found. The structure may already be migrated.');
        console.log('Expected old structure: posts/{lang}/{slug}/index.md');
        process.exit(0);
    }

    console.log(`Detected languages: ${languages.join(', ')}`);

    const posts = collectPosts(languages);
    console.log(`Found ${posts.size} unique posts`);

    await migrate(languages, posts);
}

main().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
