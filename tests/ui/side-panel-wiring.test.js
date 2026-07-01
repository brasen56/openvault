// tests/ui/side-panel-wiring.test.js
//
// Static guard for the dossier action-button delegation contract.
//
// The side panel routes ALL dossier action buttons (drift scan, mark-wrong,
// merge, resolve, skip, canon notes, copy/export, etc.) through ONE delegated
// click handler keyed on `data-action`. Two CSS classes can mark a button as a
// participant:
//   - `openvault-export-import-btn`  (legacy marker; shared with export panel)
//   - `openvault-dossier-action-btn` (dossier-scoped marker, added in Phase 1/2/3)
//
// Regression being guarded: commit 9ca484f rendered several Phase 1/2/3 buttons
// with ONLY `openvault-dossier-action-btn`, while the delegation selector
// matched ONLY `.openvault-export-import-btn`. The result was silently-dead
// buttons — the "Scan for drift" button being the reported symptom. The fix
// broadened the selector to match BOTH markers; these tests pin that contract
// so it cannot regress without failing here.
//
// (A true event-dispatch test isn't possible here because tests/setup.js ships a
// no-op jQuery mock whose `.on()` records nothing. A static selector scan is
// the lowest-overhead guard that still exercises the actual wiring line.)

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const SIDE_PANEL_SRC = readFileSync(resolve(process.cwd(), 'src/ui/side-panel.js'), 'utf-8');

describe('side-panel dossier action delegation', () => {
    // Find the delegated click handler that routes dossier `data-action`
    // buttons. Anchored on `dossier-run-drift-scan` in the handler body so we
    // pinpoint THIS delegation (the file has several other `.on('click', …)`
    // calls). The selector is captured as a whole quoted string so an embedded
    // comma (the two-class selector) doesn't truncate the capture.
    const HANDLER_RE =
        /\$panel\.on\(\s*['"]click['"]\s*,\s*('[^']*'|"[^"]*")\s*,\s*async function[\s\S]*?dossier-run-drift-scan/;
    const handlerMatch = SIDE_PANEL_SRC.match(HANDLER_RE);
    const selector = handlerMatch ? handlerMatch[1] : '';

    it('binds a delegated click handler that routes dossier actions', () => {
        expect(handlerMatch, 'could not find the dossier data-action delegated handler').not.toBeNull();
    });

    it('the delegation selector matches the legacy export-import marker', () => {
        expect(selector).toContain('openvault-export-import-btn');
    });

    it('the delegation selector matches the dossier-scoped marker', () => {
        // This is the assertion that would have caught the bug: the Phase 1/2/3
        // buttons (drift scan, resolve, skip, etc.) are rendered with only this
        // class, so the selector MUST include it.
        expect(selector).toContain('openvault-dossier-action-btn');
    });

    it('routes the dossier-run-drift-scan action to a handler', () => {
        // Belt-and-suspenders: confirm the specific reported action key is
        // present and wired to its handler in the router's if/else chain.
        expect(SIDE_PANEL_SRC).toContain('dossier-run-drift-scan');
        expect(SIDE_PANEL_SRC).toMatch(/handleRunDriftScan\s*\(/);
    });
});
