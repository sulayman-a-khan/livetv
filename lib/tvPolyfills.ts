/**
 * Minimal runtime shims for old smart-TV browser engines (Tizen / webOS,
 * roughly Chrome 38–63 and Safari 9). Next.js already down-levels *syntax*
 * (optional chaining, nullish coalescing, async/await) via the browserslist
 * target, and bundles core-js polyfills for common built-ins — but it does NOT
 * polyfill DOM/observer APIs. These are the handful the app actually touches
 * that are missing on those engines. Every shim is a no-op guard: if the real
 * API exists, nothing here runs.
 *
 * Import this module for its side effects at the very top of each client entry
 * point (watch page, home page, admin dashboard) so it is evaluated before any
 * component render/effect can reference these APIs.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

function installPolyfills() {
  if (typeof window === "undefined") return;

  const w = window as any;

  // ---- ResizeObserver -------------------------------------------------------
  // Used by the watch page (player height sync) and ChannelRail (scroll
  // arrows). Without it, `new ResizeObserver(...)` throws a ReferenceError and
  // takes the whole React tree down. The stub never fires callbacks — the UI
  // simply keeps its initial layout, which is fine on a fixed-size TV screen.
  if (typeof w.ResizeObserver === "undefined") {
    w.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  // ---- IntersectionObserver -------------------------------------------------
  // Not currently used directly, but Next's link prefetching and some helpers
  // probe for it. A inert stub avoids surprise crashes.
  if (typeof w.IntersectionObserver === "undefined") {
    w.IntersectionObserver = class IntersectionObserver {
      root = null;
      rootMargin = "";
      thresholds = [];
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    };
  }

  // ---- matchMedia -----------------------------------------------------------
  // Used for orientation detection. Ancient engines may lack it.
  if (typeof w.matchMedia !== "function") {
    w.matchMedia = function matchMedia() {
      return {
        matches: false,
        media: "",
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {
          return false;
        },
      };
    };
  }

  // ---- Element.prototype.closest -------------------------------------------
  // Chrome <41. Used when walking up the DOM (e.g. click-outside checks).
  if (typeof Element !== "undefined" && !Element.prototype.closest) {
    Element.prototype.closest = function closest(selector: string): Element | null {
      let el: Element | null = this;
      while (el && el.nodeType === 1) {
        if (el.matches && el.matches(selector)) return el;
        el = el.parentElement;
      }
      return null;
    };
  }

  // ---- Element.prototype.matches (needed by the closest shim) ---------------
  if (typeof Element !== "undefined" && !Element.prototype.matches) {
    Element.prototype.matches =
      (Element.prototype as any).webkitMatchesSelector ||
      (Element.prototype as any).msMatchesSelector ||
      function matches() {
        return false;
      };
  }

  // ---- String.prototype.replaceAll -----------------------------------------
  if (!String.prototype.replaceAll) {
    String.prototype.replaceAll = function replaceAll(
      this: string,
      search: any,
      replacement: any
    ): string {
      if (search instanceof RegExp) {
        return this.replace(search, replacement);
      }
      return this.split(String(search)).join(String(replacement));
    };
  }

  // ---- Array.prototype.at / String.prototype.at ----------------------------
  if (!Array.prototype.at) {
    (Array.prototype as any).at = function at(this: any[], n: number) {
      n = Math.trunc(n) || 0;
      if (n < 0) n += this.length;
      if (n < 0 || n >= this.length) return undefined;
      return this[n];
    };
  }
  if (!String.prototype.at) {
    (String.prototype as any).at = function at(this: string, n: number) {
      n = Math.trunc(n) || 0;
      if (n < 0) n += this.length;
      if (n < 0 || n >= this.length) return undefined;
      return this[n];
    };
  }

  // ---- Array.prototype.includes / String.prototype.includes ----------------
  // (core-js usually covers these, but guard anyway — they are cheap.)
  if (!Array.prototype.includes) {
    (Array.prototype as any).includes = function includes(this: any[], item: any) {
      return this.indexOf(item) !== -1;
    };
  }
  if (!String.prototype.includes) {
    (String.prototype as any).includes = function includes(this: string, sub: string) {
      return this.indexOf(sub) !== -1;
    };
  }

  // ---- Object.assign / entries / values ------------------------------------
  if (typeof Object.assign !== "function") {
    Object.assign = function assign(target: any, ...sources: any[]) {
      if (target == null) throw new TypeError("Cannot convert undefined or null to object");
      const out = Object(target);
      for (const src of sources) {
        if (src == null) continue;
        for (const key of Object.keys(src)) out[key] = src[key];
      }
      return out;
    };
  }
  if (!Object.entries) {
    Object.entries = function entries(obj: any): [string, any][] {
      return Object.keys(obj).map((k) => [k, obj[k]] as [string, any]);
    };
  }
  if (!Object.values) {
    Object.values = function values(obj: any) {
      return Object.keys(obj).map((k) => obj[k]);
    };
  }
}

installPolyfills();

export {};
