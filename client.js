/**
 * Client half of the background bundle.
 *
 * The appearance is produced through two framework mechanisms only:
 *   - `ctx.theme.overrideTokens` makes the host's own surface colours
 *     translucent, so the wallpaper shows through them;
 *   - a global stylesheet rendered from a slot entry paints the wallpaper on
 *     `body::before` and its readability veil on `body::after`, on the root
 *     stacking context's negative axis (below every piece of interface).
 *
 * Artwork comes either from the device's photo picker (stored as a Blob in
 * IndexedDB — localStorage is far too small for photos) or from a URL.
 *
 * The plugin writes no DOM outside its own React elements and styles only with
 * `--dsw-*` theme tokens.
 */
window.__ModuleLoader__.load({
  id: 'dsh-ui-background',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = 'dshUiBackground';
    /** Durable key: appearance is a global preference, not session state. */
    const STORAGE_KEY = 'dsh-ui-background:v1';
    /** IndexedDB database holding picked artwork. */
    const DB_NAME = 'dsh-ui-background';
    const DB_STORE = 'images';
    /** Longest edge a picked photo is downscaled to before storage. */
    const MAX_EDGE = 2560;
    /** Files larger than this are refused before any decoding work. */
    const MAX_FILE_BYTES = 32 * 1024 * 1024;

    const zh = {
      'section.title': '自定义背景',
      'section.desc': '用相册里的照片或网络图片作背景，并调节不透明度与模糊。',
      'type.label': '背景类型',
      'type.none': '无',
      'type.image': '图片',
      'type.color': '纯色',
      'source.label': '图片来源',
      'source.file': '相册',
      'source.url': '链接',
      'pick.label': '选择图片',
      'pick.replace': '更换图片',
      'pick.none': '尚未选择图片',
      'pick.selected': '已选择图片',
      'pick.reading': '正在处理图片…',
      'pick.failed': '这张图片无法读取，请换一张试试。',
      'pick.tooLarge': '图片太大（超过 32 MB），请换一张。',
      'pick.remove': '移除',
      'url.label': '图片地址',
      'url.placeholder': 'https://example.com/wallpaper.jpg',
      'url.invalid': '只支持 http(s)、相对路径或 data:image 地址。',
      'color.label': '背景颜色',
      'opacity.label': '不透明度',
      'opacity.hint': '数值越大背景越明显，界面越通透。',
      'blur.label': '模糊',
      'mode.label': '填充方式',
      'mode.cover': '填充',
      'mode.contain': '适应',
      'mode.repeat': '平铺',
    };
    const en = {
      'section.title': 'Custom background',
      'section.desc': 'Use a photo from your gallery or an image URL, with opacity and blur controls.',
      'type.label': 'Background type',
      'type.none': 'None',
      'type.image': 'Image',
      'type.color': 'Solid',
      'source.label': 'Image source',
      'source.file': 'Gallery',
      'source.url': 'URL',
      'pick.label': 'Choose image',
      'pick.replace': 'Replace image',
      'pick.none': 'No image chosen yet',
      'pick.selected': 'Image chosen',
      'pick.reading': 'Processing image…',
      'pick.failed': 'That image could not be read. Try another one.',
      'pick.tooLarge': 'That image is too large (over 32 MB). Try another one.',
      'pick.remove': 'Remove',
      'url.label': 'Image URL',
      'url.placeholder': 'https://example.com/wallpaper.jpg',
      'url.invalid': 'Only http(s), relative, or data:image addresses are supported.',
      'color.label': 'Background colour',
      'opacity.label': 'Opacity',
      'opacity.hint': 'Higher values show more background and a more translucent interface.',
      'blur.label': 'Blur',
      'mode.label': 'Fit',
      'mode.cover': 'Cover',
      'mode.contain': 'Contain',
      'mode.repeat': 'Tile',
    };

    const DEFAULTS = {
      type: 'none',
      imageSource: 'file',
      imageId: '',
      url: '',
      color: '#3b82f6',
      opacity: 35,
      blur: 0,
      mode: 'cover',
    };

    const TYPES = ['none', 'image', 'color'];
    const SOURCES = ['file', 'url'];
    const MODES = ['cover', 'contain', 'repeat'];
    const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

    function clamp(value, lo, hi) {
      const n = Number(value);
      if (!Number.isFinite(n)) return lo;
      return n < lo ? lo : n > hi ? hi : n;
    }

    //#region preference record

    /** Coerce an unknown value into a complete, safe preference record. */
    function sanitize(raw) {
      const input = raw !== null && typeof raw === 'object' ? raw : {};
      return {
        type: TYPES.indexOf(input.type) === -1 ? DEFAULTS.type : input.type,
        imageSource: SOURCES.indexOf(input.imageSource) === -1 ? DEFAULTS.imageSource : input.imageSource,
        imageId: typeof input.imageId === 'string' ? input.imageId.slice(0, 128) : DEFAULTS.imageId,
        url: typeof input.url === 'string' ? input.url.slice(0, 2048) : DEFAULTS.url,
        color: typeof input.color === 'string' && HEX_COLOR.test(input.color) ? input.color : DEFAULTS.color,
        opacity: Math.round(clamp(input.opacity === undefined ? DEFAULTS.opacity : input.opacity, 0, 100)),
        blur: Math.round(clamp(input.blur === undefined ? DEFAULTS.blur : input.blur, 0, 40)),
        mode: MODES.indexOf(input.mode) === -1 ? DEFAULTS.mode : input.mode,
        // Runtime-only: an object URL minted from the stored Blob. Never persisted.
        blobUrl: typeof input.blobUrl === 'string' ? input.blobUrl : '',
        blobUrlId: typeof input.blobUrlId === 'string' ? input.blobUrlId : '',
      };
    }

    /** The subset that survives a reload; object URLs are per-document. */
    function persistable(state) {
      return {
        type: state.type,
        imageSource: state.imageSource,
        imageId: state.imageId,
        url: state.url,
        color: state.color,
        opacity: state.opacity,
        blur: state.blur,
        mode: state.mode,
      };
    }

    /**
     * Whether a typed reference may be fetched as a CSS image at all. Only
     * same-origin-relative and http(s)/data:image URLs qualify; anything else
     * (`javascript:`, `file:`, …) is dropped rather than forwarded to the
     * style engine. The text survives in the field, so the user can fix it.
     */
    function isRenderableUrl(value) {
      const raw = String(value).trim();
      if (raw === '') return false;
      if (raw.startsWith('/') || raw.startsWith('./') || raw.startsWith('../')) return true;
      return /^(https?:)?\/\//i.test(raw) || /^data:image\//i.test(raw);
    }

    /** The CSS image reference the current preference resolves to, if any. */
    function resolveImageRef(state) {
      if (state.type !== 'image') return '';
      if (state.imageSource === 'file') {
        return state.blobUrl && state.blobUrlId === state.imageId ? state.blobUrl : '';
      }
      return isRenderableUrl(state.url) ? state.url.trim() : '';
    }

    /** Whether the preference currently paints anything worth showing through. */
    function isActive(state) {
      if (state.type === 'color') return true;
      return state.type === 'image' && resolveImageRef(state) !== '';
    }

    //#endregion
    //#region persistence

    function load() {
      try {
        return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'));
      } catch (error) {
        return Object.assign({}, DEFAULTS);
      }
    }

    function save(state) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(persistable(state)));
      } catch (error) {
        /* A private-mode or quota refusal only costs persistence, not appearance. */
      }
    }

    //#endregion
    //#region artwork storage (IndexedDB)

    let dbPromise = null;

    function openDb() {
      if (dbPromise !== null) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
          reject(new Error('IndexedDB unavailable'));
          return;
        }
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
      });
      dbPromise = dbPromise.catch((error) => {
        dbPromise = null;
        throw error;
      });
      return dbPromise;
    }

    function withStore(mode, run) {
      return openDb().then(
        (db) =>
          new Promise((resolve, reject) => {
            const tx = db.transaction(DB_STORE, mode);
            const store = tx.objectStore(DB_STORE);
            let result;
            try {
              result = run(store);
            } catch (error) {
              reject(error);
              return;
            }
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
            tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
          }),
      );
    }

    function putImage(id, blob) {
      return withStore('readwrite', (store) => store.put(blob, id));
    }

    function getImage(id) {
      return openDb().then(
        (db) =>
          new Promise((resolve, reject) => {
            const tx = db.transaction(DB_STORE, 'readonly');
            const request = tx.objectStore(DB_STORE).get(id);
            request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : null);
            request.onerror = () => reject(request.error || new Error('IndexedDB read failed'));
          }),
      );
    }

    function deleteImage(id) {
      return withStore('readwrite', (store) => store.delete(id)).catch(() => undefined);
    }

    //#endregion
    //#region image preparation

    /**
     * Downscale a picked photo so stored artwork stays small and painting stays
     * cheap. Uses `createImageBitmap`/`OffscreenCanvas` only, so no element is
     * ever attached to the document. Anything unsupported or undecodable falls
     * back to the original bytes rather than failing the pick.
     */
    async function prepareImage(file) {
      if (!(file instanceof Blob) || !/^image\//.test(file.type)) throw new Error('not an image');
      if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return file;
      if (file.type === 'image/gif') return file;
      let bitmap;
      try {
        bitmap = await createImageBitmap(file);
      } catch (error) {
        throw new Error('undecodable image');
      }
      try {
        const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
        if (scale >= 1 && file.size <= 2.5 * 1024 * 1024) return file;
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d');
        if (context === null) return file;
        context.drawImage(bitmap, 0, 0, width, height);
        const encoded = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
        return encoded.size > 0 && encoded.size < file.size ? encoded : file;
      } catch (error) {
        return file;
      } finally {
        if (bitmap && typeof bitmap.close === 'function') bitmap.close();
      }
    }

    function newImageId() {
      return 'img-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }

    //#endregion
    //#region store

    /** Minimal observable store shared by the wallpaper and the settings page. */
    function createStore(initial) {
      let state = initial;
      const listeners = new Set();
      const emit = () => {
        for (const listener of Array.from(listeners)) listener();
      };
      return {
        get() {
          return state;
        },
        set(patch) {
          state = sanitize(Object.assign({}, state, patch));
          save(state);
          emit();
        },
        /** Update without persisting; used for per-document object URLs. */
        setRuntime(patch) {
          state = Object.assign({}, state, patch);
          emit();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
    }

    function useStore(store) {
      const [state, setState] = React.useState(store.get());
      React.useEffect(() => store.subscribe(() => setState(store.get())), [store]);
      return state;
    }

    /**
     * Keep one object URL alive for the artwork the preference points at, and
     * drop the previous one. A later request supersedes an earlier one, so a
     * slow read can never publish a stale URL.
     */
    function createImageUrlSync(store) {
      let sequence = 0;
      let liveUrl = '';
      return {
        run() {
          const state = store.get();
          if (state.type !== 'image' || state.imageSource !== 'file' || state.imageId === '') {
            if (state.blobUrl !== '' || state.blobUrlId !== '') {
              store.setRuntime({ blobUrl: '', blobUrlId: '' });
            }
            if (liveUrl !== '') {
              URL.revokeObjectURL(liveUrl);
              liveUrl = '';
            }
            return Promise.resolve();
          }
          if (state.blobUrlId === state.imageId && state.blobUrl !== '') return Promise.resolve();
          const mine = ++sequence;
          return getImage(state.imageId)
            .catch(() => null)
            .then((blob) => {
              if (mine !== sequence) return;
              const superseded = liveUrl;
              const next = blob === null ? '' : URL.createObjectURL(blob);
              liveUrl = next;
              store.setRuntime({ blobUrl: next, blobUrlId: blob === null ? '' : state.imageId });
              if (superseded !== '' && superseded !== next) URL.revokeObjectURL(superseded);
            });
        },
        dispose() {
          sequence += 1;
          if (liveUrl !== '') {
            URL.revokeObjectURL(liveUrl);
            liveUrl = '';
          }
        },
      };
    }

    //#endregion
    //#region stylesheet

    /**
     * The global stylesheet painting the wallpaper.
     *
     * `body::before` carries the artwork with a blur bleed wider than the
     * maximum blur radius, so blurring never reveals transparent edges;
     * `body::after` carries the readability veil whose weight follows the
     * opacity slider.
     */
    function buildBackgroundCss(state) {
      if (!isActive(state)) return '';
      const visibility = clamp(state.opacity / 100, 0, 1);
      const veil = Math.round((1 - 0.9 * visibility) * 100);
      const blur = clamp(state.blur, 0, 40);
      const size = state.mode === 'contain' ? 'contain' : state.mode === 'repeat' ? 'auto' : 'cover';
      const repeat = state.mode === 'repeat' ? 'repeat' : 'no-repeat';
      const reference = resolveImageRef(state);
      const image = reference === '' ? 'none' : 'url("' + escapeUrl(reference) + '")';
      // A wallpaper's own transparent pixels must fall back to the theme's
      // base colour, never to the browser's default canvas (white in dark mode).
      const solid = state.type === 'color' ? state.color : null;
      const backdrop = solid === null ? 'var(--dsw-static-neutral-bluish-00)' : solid;
      const backdropDark = solid === null ? 'var(--dsw-static-neutral-bluish-950)' : solid;
      return [
        // The bleed is wider than the 40px blur ceiling so the filter's edge
        // falloff always stays outside the viewport.
        'body::before{content:"";position:fixed;inset:-120px;z-index:-2;pointer-events:none;',
        'background-image:' + image + ';background-color:' + backdrop + ';',
        'background-repeat:' + repeat + ';background-position:center center;background-size:' + size + ';',
        'filter:blur(' + blur + 'px);}',
        'body[data-ds-dark-theme]::before{background-color:' + backdropDark + ';}',
        'body::after{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;background-color:',
        'color-mix(in srgb, var(--dsw-static-neutral-bluish-00) ' + veil + '%, transparent);}',
        'body[data-ds-dark-theme]::after{background-color:',
        'color-mix(in srgb, var(--dsw-static-neutral-bluish-950) ' + veil + '%, transparent);}',
      ].join('');
    }

    /**
     * Neutralize characters that would break out of a CSS `url("…")` token.
     * Whatever the source is, it is untrusted text, never CSS syntax.
     */
    function escapeUrl(value) {
      return String(value).replace(/["\\\n\r\t]/g, (ch) => (ch === '"' ? '%22' : ch === '\\' ? '%5C' : ''));
    }

    /**
     * Token layer letting the wallpaper through the host's own surfaces. Every
     * value derives from the active theme's static palette, so light and dark
     * both stay faithful; the veil above carries the user's opacity.
     */
    function tokenLayer(state) {
      if (!isActive(state)) return {};
      const visibility = clamp(state.opacity / 100, 0, 1);
      const layerPct = Math.round((1 - 0.55 * visibility) * 100);
      const sidePct = Math.round((1 - 0.7 * visibility) * 100);
      const tint = (light, dark, pct) => ({
        light: 'color-mix(in srgb, ' + light + ' ' + pct + '%, transparent)',
        dark: 'color-mix(in srgb, ' + dark + ' ' + pct + '%, transparent)',
      });
      return {
        '--dsw-alias-bg-base': { light: 'transparent', dark: 'transparent' },
        '--dsw-alias-bg-layer-1': tint(
          'var(--dsw-static-neutral-bluish-00)',
          'var(--dsw-static-neutral-bluish-950)',
          layerPct,
        ),
        '--dsw-alias-bg-layer-2': tint(
          'var(--dsw-static-neutral-bluish-00)',
          'var(--dsw-static-neutral-bluish-950)',
          layerPct,
        ),
        '--dsw-specific-sidebar-fill': tint(
          'var(--dsw-static-neutral-bluish-50)',
          'var(--dsw-static-neutral-bluish-900)',
          sidePct,
        ),
      };
    }

    //#endregion
    //#region components

    const SECTION_CSS = [
      '.dshbg-section{display:flex;flex-direction:column;color:var(--dsw-alias-label-primary)}',
      '.dshbg-head{padding:16px 0 12px;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.dshbg-title{font-size:14px;line-height:20px}',
      '.dshbg-desc{color:var(--dsw-alias-label-secondary);margin-top:4px;font-size:12px;line-height:18px}',
      '.dshbg-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:14px 0;',
      'border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.dshbg-row:last-child{border-bottom:none}',
      '.dshbg-label{font-size:14px;line-height:20px}',
      '.dshbg-hint{color:var(--dsw-alias-label-secondary);margin-top:4px;font-size:12px;line-height:18px}',
      '.dshbg-error{color:var(--dsw-alias-state-error-primary);margin-top:4px;font-size:12px;line-height:18px}',
      '.dshbg-control{display:flex;align-items:center;gap:8px;min-width:0;flex:none}',
      '.dshbg-input{box-sizing:border-box;width:320px;max-width:44vw;height:32px;padding:0 10px;',
      'border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l2);',
      'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);',
      'font-family:inherit;font-size:13px}',
      '.dshbg-input:focus-visible{outline:var(--dsw-focus-ring-width) solid ',
      'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.dshbg-button{box-sizing:border-box;height:32px;padding:0 14px;border-radius:var(--dsw-radius-sm);',
      'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);',
      'color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;cursor:pointer}',
      '.dshbg-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshbg-button:disabled{cursor:default;opacity:.5}',
      '.dshbg-button:focus-visible{outline:var(--dsw-focus-ring-width) solid ',
      'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.dshbg-ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}',
      '.dshbg-thumb{width:48px;height:32px;flex:none;object-fit:cover;border-radius:var(--dsw-radius-sm);',
      'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}',
      '.dshbg-color{box-sizing:border-box;width:44px;height:32px;padding:2px;',
      'border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l2);',
      'background:var(--dsw-alias-bg-layer-2);cursor:pointer}',
      '.dshbg-range{width:200px;accent-color:var(--dsw-alias-brand-primary)}',
      '.dshbg-value{min-width:44px;text-align:right;color:var(--dsw-alias-label-secondary);',
      'font-size:12px;font-variant-numeric:tabular-nums}',
      '.dshbg-seg{display:inline-flex;gap:2px;padding:2px;border-radius:var(--dsw-radius-sm);',
      'background:var(--dsw-alias-bg-layer-2)}',
      '.dshbg-segItem{height:26px;padding:0 12px;border:0;border-radius:var(--dsw-radius-sm);',
      'background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;',
      'font-size:12px;line-height:18px;cursor:pointer}',
      '.dshbg-segItem:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshbg-segItem:focus-visible{outline:var(--dsw-focus-ring-width) solid ',
      'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.dshbg-segItemActive{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
    ].join('');

    /** Paint the wallpaper: a global stylesheet keyed off the shared store. */
    function WallpaperStyle({ store }) {
      const state = useStore(store);
      return h('style', null, buildBackgroundCss(state));
    }

    function Segmented({ value, options, onChange }) {
      return h(
        'div',
        { className: 'dshbg-seg', role: 'group' },
        options.map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              className: 'dshbg-segItem' + (option.value === value ? ' dshbg-segItemActive' : ''),
              'aria-pressed': option.value === value,
              onClick: () => onChange(option.value),
            },
            option.label,
          ),
        ),
      );
    }

    function SliderRow({ label, value, min, max, hint, suffix, onChange }) {
      return h(
        'div',
        { className: 'dshbg-row' },
        h(
          'div',
          null,
          h('div', { className: 'dshbg-label' }, label),
          hint ? h('div', { className: 'dshbg-hint' }, hint) : null,
        ),
        h(
          'div',
          { className: 'dshbg-control' },
          h('input', {
            className: 'dshbg-range',
            type: 'range',
            min,
            max,
            step: 1,
            value,
            'aria-label': label,
            onChange: (event) => onChange(Number(event.target.value)),
          }),
          h('span', { className: 'dshbg-value' }, String(value) + suffix),
        ),
      );
    }

    /**
     * Gallery picking row. The hidden file input is the one element that opens
     * the platform's photo chooser; on Android it needs no permission grant.
     */
    function PickRow({ store, t }) {
      const state = useStore(store);
      const inputRef = React.useRef(null);
      const [busy, setBusy] = React.useState(false);
      const [failed, setFailed] = React.useState('');

      const onPick = async (event) => {
        const input = event.target;
        const file = input.files && input.files[0];
        input.value = '';
        if (!file) return;
        setFailed('');
        if (file.size > MAX_FILE_BYTES) {
          setFailed(t('pick.tooLarge'));
          return;
        }
        setBusy(true);
        const previousId = store.get().imageId;
        try {
          const prepared = await prepareImage(file);
          const id = newImageId();
          await putImage(id, prepared);
          store.set({ type: 'image', imageSource: 'file', imageId: id });
          if (previousId && previousId !== id) deleteImage(previousId);
        } catch (error) {
          setFailed(t('pick.failed'));
        } finally {
          setBusy(false);
        }
      };

      const onRemove = () => {
        const previousId = store.get().imageId;
        store.set({ imageId: '' });
        if (previousId) deleteImage(previousId);
      };

      const status = busy ? t('pick.reading') : state.imageId ? t('pick.selected') : t('pick.none');

      return h(
        'div',
        { className: 'dshbg-row' },
        h(
          'div',
          null,
          h('div', { className: 'dshbg-label' }, t('pick.label')),
          failed ? h('div', { className: 'dshbg-error', role: 'alert' }, failed) : h('div', { className: 'dshbg-hint' }, status),
        ),
        h(
          'div',
          { className: 'dshbg-control' },
          state.blobUrl ? h('img', { className: 'dshbg-thumb', src: state.blobUrl, alt: '' }) : null,
          h('input', {
            ref: inputRef,
            type: 'file',
            accept: 'image/*',
            style: { display: 'none' },
            tabIndex: -1,
            'aria-hidden': true,
            onChange: onPick,
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'dshbg-button',
              disabled: busy,
              onClick: () => {
                if (inputRef.current) inputRef.current.click();
              },
            },
            state.imageId ? t('pick.replace') : t('pick.label'),
          ),
          state.imageId
            ? h(
                'button',
                { type: 'button', className: 'dshbg-button dshbg-ghost', onClick: onRemove },
                t('pick.remove'),
              )
            : null,
        ),
      );
    }

    /** Settings page: type, artwork source, opacity, blur and fit. */
    function BackgroundSection({ store, t }) {
      const state = useStore(store);
      const typeOptions = TYPES.map((value) => ({ value, label: t('type.' + value) }));
      const sourceOptions = SOURCES.map((value) => ({ value, label: t('source.' + value) }));
      const modeOptions = MODES.map((value) => ({ value, label: t('mode.' + value) }));
      const urlInvalid = state.imageSource === 'url' && state.url.trim() !== '' && !isRenderableUrl(state.url);

      const rows = [
        h(
          'div',
          { className: 'dshbg-row', key: 'type' },
          h('div', { className: 'dshbg-label' }, t('type.label')),
          h(Segmented, { value: state.type, options: typeOptions, onChange: (type) => store.set({ type }) }),
        ),
      ];

      if (state.type === 'image') {
        rows.push(
          h(
            'div',
            { className: 'dshbg-row', key: 'source' },
            h('div', { className: 'dshbg-label' }, t('source.label')),
            h(Segmented, {
              value: state.imageSource,
              options: sourceOptions,
              onChange: (imageSource) => store.set({ imageSource }),
            }),
          ),
          state.imageSource === 'file'
            ? h(PickRow, { key: 'pick', store, t })
            : h(
                'div',
                { className: 'dshbg-row', key: 'url' },
                h(
                  'div',
                  null,
                  h('div', { className: 'dshbg-label' }, t('url.label')),
                  urlInvalid ? h('div', { className: 'dshbg-error', role: 'alert' }, t('url.invalid')) : null,
                ),
                h('input', {
                  className: 'dshbg-input',
                  type: 'url',
                  inputMode: 'url',
                  spellCheck: false,
                  value: state.url,
                  placeholder: t('url.placeholder'),
                  'aria-label': t('url.label'),
                  onChange: (event) => store.set({ url: event.target.value }),
                }),
              ),
          h(
            'div',
            { className: 'dshbg-row', key: 'mode' },
            h('div', { className: 'dshbg-label' }, t('mode.label')),
            h(Segmented, { value: state.mode, options: modeOptions, onChange: (mode) => store.set({ mode }) }),
          ),
        );
      }

      if (state.type === 'color') {
        rows.push(
          h(
            'div',
            { className: 'dshbg-row', key: 'color' },
            h('div', { className: 'dshbg-label' }, t('color.label')),
            h('input', {
              className: 'dshbg-color',
              type: 'color',
              value: state.color,
              'aria-label': t('color.label'),
              onChange: (event) => store.set({ color: event.target.value }),
            }),
          ),
        );
      }

      if (state.type !== 'none') {
        rows.push(
          h(SliderRow, {
            key: 'opacity',
            label: t('opacity.label'),
            hint: t('opacity.hint'),
            value: state.opacity,
            min: 0,
            max: 100,
            suffix: '%',
            onChange: (opacity) => store.set({ opacity }),
          }),
          h(SliderRow, {
            key: 'blur',
            label: t('blur.label'),
            value: state.blur,
            min: 0,
            max: 40,
            suffix: 'px',
            onChange: (blur) => store.set({ blur }),
          }),
        );
      }

      return h(
        React.Fragment,
        null,
        h('style', null, SECTION_CSS),
        h(
          'div',
          { className: 'dshbg-section' },
          h(
            'div',
            { className: 'dshbg-head' },
            h('div', { className: 'dshbg-title' }, t('section.title')),
            h('div', { className: 'dshbg-desc' }, t('section.desc')),
          ),
          rows,
        ),
      );
    }

    //#endregion

    return {
      inject: ['slots', 'locale', 'theme', 'timer'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'dsh-ui-background: zh dictionary');
        ctx.effect(() => ctx.locale.register(NS, 'en', en), 'dsh-ui-background: en dictionary');

        const store = createStore(load());
        const imageUrls = createImageUrlSync(store);
        imageUrls.run();

        // Surface transparency follows the store, coalesced: a drag on the
        // opacity slider must not publish a theme snapshot per input event.
        let layer = null;
        const publishTokens = () => {
          if (layer !== null) {
            layer();
            layer = null;
          }
          layer = ctx.theme.overrideTokens('surface', tokenLayer(store.get()));
        };
        const scheduleTokens = ctx.debounce(publishTokens, 60);
        publishTokens();

        ctx.effect(
          () =>
            store.subscribe(() => {
              imageUrls.run();
              scheduleTokens();
            }),
          'dsh-ui-background: preference changes',
        );
        ctx.effect(
          () => () => {
            scheduleTokens.dispose();
            imageUrls.dispose();
            if (layer !== null) {
              layer();
              layer = null;
            }
          },
          'dsh-ui-background: teardown',
        );

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'dsh-ui-background', order: -100, inject: () => ({ store }) },
            WallpaperStyle,
          ),
        );

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-ui-background',
              order: 25,
              label: () => t('section.title'),
              inject: () => ({ store, t }),
            },
            BackgroundSection,
          ),
        );
      },
    };
  },
});
