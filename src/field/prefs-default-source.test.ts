import { describe, expect, it } from 'vitest';
import { DEFAULT_INSPECTION_PREFS as EDITOR_PACKAGE_DEFAULT } from '@inspectorhub/field-ui';
import { DEFAULT_INSPECTION_PREFS } from './resources-library';

// The native client used to keep its own copy of the editor's preference defaults, and the copy drifted from the
// package it wraps (agent repair access and report-link expiry were fixed in one and not the other). It now uses the
// package's constant, so a default can only be changed in one place.
describe('editor preference defaults', () => {
    it('are the editor package\'s own constant, not a second copy', () => {
        expect(DEFAULT_INSPECTION_PREFS).toBe(EDITOR_PACKAGE_DEFAULT);
    });
});
