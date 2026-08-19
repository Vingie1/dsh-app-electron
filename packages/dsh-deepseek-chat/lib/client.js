/**
 * dsh-deepseek-chat — browser half.
 *
 * A single top-right corner button that toggles the chat side window. The
 * side window is a frameless Electron BrowserWindow docked to the main
 * window's right edge, embedding https://chat.deepseek.com in a <webview>
 * (the main process owns it: electron/chat-window.js + chat-panel.html).
 *
 * The button is plain DOM injected into the shell, self-healing via
 * MutationObserver. In Electron it drives the main-process window through
 * the sandbox-safe preload bridge (window.dshChat); in a plain browser it
 * degrades to opening the site in a new tab.
 *
 * Failure policy: DOM mounting problems are logged, never thrown (the web
 * shell fails the whole boot when a plugin apply throws).
 */

window.__ModuleLoader__.load({
	id: "dsh-deepseek-chat",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		//#region constants
		const NS = "dsh-deepseek-chat";
		const TARGET = "https://chat.deepseek.com/";
		const BUTTON_SELECTOR = "[data-dsh-chat-corner]";
		const STYLE_ID = "dsh-deepseek-chat-styles";
		// The corner button is the ONE blue whale: fixed DeepSeek brand blue
		// (#4D6BFE) regardless of theme — every other DSH icon stays default.
		const WHALE_SVG = '<svg fill="#4D6BFE" fill-rule="evenodd" viewBox="0 0 24 24" width="16" height="16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z"></path></svg>';
		//#endregion

		//#region locales
		const zh = { entry: "DeepSeek 快问", entryTip: "打开/关闭 DeepSeek 网页版（登录后可直接对话）" };
		const en = { entry: "DeepSeek Quick Chat", entryTip: "Open/close chat.deepseek.com in the side window" };
		//#endregion

		//#region stylesheet
		function ensureStyles() {
			if (document.getElementById(STYLE_ID) !== null) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = [
				// Top-right corner button: icon-only, fixed to the window edge.
				// Transparent at rest so only the blue whale floats on the
				// window background (no grey ring); a soft fill appears on
				// hover as feedback. Open/closed is not color-coded.
				".dshc-corner{position:fixed;top:14px;right:30px;z-index:39;width:28px;height:28px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;display:grid;place-items:center;padding:0;opacity:1;transition:background .12s ease}",
				".dshc-corner:hover{background:var(--dsw-alias-interactive-bg-hover)}",
				".dshc-corner svg{width:16px;height:16px}",
				// Full-page plugin panels (dsh-memoir memory page, dsh-ssh,
				// dsh-taskboard) replace the center column and own the
				// top-right corner; the convention is html[data-<panel>-active]
				// while open. Hide under them so the whale never overlaps a
				// panel's own controls (e.g. memoir's close button).
				"html[data-dsh-memoir-active] .dshc-corner,",
				"html[data-dsh-ssh-active] .dshc-corner,",
				"html[data-dsh-taskboard-active] .dshc-corner{display:none}",
				// dsh-memoir v0.4+ renders a bottom observability strip in the
				// panel (Hot Memory preview / Memory Diagnostics) with no
				// config to disable it — hide it. Scoped under .memoir-panel
				// (memoir page only) with higher specificity than memoir's
				// own single-class rules.
				".memoir-panel .memoir-inspector,.memoir-panel .memoir-diagnostics{display:none}",
				// --- dsh-memoir boot-race repair ---
				// The dsh service sometimes boots with a stale PARTIAL memoir
				// stylesheet (style[data-plugin="dsh-memoir"] ~600B with no
				// view rules). memoir's injectStyles() only checks tag
				// presence, so the full panel CSS never lands and the panel
				// mounts as an always-visible static block squeezed at the
				// column bottom-left. Re-assert the layout here (harmless
				// duplicates when memoir's own CSS is intact).
				"[data-dsh-memoir-view]{display:none !important}",
				"html[data-dsh-memoir-active] [data-dsh-memoir-view]{display:flex !important;flex-direction:column !important;position:absolute !important;inset:0 !important;z-index:20 !important;background:var(--bg-panel,#ffffff) !important;color:var(--text-primary,#1f2328) !important;font-size:13px !important}",
				"html[data-dsh-memoir-active] [class*=\"centerCol\"] > *:not([data-dsh-memoir-view]){display:none !important}",
				// panel skeleton, used when memoir's own CSS is missing
				"html[data-dsh-memoir-active] .memoir-panel{display:flex;flex-direction:column;height:100%;overflow:hidden}",
				"html[data-dsh-memoir-active] .memoir-header{display:flex;align-items:center;gap:8px;padding:12px 14px 8px}",
				"html[data-dsh-memoir-active] .memoir-title{font-size:15px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				"html[data-dsh-memoir-active] .memoir-subtitle{font-size:11px;opacity:.65;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				"html[data-dsh-memoir-active] .memoir-iconbtn{border:1px solid transparent;background:transparent;color:inherit;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:12px;display:inline-flex;align-items:center;gap:4px}",
				"html[data-dsh-memoir-active] .memoir-tabs{display:flex;gap:4px;padding:0 14px;border-bottom:1px solid var(--border,rgba(0,0,0,.1))}",
				"html[data-dsh-memoir-active] .memoir-tab{border:none;background:transparent;color:inherit;padding:7px 12px;cursor:pointer;font-size:13px;border-bottom:2px solid transparent;opacity:.75}",
				"html[data-dsh-memoir-active] .memoir-toolbar{display:flex;gap:8px;padding:8px 14px}",
				"html[data-dsh-memoir-active] .memoir-search{flex:1;border:1px solid var(--border,rgba(0,0,0,.15));background:transparent;color:inherit;border-radius:6px;padding:6px 10px;font-size:13px;outline:none}",
				"html[data-dsh-memoir-active] .memoir-primary{border:1px solid transparent;background:var(--accent,#3b82f6);color:#fff;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px}",
				"html[data-dsh-memoir-active] .memoir-body{flex:1;overflow-y:auto;padding:4px 14px 16px}",
				"html[data-dsh-memoir-active] .memoir-empty{padding:24px 14px;opacity:.75}"
			].join("\n");
			document.head.appendChild(style);
		}
		//#endregion

		//#region corner button
		/**
		 * Top-right icon button toggling the chat side window. Idempotent by
		 * selector, self-heals against shell re-renders.
		 */
		function mountCornerButton(t) {
			if (document.querySelector(BUTTON_SELECTOR) !== null) return () => {};
			const btn = document.createElement("button");
			btn.type = "button";
			btn.setAttribute("data-dsh-chat-corner", "");
			btn.setAttribute("data-dsh-plugin", "deepseek-chat");
			btn.className = "dshc-corner";
			btn.setAttribute("aria-label", t("entry"));
			btn.setAttribute("title", t("entryTip"));
			btn.innerHTML = WHALE_SVG;

			const bridge = () => window.dshChat;
			const doToggle = () => {
				const b = bridge();
				if (b !== undefined) b.toggle();
				else window.open(TARGET, "_blank", "noopener"); // plain browser: degrade
			};
			btn.addEventListener("click", doToggle);

			// Highlight from the main-process side-window state.
			const syncActive = (open) => {
				if (open) btn.dataset.active = "true";
				else delete btn.dataset.active;
			};
			let unsubscribe = () => {};
			const b = bridge();
			if (b !== undefined) {
				b.getState().then(syncActive).catch(() => {});
				unsubscribe = b.onStateChange(syncActive);
			}

			const tryPlace = () => {
				if (!btn.isConnected) document.body.appendChild(btn);
			};
			tryPlace();
			const observer = new MutationObserver(() => {
				if (!btn.isConnected) tryPlace();
			});
			observer.observe(document.body, { childList: true });

			return () => {
				observer.disconnect();
				unsubscribe();
				btn.remove();
			};
		}
		//#endregion

		//#region keyboard shortcut
		/**
		 * In-app shortcut (Ctrl+Shift+D) toggles the side window. Key events
		 * inside the panel never reach this window (separate document), so the
		 * shortcut cannot interfere with typing in the chat itself; it is
		 * suppressed over the host's own text inputs.
		 */
		function mountShortcut(t) {
			const onKey = (event) => {
				if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return;
				if (event.key !== "D" && event.key !== "d") return;
				const target = event.target;
				if (target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
				event.preventDefault();
				const b = window.dshChat;
				if (b !== undefined) b.toggle();
				else window.open(TARGET, "_blank", "noopener");
			};
			window.addEventListener("keydown", onKey, true);
			return () => window.removeEventListener("keydown", onKey, true);
		}
		//#endregion

		//#region apply
		/** Required services (locale for the dictionaries). */
		const inject = ["locale"];

		/**
		 * Register the locale dictionaries and mount the corner button.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), NS + ": dictionaries");
			if (document.querySelector(BUTTON_SELECTOR) !== null) return;
			const t = ctx.locale.bind(NS);
			const disposers = [];
			try {
				ensureStyles();
				disposers.push(mountCornerButton(t));
				disposers.push(mountShortcut(t));
			} catch (error) {
				// DOM failures degrade the plugin, never the GUI.
				console.warn("[dsh-deepseek-chat] mount failed:", error);
			}
			ctx.effect(() => () => {
				for (const dispose of disposers.splice(0)) dispose();
			}, NS + ": ui mounts");
		}
		//#endregion

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
