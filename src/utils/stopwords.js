/**
 * OpenVault Unified Stopword Module
 *
 * Single source of truth for all stopword filtering.
 * Imports base stopwords from 'stopword' package (EN + RU).
 */

import { cdnImport } from './cdn.js';

const { eng, rus, removeStopwords: _removeStopwords } = await cdnImport('stopword');

// Unified export - lowercase for case-insensitive matching
export const ALL_STOPWORDS = new Set([...eng, ...rus].map((w) => w.toLowerCase()));

// Re-export utility function from package
export const removeStopwords = _removeStopwords;
