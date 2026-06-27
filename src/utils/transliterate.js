import { cdnImport } from './cdn.js';

// @ts-check

// @ts-expect-error - No types available for CDN import
const CyrillicToTranslit = (await cdnImport('cyrillic-to-translit-js')).default;
const translit = new CyrillicToTranslit({ preset: 'ru' });

export const CYRILLIC_RE = /\p{Script=Cyrillic}/u;

/**
 * Transliterate a Cyrillic string to Latin characters.
 * Non-Cyrillic characters pass through unchanged.
 * Result is always lowercased for key comparison.
 *
 * @param {string} str - Input string (may contain Cyrillic)
 * @returns {string} Lowercased Latin transliteration
 */
export function transliterateCyrToLat(str) {
    if (!str) return '';
    return translit.transform(str).toLowerCase();
}

/**
 * Compute Levenshtein edit distance between two strings.
 * Standard O(n*m) dynamic programming implementation.
 *
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {number} Edit distance
 */
export function levenshteinDistance(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    // Use single-row optimization: only need previous row + current row
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    let curr = new Array(b.length + 1);

    for (let i = 1; i <= a.length; i++) {
        curr[0] = i;
        for (let j = 1; j <= b.length; j++) {
            if (a[i - 1] === b[j - 1]) {
                curr[j] = prev[j - 1];
            } else {
                curr[j] = 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
            }
        }
        [prev, curr] = [curr, prev];
    }
    return prev[b.length];
}

/**
 * Tokenize a name into normalized word tokens for subset matching.
 * Lowercases, drops possessive suffixes ("Alex's" -> "alex"), and splits on
 * any run of non-alphanumeric characters (whitespace, hyphens, punctuation).
 *
 * @param {string} str - Name string
 * @returns {string[]} Normalized, non-empty tokens
 */
export function tokenizeName(str) {
    return str
        .toLowerCase()
        .replace(/['’]s\b/gu, '')
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length > 0);
}

/**
 * Resolve a character name against a list of known canonical names. Tries, in
 * order: exact (case-insensitive) match, first-name<->full-name token-subset
 * match, then cross-script matching via transliteration + Levenshtein distance.
 *
 * The subset tier lets a partial name snap onto a fuller canonical one
 * (e.g. "Alex" or "Hiro" -> "Alex Hiro"), which prevents bare-name extractions
 * from spawning duplicate characters alongside their full-named selves. It only
 * fires when exactly ONE canonical name contains all of the input's tokens —
 * ambiguous cases (e.g. "Alex" with both "Alex Hiro" and "Alex Wong" present)
 * are deliberately left unresolved rather than guessing.
 *
 * @param {string} name - Character name to resolve (may be Cyrillic or Latin)
 * @param {string[]} canonicalNames - Known canonical character names
 * @param {number} [maxDistance=2] - Maximum Levenshtein distance for fuzzy matching
 * @returns {string|null} Matching canonical name, or null if no match
 */
export function resolveCharacterName(name, canonicalNames, maxDistance = 2) {
    const lower = name.toLowerCase().replace(/\s+/g, ' ').trim();

    // Exact case-insensitive match
    for (const canonical of canonicalNames) {
        if (canonical.toLowerCase() === lower) return canonical;
    }

    // First-name <-> full-name (token-subset) match. A name whose tokens are a
    // proper subset of exactly one canonical name resolves to that canonical.
    // Tokens shorter than 2 chars are ignored to avoid initial/noise matches.
    const nameTokens = tokenizeName(name);
    if (nameTokens.length > 0 && nameTokens.every((t) => t.length >= 2)) {
        let subsetMatch = null;
        let subsetCount = 0;
        for (const canonical of canonicalNames) {
            const canonTokens = tokenizeName(canonical);
            // Require a strictly fuller canonical so we never "resolve" to an equal
            // or shorter name (exact equality is already handled above).
            if (canonTokens.length <= nameTokens.length) continue;
            if (nameTokens.every((t) => canonTokens.includes(t))) {
                subsetMatch = canonical;
                subsetCount++;
                if (subsetCount > 1) break;
            }
        }
        if (subsetCount === 1) return subsetMatch;
    }

    // Cross-script match via transliteration
    const isCyrillic = CYRILLIC_RE.test(lower);
    if (isCyrillic) {
        const translit = transliterateCyrToLat(lower);
        for (const canonical of canonicalNames) {
            if (!CYRILLIC_RE.test(canonical) && levenshteinDistance(translit, canonical.toLowerCase()) <= maxDistance) {
                return canonical;
            }
        }
    } else {
        for (const canonical of canonicalNames) {
            if (
                CYRILLIC_RE.test(canonical) &&
                levenshteinDistance(transliterateCyrToLat(canonical.toLowerCase()), lower) <= maxDistance
            ) {
                return canonical;
            }
        }
    }

    return null;
}
