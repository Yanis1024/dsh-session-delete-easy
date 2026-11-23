/**
 * dsh-session-delete-easy — Client half.
 *
 * Adds a "Delete session" row to the sidebar's Session menu and one
 * confirmation dialog in the frame-wide overlay. The dialog is the only place
 * a deletion is authorized; the row only raises the request. The Host half
 * owns the operation and answers it over `POST /api/session-delete-easy`.
 *
 * Plain browser JavaScript: no JSX, no imports, no harness Client package.
 */
(() => {
  try {
    window.__ModuleLoader__.load({
      id: 'dsh-session-delete-easy',
      factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

        var React = require('react');
        var h = React.createElement;

        var ROUTE = '/api/session-delete-easy';
        var DESCRIPTION_ID = 'dsh-session-delete-easy-description';

        // Keys the host's shared `common` namespace already carries — `cancel`,
        // `close`, and `delete` — are deliberately absent here: the locale
        // service resolves a missing key through the active language's fallback
        // chain and then through `common`, so those three buttons follow every
        // language the app ships instead of only the two dictionaries below.
        var STRINGS = {
          en: {
            'menu.delete': 'Delete session',
            'dialog.title': 'Delete session',
            'dialog.desc': 'Permanently deletes “{title}”? Its conversation log, workspace position, archive and pin state, and cached projections are removed. This cannot be undone.',
            'dialog.descUntitled': 'Permanently deletes this session? Its conversation log, workspace position, archive and pin state, and cached projections are removed. This cannot be undone.',
            'dialog.active': 'If this session is still open in the harness, it is hidden right away and its log is removed the next time the harness starts.',
            'dialog.busy': 'Deleting…',
            'dialog.failed': 'The session could not be deleted.',
            'dialog.pending': 'The session is hidden. Its log will be removed the next time the harness starts.',
            'dialog.notMarked': 'The session is hidden, but it could not be marked for deletion. Delete it again after restarting the harness.',
            'dialog.nothing': 'This session is still open and has no stored log yet, so there is nothing to delete.',
          },
          zh: {
            'menu.delete': '删除会话',
            'dialog.title': '删除会话',
            'dialog.desc': '永久删除“{title}”？该会话的对话日志、工作区位置、归档/置顶状态与投影缓存都会被清除，且无法恢复。',
            'dialog.descUntitled': '永久删除该会话？它的对话日志、工作区位置、归档/置顶状态与投影缓存都会被清除，且无法恢复。',
            'dialog.active': '如果该会话仍在本 harness 中打开，它会立刻被隐藏，日志在下次启动 harness 时删除。',
            'dialog.busy': '删除中…',
            'dialog.failed': '会话删除失败。',
            'dialog.pending': '会话已隐藏，日志将在下次启动 harness 时删除。',
            'dialog.notMarked': '会话已隐藏，但没能标记为待删除。请重启 harness 后再删除一次。',
            'dialog.nothing': '该会话仍处于打开状态，且还没有落盘的日志，因此没有可删除的内容。',
          },
        };

        // The workspace's own controls grow on touch; a 30px row is below the
        // 44px target a coarse pointer needs.
        var coarsePointer = typeof window !== 'undefined'
          && typeof window.matchMedia === 'function'
          && window.matchMedia('(pointer: coarse)').matches;
        var ROW_PADDING = coarsePointer ? '10px 12px' : '6px 10px';
        var BUTTON_PADDING = coarsePointer ? '10px 16px' : '6px 14px';

        // --- pending-request store shared by the menu row and the overlay -----
        // The menu entry and the overlay entry are independent registrations, so
        // the request travels through one module-level store both read.
        var pending = null;
        var listeners = new Set();
        function setPending(next) {
          pending = next;
          listeners.forEach((listener) => {
            try { listener(); } catch (error) { /* one listener must not break the rest */ }
          });
        }
        function subscribe(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        }
        function getPending() { return pending; }

        // --- host call -------------------------------------------------------
        function requestHost(payload) {
          return fetch(ROUTE, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }).then((response) => response.json().catch(() => ({})).then((body) => {
            if (!response.ok || body === null || body.ok !== true) {
              throw new Error((body && body.error) || ('HTTP ' + response.status));
            }
            return body.result;
          }));
        }

        function format(template, values) {
          return String(template).replace(/\{(\w+)\}/g, (match, key) => (
            Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
          ));
        }

        // --- menu row -------------------------------------------------------
        function TrashIcon() {
          return h('svg', {
            viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none',
            stroke: 'currentColor', strokeWidth: 1.3,
            strokeLinecap: 'round', strokeLinejoin: 'round',
            'aria-hidden': true,
            style: { flex: 'none', display: 'block' },
          },
          h('path', { d: 'M2.6 4.2h10.8' }),
          h('path', { d: 'M6 4.2V2.9a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.3' }),
          h('path', { d: 'M3.9 4.2l.6 8.4a1.7 1.7 0 0 0 1.7 1.6h3.6a1.7 1.7 0 0 0 1.7-1.6l.6-8.4' }),
          h('path', { d: 'M6.6 6.9v4.6M9.4 6.9v4.6' }));
        }

        function DeleteMenuRow(props) {
          var t = props.t;
          // Read the menu's open-state pair during render, as the slot's own
          // example does: the hook is a plain closure today, and calling it from
          // an event handler would silently stop closing the menu if that ever
          // changed to a real React hook.
          var menu = props.useMenuOpenState();
          var hovered = React.useState(false);
          var isHovered = hovered[0];
          var setHovered = hovered[1];
          return h('button', {
            type: 'button',
            role: 'menuitem',
            'data-plugin': 'dsh-session-delete-easy',
            onMouseEnter: () => setHovered(true),
            onMouseLeave: () => setHovered(false),
            onClick: () => {
              // The shared menu restores focus to this row and dismisses itself
              // when it closes; the dialog takes over from there.
              try { if (menu && typeof menu[1] === 'function') menu[1](false); } catch (error) { /* opening the dialog still works */ }
              setPending({
                sessionId: String(props.sessionId),
                displayTitle: props.displayTitle === undefined ? '' : String(props.displayTitle),
              });
            },
            style: {
              display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
              padding: ROW_PADDING, border: '0', borderRadius: '6px', cursor: 'pointer',
              font: 'inherit', fontSize: '13px', lineHeight: '18px', textAlign: 'left',
              background: isHovered ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
              // The row carries the destructive color itself: the legacy menu
              // slot has no `danger` concept, and this action cannot be undone.
              color: 'var(--dsw-alias-state-error-primary)',
            },
          }, h(TrashIcon, null), h('span', null, t('menu.delete')));
        }

        // --- confirmation dialog --------------------------------------------
        function ConfirmOverlay(props) {
          var request = React.useSyncExternalStore(subscribe, getPending, getPending);
          if (request === null) return null;
          return h(ConfirmDialog, {
            key: request.sessionId,
            sessionId: request.sessionId,
            displayTitle: request.displayTitle,
            t: props.t,
          });
        }

        /** The message one settled outcome deserves, from the Host's own status. */
        function settledMessage(result, t) {
          switch (result && result.status) {
            case 'pending-restart': return t('dialog.pending');
            case 'archived': return t('dialog.notMarked');
            case 'active': return t('dialog.nothing');
            default:
              // An outcome this build does not know: show the Host's explanation
              // rather than inventing one.
              return result && typeof result.message === 'string' && result.message.length > 0
                ? result.message
                : t('dialog.pending');
          }
        }

        function ConfirmDialog(props) {
          var t = props.t;
          var busy = React.useState(false);
          var isBusy = busy[0];
          var setBusy = busy[1];
          var error = React.useState(null);
          var errorMessage = error[0];
          var setError = error[1];
          var outcome = React.useState(null);
          var settled = outcome[0];
          var setSettled = outcome[1];
          var dialogRef = React.useRef(null);
          var cancelRef = React.useRef(null);

          // Focus the safe action, never the destructive one: a stray Enter must
          // not be able to confirm a permanent deletion.
          React.useEffect(() => {
            var previous = document.activeElement;
            if (cancelRef.current) cancelRef.current.focus();
            return () => {
              if (previous && typeof previous.focus === 'function' && previous.isConnected) {
                try { previous.focus(); } catch (error0) { /* a detached trigger cannot take focus */ }
              }
            };
          }, []);

          // Escape is claimed in the capture phase and isolated, so no behind-the
          // -dialog handler also answers it; Tab is confined to the dialog.
          React.useEffect(() => {
            var onKeyDown = (event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                if (!isBusy) setPending(null);
                return;
              }
              if (event.key !== 'Tab') return;
              var root = dialogRef.current;
              if (root === null) return;
              var focusable = root.querySelectorAll('button:not(:disabled)');
              if (focusable.length === 0) return;
              var first = focusable[0];
              var last = focusable[focusable.length - 1];
              var active = document.activeElement;
              if (event.shiftKey && (active === first || !root.contains(active))) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && (active === last || !root.contains(active))) {
                event.preventDefault();
                first.focus();
              }
            };
            document.addEventListener('keydown', onKeyDown, true);
            return () => { document.removeEventListener('keydown', onKeyDown, true); };
          }, [isBusy]);

          var close = () => { if (!isBusy) setPending(null); };
          var confirm = () => {
            if (isBusy) return;
            setBusy(true);
            setError(null);
            requestHost({ action: 'delete', sessionId: props.sessionId }).then((result) => {
              setBusy(false);
              if (result && result.status === 'deleted') {
                // The row disappears from the workspace stream (and from the
                // session list), so the dialog has nothing left to report.
                setPending(null);
                return;
              }
              // Every other outcome leaves the log on disk or needs a restart, so
              // the dialog stays open and says so.
              setSettled(result);
            }).catch((reason) => {
              setBusy(false);
              setError(reason instanceof Error ? reason.message : String(reason));
            });
          };

          var outline = {
            padding: BUTTON_PADDING, borderRadius: '6px', cursor: isBusy ? 'default' : 'pointer',
            font: 'inherit', fontSize: '13px', lineHeight: '18px',
            border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
            color: 'var(--dsw-alias-label-primary)', opacity: isBusy ? 0.6 : 1,
          };
          // The host's own Archive dialog marks its destructive action the same
          // way — an outline button whose label carries the error color — so the
          // two dialogs read as one family.
          var destructive = {
            padding: BUTTON_PADDING, borderRadius: '6px', cursor: isBusy ? 'default' : 'pointer',
            font: 'inherit', fontSize: '13px', lineHeight: '18px',
            border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
            color: 'var(--dsw-alias-state-error-primary)', opacity: isBusy ? 0.6 : 1,
          };
          var note = {
            fontSize: '12px', lineHeight: '18px', marginTop: '10px',
            color: 'var(--dsw-alias-label-secondary)',
          };

          var description = props.displayTitle.length > 0
            ? format(t('dialog.desc'), { title: props.displayTitle })
            : t('dialog.descUntitled');

          return h('div', {
            'data-plugin': 'dsh-session-delete-easy',
            onClick: (event) => { if (event.target === event.currentTarget) close(); },
            style: {
              position: 'fixed', inset: 0, zIndex: 1200, display: 'flex',
              alignItems: 'center', justifyContent: 'center',
              // Keep clear of the macOS window chrome the frame reserves at the top.
              padding: 'max(24px, var(--dsh-frame-overlay-top, 24px)) 24px',
              background: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.4))',
              backdropFilter: 'var(--dsw-mask-blur, none)',
              // `shell.overlay` is a click-through layer: an occupant opts back
              // into pointer events itself, so this dialog stays interactive
              // whatever wrapper the slot renders between the layer and here.
              pointerEvents: 'auto',
            },
          }, h('div', {
            ref: dialogRef,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('dialog.title'),
            'aria-describedby': DESCRIPTION_ID,
            style: {
              width: '100%', maxWidth: '380px', boxSizing: 'border-box',
              padding: '18px', borderRadius: 'var(--dsw-radius-panel, 10px)',
              background: 'var(--dsw-alias-bg-layer-2)',
              border: '1px solid var(--dsw-alias-border-l1)',
              boxShadow: 'var(--dsw-elevation-prominent, 0 12px 32px rgba(0, 0, 0, 0.28))',
              color: 'var(--dsw-alias-label-primary)', font: 'inherit',
            },
          },
          h('h2', { style: { margin: '0 0 8px', fontSize: '15px', fontWeight: 600 } }, t('dialog.title')),
          h('div', {
            id: DESCRIPTION_ID,
            style: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' },
          }, description),
          h('div', { style: note }, t('dialog.active')),
          settled !== null
            ? h('div', {
              role: 'status',
              style: Object.assign({}, note, { color: 'var(--dsw-alias-state-warn-primary)' }),
            }, settledMessage(settled, t))
            : null,
          errorMessage !== null
            ? h('div', { role: 'alert', style: { marginTop: '10px' } },
              h('div', { style: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' } }, t('dialog.failed')),
              h('div', { style: note }, errorMessage))
            : null,
          isBusy ? h('div', { role: 'status', style: note }, t('dialog.busy')) : null,
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' } },
            settled !== null
              ? h('button', { type: 'button', style: outline, onClick: close }, t('close'))
              : [
                h('button', { key: 'cancel', ref: cancelRef, type: 'button', style: outline, disabled: isBusy, onClick: close }, t('cancel')),
                h('button', {
                  key: 'confirm', type: 'button', style: destructive, disabled: isBusy, onClick: confirm,
                }, t('delete')),
              ])));
        }

        // --- plugin ----------------------------------------------------------
        var inject = ['slots'];

        function apply(ctx) {
          var locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
          var t = (key) => (STRINGS.en[key] === undefined ? key : STRINGS.en[key]);
          if (locale !== undefined && typeof locale.register === 'function' && typeof locale.bind === 'function') {
            try {
              ctx.effect(() => locale.register('sessionDelete', STRINGS));
              var bound = locale.bind('sessionDelete');
              t = (key, values) => bound(key, values);
            } catch (error) {
              console.warn('[dsh-session-delete-easy] locale registration failed; English labels stay in use', error);
            }
          }

          ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
            name: 'sidebar.workspaces.session.menu.item',
            id: 'session-delete-easy:menu',
            order: 550,
          }, (props) => h(DeleteMenuRow, Object.assign({}, props, { t }))));

          ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: 'session-delete-easy:dialog',
            order: 950,
          }, (props) => h(ConfirmOverlay, { t })));
        }

        exports.name = 'dsh-session-delete-easy';
        exports.inject = inject;
        exports.apply = apply;
        return module.exports;
      },
    });
  } catch (error) {
    console.warn('[dsh-session-delete-easy] Client half failed to load:', error);
  }
})();
