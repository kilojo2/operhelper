/**
 * Editable music-slot presets with a one-time migration from oh_music_v1.
 * Defaults fill empty legacy slots once; later user edits (including clearing a
 * field) are kept in oh_music_v2 and are never overwritten on reload.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MusicPresets = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const SLOT_COUNT = 10;
  const STORAGE_KEY = 'oh_music_v2';
  const LEGACY_KEY = 'oh_music_v1';
  const DEFAULT_URLS = Object.freeze([
    'https://www.youtube.com/watch?v=C5o3Ofg2mWs',
    'https://www.youtube.com/watch?v=Vy5DPb-T2ls&pp=0gcJCS0MAYcqIYzv',
    'https://www.youtube.com/watch?v=mLrZZ-WJfZ4',
    'https://www.youtube.com/watch?v=lZYYbi5KJzY',
    'https://www.youtube.com/watch?v=scPYcaqEmMA'
  ]);

  function normalizeList(value) {
    const source = Array.isArray(value) ? value : [];
    return Array.from({ length: SLOT_COUNT }, (_, index) =>
      typeof source[index] === 'string' ? source[index].trim() : '');
  }

  function read(storage, key) {
    try {
      const value = JSON.parse(storage.getItem(key) || 'null');
      return Array.isArray(value) ? value : null;
    } catch { return null; }
  }

  function save(storage, value) {
    const list = normalizeList(value);
    try { storage.setItem(STORAGE_KEY, JSON.stringify(list)); }
    catch { /* private mode / storage disabled */ }
    return list;
  }

  function load(storage) {
    const current = read(storage, STORAGE_KEY);
    if (current && current.length === SLOT_COUNT) return normalizeList(current);

    const source = current || read(storage, LEGACY_KEY) || [];
    const migrated = normalizeList(source);
    for (let i = 0; i < DEFAULT_URLS.length; i++) {
      if (!migrated[i]) migrated[i] = DEFAULT_URLS[i];
    }
    return save(storage, migrated);
  }

  return { DEFAULT_URLS, LEGACY_KEY, SLOT_COUNT, STORAGE_KEY, load, save };
});
