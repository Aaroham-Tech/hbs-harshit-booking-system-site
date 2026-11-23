/* ==========================================================================
   HBS — Micro UI helpers shared by all interactive modules
   Owned by: Lead. Consumed by: calendar.js, booking.js, main.js.
   ========================================================================== */
(function () {
  "use strict";
  const HBS = (window.HBS = window.HBS || {});

  const root = document.documentElement;
  const prefersReducedMotion = () =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* --------------------------------- Toast --------------------------------- */
  const toastEl = document.getElementById("toast");
  const toastMsg = document.getElementById("toast-msg");
  let toastTimer = 0;

  /**
   * Show a toast notification.
   * @param {string} message
   * @param {{type?: 'success'|'info'|'error', duration?: number}} [opts]
   */
  function toast(message, opts) {
    if (!toastEl || !toastMsg) return;
    const { type = "success", duration = 3200 } = opts || {};
    toastMsg.textContent = message;
    toastEl.dataset.type = type;
    toastEl.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastEl.classList.remove("is-visible");
    }, duration);
  }

  /* ------------------------------ Scroll lock ------------------------------ */
  let lockCount = 0;
  let previousPadding = "";

  function lockScroll() {
    lockCount += 1;
    if (lockCount > 1) return;
    previousPadding = document.body.style.paddingRight;
    const gap = window.innerWidth - root.clientWidth;
    if (gap > 0) document.body.style.paddingRight = `${gap}px`;
    document.body.classList.add("is-locked");
  }

  function unlockScroll() {
    lockCount = Math.max(0, lockCount - 1);
    if (lockCount > 0) return;
    document.body.classList.remove("is-locked");
    document.body.style.paddingRight = previousPadding;
  }

  /* ------------------------------ Focus trap ------------------------------- */
  const FOCUSABLE = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled]):not([type='hidden'])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  function focusables(container) {
    return Array.from(container.querySelectorAll(FOCUSABLE)).filter(
      (el) =>
        el instanceof HTMLElement &&
        !el.hasAttribute("inert") &&
        el.offsetParent !== null
    );
  }

  /**
   * Trap Tab focus inside a container. Returns a release function.
   * @param {HTMLElement} container
   */
  function trapFocus(container) {
    function onKeyDown(event) {
      if (event.key !== "Tab") return;
      const items = focusables(container);
      if (!items.length) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !container.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }
    container.addEventListener("keydown", onKeyDown);
    return () => container.removeEventListener("keydown", onKeyDown);
  }

  function focusFirst(container) {
    const items = focusables(container);
    const target =
      container.querySelector("[data-autofocus]") || items[0] || container;
    if (target && typeof target.focus === "function") {
      target.focus({ preventScroll: true });
    }
  }

  /* ------------------------------- Utilities ------------------------------- */
  function escapeHTML(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        default:
          return "&#39;";
      }
    });
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function prefersReducedMotionOnce() {
    return prefersReducedMotion();
  }

  HBS.ui = {
    toast,
    showToast: toast,
    lockScroll,
    unlockScroll,
    trapFocus,
    focusFirst,
    focusables,
    escapeHTML,
    clamp,
    prefersReducedMotion,
  };

  /* -------------------------- Small shared behaviors ----------------------- */
  // Smooth-scroll fallback for browsers without CSS scroll-behavior and for
  // anchoring with the fixed header offset.
  HBS.ready(function () {
    const header = document.getElementById("site-header");
    const offset = () => (header ? header.offsetHeight + 12 : 0);

    document.addEventListener("click", (event) => {
      const link = event.target.closest("a[data-scroll]");
      if (!link) return;
      const hash = link.getAttribute("href");
      if (!hash || !hash.startsWith("#")) return;
      const target = document.querySelector(hash);
      if (!target) return;
      event.preventDefault();
      const top =
        hash === "#home"
          ? 0
          : target.getBoundingClientRect().top + window.scrollY - offset();
      window.scrollTo({
        top: Math.max(0, top),
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
      if (history.replaceState) history.replaceState(null, "", hash);
    });
  });
})();
