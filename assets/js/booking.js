/* ==========================================================================
   HBS — Booking experience
   Package selection · protection sync · booking modal · live validation ·
   submit loading state · confirmation view · "book another" reset · HBS API.

   Owned by: booking.js. Consumes only the public HBS API exposed by data.js
   (state, packages, protection, slots, totals, availability, formatting) and
   the micro-helpers exposed by ui.js (toast, scroll lock, focus trap).
   No frameworks, no network, no storage — everything lives in memory.
   ========================================================================== */
(function () {
  "use strict";

  var HBS = (window.HBS = window.HBS || {});

  /* --------------------------------------------------------------------- *
   * Tiny, defensive DOM helpers — a missing node must never break another
   * module on the page.
   * --------------------------------------------------------------------- */
  function $(selector, root) {
    return (root || document).querySelector(selector);
  }
  function $$(selector, root) {
    return Array.prototype.slice.call(
      (root || document).querySelectorAll(selector)
    );
  }
  function isElement(value) {
    return !!value && value.nodeType === 1;
  }
  function on(target, type, handler, options) {
    if (target && typeof target.addEventListener === "function") {
      target.addEventListener(type, handler, options);
    }
  }
  function ui() {
    return HBS.ui || {};
  }
  function toast(message, options) {
    var fn = ui().toast;
    if (typeof fn === "function") fn(message, options);
  }
  function prefersReducedMotion() {
    var fn = ui().prefersReducedMotion;
    if (typeof fn === "function") return !!fn();
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (err) {
      return false;
    }
  }
  function isElementVisible(element) {
    if (!isElement(element) || !element.isConnected) return false;
    if (!element.getClientRects().length) return false;
    try {
      var style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
    } catch (err) {
      /* fall through */
    }
    return true;
  }
  function safeText(node, text) {
    if (node) node.textContent = text == null ? "" : String(text);
  }

  /* --------------------------------------------------------------------- *
   * Contract constants
   * --------------------------------------------------------------------- */
  var SELECTED_CTA_LABEL = "Selected";
  var DEFAULT_CTA_LABEL = "Select package";
  var CONFIRM_LABEL = "Confirm booking";
  var LOADING_LABEL = "Confirming…";
  var DEFAULT_PACKAGE_ID = "express";
  var DEFAULT_PROTECTION_ID = "standard";
  var LATENCY_MIN = 1200;
  var LATENCY_MAX = 1600;
  var FALLBACK_SLOT_LABELS = {
    morning: "10:00 AM – 12:00 PM",
    afternoon: "2:00 PM – 4:00 PM",
    evening: "6:00 PM – 8:00 PM",
    night: "9:00 PM – 11:00 PM",
    overnight: "Overnight",
  };
  var PAYMENT_LABELS = {
    upi: "UPI",
    card: "Credit / Debit Card",
    location: "Pay at location",
  };
  var FIELD_ORDER = ["name", "phone", "package", "date", "time", "protection"];

  /* Validation copy — keep the exact strings from the brief. */
  var MESSAGES = {
    name: "Please enter your full name (at least 3 characters).",
    phone: "Enter a valid 10-digit Indian mobile number.",
    date: "Please choose an available date.",
    time: "Please select a time.",
    timeUnavailable: "That time is no longer available for this date. Please choose another.",
    package: "Please choose a package.",
    protection: "Please choose a protection preference.",
  };

  /* --------------------------------------------------------------------- *
   * DOM cache (safe on null — every consumer guards)
   * --------------------------------------------------------------------- */
  var dom = {
    modal: $("#booking-modal"),
    panel: $(".modal__panel"),
    bookingView: $("#booking-view"),
    successView: $("#success-view"),
    form: $("#booking-form"),
    nameInput: $("#bk-name"),
    phoneInput: $("#bk-phone"),
    packageSelect: $("#bk-package"),
    dateInput: $("#bk-date"),
    timeSelect: $("#bk-time"),
    protectionGroup: $("#bk-protection"),
    submitBtn: $("#booking-submit"),
    submitLabel: $("#booking-submit .btn__label"),
    successTitle: $(".success__title"),
    successRef: $("#success-ref"),
    successPackage: $("#success-package"),
    successWhen: $("#success-when"),
    successProtection: $("#success-protection"),
    successPayment: $("#success-payment"),
    successTotal: $("#success-total"),
    bookAgainBtn: $("#book-again-btn"),
    chipPackage: $("#chip-package"),
    chipDate: $("#chip-date"),
    chipTime: $("#chip-time"),
    chipProtection: $("#chip-protection"),
    availabilitySection: $("#availability"),
    header: $("#site-header"),
  };

  /* --------------------------------------------------------------------- *
   * Module state
   * --------------------------------------------------------------------- */
  var initialized = false;
  var isOpen = false;
  var isSubmitting = false;
  var submitTimer = 0;
  var lastOpener = null;
  var releaseTrap = null;
  var touched = {}; // field name -> true once blurred / attempted
  var pendingTimeNotice = ""; // human explanation when a slot got cleared
  var issuedReferences = {}; // avoid repeating a reference within a session

  /* --------------------------------------------------------------------- *
   * Data helpers — every call degrades gracefully if data.js is unavailable.
   * --------------------------------------------------------------------- */
  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function safeTodayISO() {
    if (typeof HBS.todayISO === "function") {
      try {
        return HBS.todayISO();
      } catch (err) {
        /* fall through */
      }
    }
    var now = new Date();
    return (
      now.getFullYear() +
      "-" +
      pad2(now.getMonth() + 1) +
      "-" +
      pad2(now.getDate())
    );
  }

  function money(amount) {
    if (typeof HBS.money === "function") {
      try {
        return HBS.money(amount);
      } catch (err) {
        /* fall through */
      }
    }
    return "₹" + Number(amount || 0).toLocaleString("en-IN");
  }

  function packageById(id) {
    if (!id || typeof HBS.packageById !== "function") return null;
    try {
      return HBS.packageById(id);
    } catch (err) {
      return null;
    }
  }

  function slotById(id) {
    if (!id) return null;
    if (typeof HBS.slotById === "function") {
      try {
        var found = HBS.slotById(id);
        if (found) return found;
      } catch (err) {
        /* fall through */
      }
    }
    if (Array.isArray(HBS.slots)) {
      for (var i = 0; i < HBS.slots.length; i++) {
        if (HBS.slots[i] && HBS.slots[i].id === id) return HBS.slots[i];
      }
    }
    return FALLBACK_SLOT_LABELS[id]
      ? { id: id, label: FALLBACK_SLOT_LABELS[id] }
      : null;
  }

  function protectionById(id) {
    var table = HBS.PROTECTION || HBS.protection;
    if (table && table[id]) return table[id];
    if (table && table[DEFAULT_PROTECTION_ID]) return table[DEFAULT_PROTECTION_ID];
    return {
      id: DEFAULT_PROTECTION_ID,
      label: "Standard Protection",
      delta: 0,
    };
  }

  function availabilityFor(iso) {
    if (!iso) return null;
    try {
      if (HBS.availability && typeof HBS.availability.forDate === "function") {
        return HBS.availability.forDate(iso);
      }
      if (typeof HBS.getDay === "function") return HBS.getDay(iso);
    } catch (err) {
      /* fall through */
    }
    return null;
  }

  /** Package price + protection delta for one card (authoritative via totals). */
  function totalFor(packageId, protectionId) {
    if (typeof HBS.totals === "function") {
      try {
        var computed = HBS.totals({
          packageId: packageId,
          protection: protectionId,
        });
        if (computed && typeof computed.total === "number") return computed.total;
      } catch (err) {
        /* fall through */
      }
    }
    var pkg = packageById(packageId);
    var prot = protectionById(protectionId);
    return (pkg ? pkg.price : 0) + (prot ? prot.delta : 0);
  }

  function currentState() {
    if (typeof HBS.getState === "function") {
      try {
        return HBS.getState() || {};
      } catch (err) {
        /* fall through */
      }
    }
    return {};
  }

  function setState(patch) {
    if (typeof HBS.setState === "function") {
      try {
        HBS.setState(patch);
      } catch (err) {
        /* never let a listener error bubble into our UI */
      }
    }
  }

  function formatDateLong(iso) {
    if (typeof HBS.formatDateLong === "function") {
      try {
        return HBS.formatDateLong(iso);
      } catch (err) {
        /* fall through */
      }
    }
    return iso || "";
  }

  function formatDateShort(iso) {
    if (typeof HBS.formatDateShort === "function") {
      try {
        return HBS.formatDateShort(iso);
      } catch (err) {
        /* fall through */
      }
    }
    return iso || "";
  }

  function generateReference() {
    var value = "";
    for (var attempt = 0; attempt < 40; attempt++) {
      if (window.crypto && typeof window.crypto.getRandomValues === "function") {
        var buffer = new Uint32Array(1);
        window.crypto.getRandomValues(buffer);
        value = String(buffer[0] % 1000000).padStart(6, "0");
      } else {
        value = String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
      }
      var reference = "HBS-" + value;
      if (!issuedReferences[reference]) {
        issuedReferences[reference] = true;
        return reference;
      }
    }
    return "HBS-" + String(Date.now() % 1000000).padStart(6, "0");
  }

  /* --------------------------------------------------------------------- *
   * Package cards — selection + protection + totals
   * --------------------------------------------------------------------- */

  function packageCards() {
    return $$("[data-package-card]");
  }

  /** Update the CTA's text while preserving the arrow icon. */
  function setCtaLabel(button, text) {
    if (!button) return;
    if (button.getAttribute("data-cta-label") === text) return;
    var children = Array.prototype.slice.call(button.childNodes);
    var replaced = false;
    for (var i = 0; i < children.length; i++) {
      var node = children[i];
      if (node.nodeType === 3 && node.nodeValue && node.nodeValue.trim()) {
        node.nodeValue = text + " ";
        replaced = true;
        break;
      }
    }
    if (!replaced) button.setAttribute("aria-label", text);
    button.setAttribute("data-cta-label", text);
  }

  function syncPackageCards(selectedId) {
    packageCards().forEach(function (card) {
      var id = card.getAttribute("data-package-card");
      var selected = !!selectedId && id === selectedId;
      card.classList.toggle("is-selected", selected);
      var cta = card.querySelector("[data-select-package]");
      if (cta) {
        cta.setAttribute("aria-pressed", selected ? "true" : "false");
        setCtaLabel(cta, selected ? SELECTED_CTA_LABEL : DEFAULT_CTA_LABEL);
      }
    });
  }

  function updateCardTotals(protectionId) {
    var protection = protectionId || DEFAULT_PROTECTION_ID;
    packageCards().forEach(function (card) {
      var id = card.getAttribute("data-package-card");
      var totalNode = card.querySelector("[data-package-total]");
      if (!totalNode) return;
      totalNode.textContent = money(totalFor(id, protection));
    });
  }

  function syncProtectionRadios(protectionId) {
    var protection = protectionId || DEFAULT_PROTECTION_ID;
    $$(".protection input[type='radio']").forEach(function (input) {
      if (input.name === "payment") return;
      if (input.value === protection) {
        if (!input.checked) input.checked = true;
      }
    });
  }

  /** State -> all the visible selection chrome (cards, radios, totals). */
  function syncFromState() {
    var state = currentState();
    var protection = state.protection || DEFAULT_PROTECTION_ID;
    syncPackageCards(state.packageId || null);
    syncProtectionRadios(protection);
    updateCardTotals(protection);
    if (isOpen) updateChips();
  }

  function scrollToAvailability(alreadySelected) {
    var section = dom.availabilitySection || $("#availability");
    if (!section || typeof window.scrollTo !== "function") return;
    var headerHeight = dom.header ? dom.header.offsetHeight : 0;
    if (alreadySelected) {
      var rect = section.getBoundingClientRect();
      var viewport = window.innerHeight || document.documentElement.clientHeight;
      var visible = rect.top < viewport * 0.8 && rect.bottom > headerHeight;
      if (visible) return; // do not yank the page when it is already in view
    }
    var top = rectTop(section) - (headerHeight + 12);
    try {
      window.scrollTo({
        top: Math.max(0, top),
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    } catch (err) {
      window.scrollTo(0, Math.max(0, top));
    }
  }

  function rectTop(element) {
    return element.getBoundingClientRect().top + (window.scrollY || window.pageYOffset || 0);
  }

  function selectPackage(packageId) {
    var pkg = packageById(packageId);
    if (!pkg) return;
    var already = currentState().packageId === packageId;
    setState({ packageId: packageId });
    // setState() emits "change" -> syncFromState, but keep this idempotent call
    // for the (impossible in practice but defensive) case data.js is absent.
    syncPackageCards(packageId);
    updateCardTotals(currentState().protection || DEFAULT_PROTECTION_ID);
    toast(pkg.name + " selected");
    scrollToAvailability(already);
  }

  /* --------------------------------------------------------------------- *
   * Modal open / close
   * --------------------------------------------------------------------- */

  function isSuccessVisible() {
    return !!dom.successView && dom.successView.hidden === false;
  }

  function showFormView() {
    if (dom.bookingView) dom.bookingView.hidden = false;
    if (dom.successView) dom.successView.hidden = true;
    if (dom.panel) {
      dom.panel.setAttribute("aria-labelledby", "booking-title");
      dom.panel.setAttribute("aria-describedby", "booking-desc");
    }
  }

  function showSuccessView() {
    if (dom.bookingView) dom.bookingView.hidden = true;
    if (dom.successView) dom.successView.hidden = false;
    var title = dom.successTitle || $(".success__title");
    if (dom.panel) {
      if (title) {
        if (!title.id) title.id = "success-title";
        dom.panel.setAttribute("aria-labelledby", title.id);
      } else {
        dom.panel.setAttribute("aria-labelledby", "booking-title");
      }
      dom.panel.removeAttribute("aria-describedby");
    }
    return title;
  }

  function focusFirstField() {
    var target = dom.nameInput || dom.packageSelect || dom.panel;
    if (!target || typeof target.focus !== "function") return;
    var run = function () {
      var active = document.activeElement;
      if (active === target) return; // already there
      // If the user already moved focus inside the dialog, never steal it back.
      if (dom.panel && dom.panel.contains(active)) return;
      try {
        target.focus({ preventScroll: true });
      } catch (err) {
        try {
          target.focus();
        } catch (err2) {
          /* ignore */
        }
      }
    };
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(run);
    } else {
      window.setTimeout(run, 0);
    }
    // Fallback for throttled/offscreen animation frames (background tab,
    // mobile emulation): make sure the dialog really owns focus.
    window.setTimeout(run, 80);
  }

  function getModalProtection() {
    var checked =
      dom.protectionGroup &&
      dom.protectionGroup.querySelector("input[type='radio']:checked");
    if (checked) return checked.value;
    var state = currentState();
    return state.protection || DEFAULT_PROTECTION_ID;
  }

  function prefillForm() {
    var state = currentState();

    if (dom.packageSelect) {
      var packageId =
        state.packageId && packageById(state.packageId)
          ? state.packageId
          : DEFAULT_PACKAGE_ID;
      try {
        dom.packageSelect.value = packageId;
      } catch (err) {
        /* ignore */
      }
    }

    if (dom.dateInput) {
      dom.dateInput.min = safeTodayISO();
      dom.dateInput.value = state.date || "";
    }

    if (dom.timeSelect) {
      dom.timeSelect.value = state.slotId || "";
    }
    syncTimeOptions(dom.dateInput ? dom.dateInput.value : "");

    syncProtectionRadios(state.protection || DEFAULT_PROTECTION_ID);

    var payment = dom.form && dom.form.querySelector("input[name='payment']:checked");
    if (!payment && dom.form) {
      var upi = dom.form.querySelector("input[name='payment'][value='upi']");
      if (upi) upi.checked = true;
    }
  }

  function clearAllFieldErrors() {
    FIELD_ORDER.forEach(function (name) {
      var wrapper = fieldWrapper(name);
      if (wrapper) wrapper.classList.remove("field--invalid");
      var control = fieldControl(name);
      if (control && control.removeAttribute) control.removeAttribute("aria-invalid");
      var errorNode = fieldErrorNode(name);
      if (errorNode) errorNode.textContent = "";
    });
  }

  function openModal(opener) {
    if (!dom.modal) return;
    if (isOpen) {
      focusFirstField();
      return;
    }
    isOpen = true;
    lastOpener = isElement(opener)
      ? opener
      : isElement(document.activeElement)
        ? document.activeElement
        : null;

    showFormView();
    resetSubmitButton();
    prefillForm();
    updateChips();
    touched = {};
    pendingTimeNotice = "";
    clearAllFieldErrors();
    updateSubmitState();

    dom.modal.classList.add("is-open");
    dom.modal.setAttribute("aria-hidden", "false");

    var lock = ui().lockScroll;
    if (typeof lock === "function") lock();

    var trap = ui().trapFocus;
    releaseTrap = typeof trap === "function" && dom.panel ? trap(dom.panel) : null;

    focusFirstField();
  }

  function closeModal() {
    if (!dom.modal || !isOpen) return;
    if (isSubmitting) return; // never abandon a confirmation mid-flight
    var wasSuccess = isSuccessVisible();
    isOpen = false;

    dom.modal.classList.remove("is-open");
    if (typeof releaseTrap === "function") releaseTrap();
    releaseTrap = null;

    var unlock = ui().unlockScroll;
    if (typeof unlock === "function") unlock();

    if (wasSuccess) resetForNewBooking({ silent: true });

    dom.modal.setAttribute("aria-hidden", "true");

    var opener = lastOpener;
    lastOpener = null;
    if (opener && isElementVisible(opener)) {
      try {
        opener.focus({ preventScroll: true });
      } catch (err) {
        try {
          opener.focus();
        } catch (err2) {
          /* ignore */
        }
      }
    }

    // Never strand focus on <body> or inside aria-hidden content. After a
    // successful booking the original opener (e.g. #continue-btn) is disabled,
    // so fall back to the nearest meaningful, visible control.
    var stranded =
      dom.modal.contains(document.activeElement) ||
      !document.activeElement ||
      document.activeElement === document.body;
    if (stranded && !focusFallback()) {
      if (dom.modal.contains(document.activeElement)) {
        try {
          document.activeElement.blur();
        } catch (err3) {
          /* ignore */
        }
      }
    }
  }

  var FOCUS_FALLBACKS = [
    "#continue-btn:not([disabled])",
    '#cal-grid .cal-day--available:not([aria-disabled="true"])',
    "#availability .section__title",
    ".brand",
  ];

  function focusFallback() {
    for (var i = 0; i < FOCUS_FALLBACKS.length; i++) {
      var el = document.querySelector(FOCUS_FALLBACKS[i]);
      if (!el || !isElementVisible(el)) continue;
      if (
        !el.hasAttribute("tabindex") &&
        !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)
      ) {
        el.setAttribute("tabindex", "-1");
      }
      focusSafely(el);
      return true;
    }
    return false;
  }

  /* --------------------------------------------------------------------- *
   * Chips (modal summary)
   * --------------------------------------------------------------------- */
  function setChipText(chip, text, isEmpty) {
    if (!chip) return;
    var span = chip.querySelector("span");
    if (span) span.textContent = text;
    if (chip.classList) chip.classList.toggle("is-empty", !!isEmpty);
  }

  function updateChips() {
    var pkg = packageById(dom.packageSelect ? dom.packageSelect.value : "");
    var dateIso = dom.dateInput ? dom.dateInput.value : "";
    var slot = slotById(dom.timeSelect ? dom.timeSelect.value : "");
    var prot = protectionById(getModalProtection());

    setChipText(dom.chipPackage, pkg ? pkg.name : "Package", !pkg);
    setChipText(
      dom.chipDate,
      dateIso ? formatDateShort(dateIso) : "Select date",
      !dateIso
    );
    setChipText(dom.chipTime, slot ? slot.label : "Select time", !slot);
    setChipText(dom.chipProtection, prot ? prot.label : "Protection", !prot);
  }

  /* --------------------------------------------------------------------- *
   * Availability-aware time options
   * --------------------------------------------------------------------- */
  function syncTimeOptions(dateIso) {
    var select = dom.timeSelect;
    if (!select) return;
    var availability = availabilityFor(dateIso);
    var slots = (availability && availability.slots) || [];
    Array.prototype.slice.call(select.options).forEach(function (option) {
      if (!option.value) {
        option.disabled = false;
        option.removeAttribute("data-unavailable");
        return;
      }
      var slot = null;
      for (var i = 0; i < slots.length; i++) {
        if (slots[i] && slots[i].id === option.value) {
          slot = slots[i];
          break;
        }
      }
      var unavailable = !!slot && slot.status === "booked";
      option.disabled = unavailable;
      if (unavailable) {
        option.setAttribute("data-unavailable", "true");
        option.title = "This time is already booked on the selected date";
      } else {
        option.removeAttribute("data-unavailable");
        option.removeAttribute("title");
      }
    });
  }

  /** Clear a selected time that is no longer bookable for the chosen date. */
  function reconcileTimeWithDate(dateIso) {
    if (!dom.timeSelect) return;
    var selected = dom.timeSelect.value;
    if (!selected || !dateIso) return;
    var availability = availabilityFor(dateIso);
    var slots = (availability && availability.slots) || [];
    var slot = null;
    for (var i = 0; i < slots.length; i++) {
      if (slots[i] && slots[i].id === selected) {
        slot = slots[i];
        break;
      }
    }
    if (slot && slot.status !== "booked") return;
    dom.timeSelect.value = "";
    setState({ slotId: null });
    pendingTimeNotice = MESSAGES.timeUnavailable;
    touched.time = true;
    renderField("time", true);
  }

  /* --------------------------------------------------------------------- *
   * Validation
   * --------------------------------------------------------------------- */
  function fieldWrapper(name) {
    return dom.form ? dom.form.querySelector("[data-field='" + name + "']") : null;
  }

  function fieldControl(name) {
    switch (name) {
      case "name":
        return dom.nameInput;
      case "phone":
        return dom.phoneInput;
      case "package":
        return dom.packageSelect;
      case "date":
        return dom.dateInput;
      case "time":
        return dom.timeSelect;
      case "protection":
        return dom.protectionGroup;
      default:
        return null;
    }
  }

  function fieldErrorNode(name) {
    var wrapper = fieldWrapper(name);
    if (!wrapper) return null;
    var node = wrapper.querySelector(".field__error");
    if (!node) {
      node = document.createElement("p");
      node.className = "field__error";
      node.id = "err-" + name;
      node.setAttribute("role", "alert");
      wrapper.appendChild(node);
    }
    return node;
  }

  function isPastDate(iso) {
    var today = safeTodayISO();
    return !!today && iso < today;
  }

  function validateField(name) {
    switch (name) {
      case "name": {
        var nameValue = dom.nameInput ? dom.nameInput.value : "";
        var normalized = String(nameValue == null ? "" : nameValue).trim();
        return normalized.length >= 3
          ? { valid: true, message: "" }
          : { valid: false, message: MESSAGES.name };
      }
      case "phone": {
        var phoneValue = dom.phoneInput ? String(dom.phoneInput.value || "") : "";
        return /^[6-9]\d{9}$/.test(phoneValue)
          ? { valid: true, message: "" }
          : { valid: false, message: MESSAGES.phone };
      }
      case "package": {
        var pkg = packageById(dom.packageSelect ? dom.packageSelect.value : "");
        return pkg
          ? { valid: true, message: "" }
          : { valid: false, message: MESSAGES.package };
      }
      case "date": {
        var iso = dom.dateInput ? dom.dateInput.value : "";
        if (!iso || isPastDate(iso)) {
          return { valid: false, message: MESSAGES.date };
        }
        var availability = availabilityFor(iso);
        if (availability && availability.status === "booked") {
          return { valid: false, message: MESSAGES.date };
        }
        return { valid: true, message: "" };
      }
      case "time": {
        var slotId = dom.timeSelect ? dom.timeSelect.value : "";
        if (!slotId) {
          return { valid: false, message: pendingTimeNotice || MESSAGES.time };
        }
        var dateIso = dom.dateInput ? dom.dateInput.value : "";
        var availability = availabilityFor(dateIso);
        var slots = (availability && availability.slots) || [];
        for (var i = 0; i < slots.length; i++) {
          if (slots[i] && slots[i].id === slotId) {
            return slots[i].status === "booked"
              ? { valid: false, message: MESSAGES.timeUnavailable }
              : { valid: true, message: "" };
          }
        }
        return { valid: true, message: "" };
      }
      case "protection": {
        var checked =
          dom.protectionGroup &&
          dom.protectionGroup.querySelector("input[type='radio']:checked");
        return checked
          ? { valid: true, message: "" }
          : { valid: false, message: MESSAGES.protection };
      }
      default:
        return { valid: true, message: "" };
    }
  }

  function renderField(name, show) {
    var result = validateField(name);
    var invalid = !result.valid;
    var wrapper = fieldWrapper(name);
    var control = fieldControl(name);
    var errorNode = fieldErrorNode(name);

    if (wrapper) wrapper.classList.toggle("field--invalid", invalid && !!show);
    if (control) {
      if (invalid && show) control.setAttribute("aria-invalid", "true");
      else control.removeAttribute("aria-invalid");
    }
    if (errorNode) errorNode.textContent = invalid && show ? result.message : "";
    return result;
  }

  function formIsValid() {
    for (var i = 0; i < FIELD_ORDER.length; i++) {
      if (!validateField(FIELD_ORDER[i]).valid) return false;
    }
    return true;
  }

  function updateSubmitState() {
    if (!dom.submitBtn) return;
    var valid = formIsValid();
    var disabled = !valid || isSubmitting;
    dom.submitBtn.disabled = disabled;
    if (disabled) dom.submitBtn.setAttribute("aria-disabled", "true");
    else dom.submitBtn.removeAttribute("aria-disabled");
  }

  function focusControl(name) {
    var control = fieldControl(name);
    if (!control) return;
    if (name === "protection" && control.querySelector) {
      var first = control.querySelector("input[type='radio']");
      if (first) control = first;
    }
    if (typeof control.focus !== "function") return;
    try {
      control.focus({ preventScroll: false });
    } catch (err) {
      try {
        control.focus();
      } catch (err2) {
        /* ignore */
      }
    }
    if (typeof control.scrollIntoView === "function") {
      try {
        control.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      } catch (err3) {
        /* ignore */
      }
    }
  }

  function firstInvalidField() {
    for (var i = 0; i < FIELD_ORDER.length; i++) {
      if (!validateField(FIELD_ORDER[i]).valid) return FIELD_ORDER[i];
    }
    return null;
  }

  /* --------------------------------------------------------------------- *
   * Form event handlers
   * --------------------------------------------------------------------- */
  function nameForControl(target) {
    if (!isElement(target)) return null;
    var wrapper = target.closest("[data-field]");
    if (!wrapper || !dom.form || !dom.form.contains(wrapper)) return null;
    return wrapper.getAttribute("data-field");
  }

  function onFormInput(event) {
    var target = event.target;
    if (!isElement(target)) return;
    if (target === dom.phoneInput) {
      // Accept a pasted/typed "+91 98765 43210" without silently turning it
      // into a different number; anything else that is too long fails the
      // phone rule visibly instead of being truncated behind the user's back.
      var raw = String(target.value || "").replace(/\D+/g, "");
      if (raw.length === 12 && raw.indexOf("91") === 0) raw = raw.slice(2);
      if (raw.length > 12) raw = raw.slice(0, 12);
      if (target.value !== raw) target.value = raw;
    }
    var name = nameForControl(target);
    if (!name || name === "requests") {
      updateSubmitState();
      return;
    }
    var wrapper = fieldWrapper(name);
    if (touched[name] || (wrapper && wrapper.classList.contains("field--invalid"))) {
      renderField(name, true);
    }
    updateSubmitState();
  }

  function onFormBlur(event) {
    if (!isOpen) return;
    var name = nameForControl(event.target);
    if (!name || name === "requests") return;
    touched[name] = true;
    renderField(name, true);
    updateSubmitState();
  }

  function commitPackage(value) {
    if (!packageById(value)) return;
    setState({ packageId: value });
    touched.package = true;
    renderField("package", true);
    updateChips();
    updateSubmitState();
  }

  function commitDate(value) {
    var iso = value || "";
    pendingTimeNotice = "";
    setState({ date: iso || null });
    syncTimeOptions(iso);
    if (iso) reconcileTimeWithDate(iso);
    touched.date = true;
    renderField("date", true);
    if (touched.time) renderField("time", true);
    updateChips();
    updateSubmitState();
  }

  function commitTime(value) {
    pendingTimeNotice = "";
    setState({ slotId: value || null });
    touched.time = true;
    renderField("time", true);
    updateChips();
    updateSubmitState();
  }

  function commitProtection(value) {
    var table = HBS.PROTECTION || HBS.protection;
    if (table && !table[value]) return;
    setState({ protection: value });
    touched.protection = true;
    renderField("protection", true);
    updateChips();
    updateSubmitState();
  }

  /* --------------------------------------------------------------------- *
   * Submit -> loading -> success
   * --------------------------------------------------------------------- */
  function setSubmitLabel(text) {
    if (dom.submitLabel) dom.submitLabel.textContent = text;
  }

  function resetSubmitButton() {
    if (!dom.submitBtn) return;
    dom.submitBtn.classList.remove("is-loading");
    dom.submitBtn.removeAttribute("aria-busy");
    dom.submitBtn.disabled = true;
    setSubmitLabel(CONFIRM_LABEL);
  }

  function buildSnapshot() {
    var pkg = packageById(dom.packageSelect ? dom.packageSelect.value : "");
    var iso = dom.dateInput ? dom.dateInput.value : "";
    var slot = slotById(dom.timeSelect ? dom.timeSelect.value : "");
    if (!pkg || !iso || !slot) return null;

    var protectionId = getModalProtection();
    var prot = protectionById(protectionId);
    var paymentEl =
      dom.form && dom.form.querySelector("input[name='payment']:checked");
    var paymentId = paymentEl ? paymentEl.value : "upi";

    return {
      reference: generateReference(),
      packageId: pkg.id,
      packageName: pkg.name,
      dateISO: iso,
      dateLong: formatDateLong(iso),
      slotId: slot.id,
      slotLabel: slot.label,
      protectionId: protectionId,
      protectionLabel: prot ? prot.label : "Protection",
      paymentId: paymentId,
      paymentLabel: PAYMENT_LABELS[paymentId] || PAYMENT_LABELS.upi,
      total: totalFor(pkg.id, protectionId),
    };
  }

  function renderSuccess(snapshot) {
    safeText(dom.successRef, snapshot.reference);
    safeText(dom.successPackage, snapshot.packageName);
    safeText(dom.successWhen, snapshot.dateLong + " · " + snapshot.slotLabel);
    safeText(dom.successProtection, snapshot.protectionLabel);
    safeText(dom.successPayment, snapshot.paymentLabel);
    safeText(dom.successTotal, money(snapshot.total));

    var title = showSuccessView();
    if (dom.panel) dom.panel.scrollTop = 0;

    if (title) {
      if (!title.hasAttribute("tabindex")) title.setAttribute("tabindex", "-1");
      try {
        title.focus({ preventScroll: true });
      } catch (err) {
        try {
          title.focus();
        } catch (err2) {
          /* ignore */
        }
      }
    }
  }

  function finishSubmit(snapshot) {
    submitTimer = 0;
    isSubmitting = false;
    if (dom.submitBtn) {
      dom.submitBtn.classList.remove("is-loading");
      dom.submitBtn.removeAttribute("aria-busy");
    }
    setSubmitLabel(CONFIRM_LABEL);
    updateSubmitState();
    renderSuccess(snapshot);
    toast("Booking confirmed");
  }

  function startSubmit(snapshot) {
    isSubmitting = true;
    updateSubmitState();
    if (dom.submitBtn) {
      dom.submitBtn.classList.add("is-loading");
      dom.submitBtn.setAttribute("aria-busy", "true");
    }
    setSubmitLabel(LOADING_LABEL);
    var span = LATENCY_MAX - LATENCY_MIN;
    var latency = LATENCY_MIN + Math.floor(Math.random() * (span + 1));
    submitTimer = window.setTimeout(function () {
      finishSubmit(snapshot);
    }, latency);
  }

  function onSubmit(event) {
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    if (!isOpen || isSubmitting || !dom.form) return;

    FIELD_ORDER.forEach(function (name) {
      touched[name] = true;
    });
    var results = FIELD_ORDER.map(function (name) {
      return renderField(name, true);
    });
    updateSubmitState();

    var invalidIndex = -1;
    for (var i = 0; i < results.length; i++) {
      if (!results[i].valid) {
        invalidIndex = i;
        break;
      }
    }
    if (invalidIndex >= 0) {
      focusControl(FIELD_ORDER[invalidIndex]);
      return;
    }

    // Keep the calendar / selection bar behind the modal in sync with the
    // final confirmed values, then capture an immutable snapshot.
    var pkg = packageById(dom.packageSelect ? dom.packageSelect.value : "");
    var slot = slotById(dom.timeSelect ? dom.timeSelect.value : "");
    var iso = dom.dateInput ? dom.dateInput.value : "";
    var protection = getModalProtection();
    if (pkg && slot && iso) {
      setState({
        packageId: pkg.id,
        date: iso,
        slotId: slot.id,
        protection: protection,
      });
    }

    var snapshot = buildSnapshot();
    if (!snapshot) {
      toast("Something went wrong — please review your booking details.", {
        type: "error",
      });
      return;
    }
    startSubmit(snapshot);
  }

  /* --------------------------------------------------------------------- *
   * Book another — full reset
   * --------------------------------------------------------------------- */
  function resetForNewBooking(options) {
    var opts = options || {};
    if (submitTimer) {
      window.clearTimeout(submitTimer);
      submitTimer = 0;
    }
    isSubmitting = false;
    pendingTimeNotice = "";
    touched = {};

    if (typeof HBS.resetState === "function") {
      try {
        HBS.resetState();
      } catch (err) {
        /* ignore */
      }
    }
    if (dom.form && typeof dom.form.reset === "function") dom.form.reset();

    clearAllFieldErrors();
    resetSubmitButton();
    showFormView();
    prefillForm();
    updateChips();
    updateSubmitState();

    var refresh = HBS.calendar && HBS.calendar.refresh;
    if (typeof refresh === "function") {
      try {
        refresh();
      } catch (err) {
        console.error("[HBS] calendar refresh failed", err);
      }
    }

    if (dom.panel) dom.panel.scrollTop = 0;
    if (isOpen) focusFirstField();
    if (!opts.silent) toast("Ready for another booking");
  }

  /* --------------------------------------------------------------------- *
   * Event wiring (once)
   * --------------------------------------------------------------------- */
  function onDocumentClick(event) {
    var target = event.target;
    if (!isElement(target)) return;

    var bookAgain = target.closest("#book-again-btn");
    if (bookAgain) {
      event.preventDefault();
      resetForNewBooking();
      return;
    }

    var closeTrigger = target.closest("[data-close-booking]");
    if (closeTrigger && dom.modal && dom.modal.contains(closeTrigger)) {
      event.preventDefault();
      closeModal();
      return;
    }

    var openTrigger = target.closest("[data-open-booking]");
    if (openTrigger) {
      event.preventDefault();
      openModal(openTrigger);
      return;
    }

    var selectTrigger = target.closest("[data-select-package]");
    if (selectTrigger) {
      event.preventDefault();
      selectPackage(selectTrigger.getAttribute("data-select-package"));
    }
  }

  function onDocumentChange(event) {
    var target = event.target;
    if (!isElement(target)) return;

    if (target.type === "radio") {
      var group = target.closest(".protection");
      if (group && target.name !== "payment") {
        commitProtection(target.value);
        return;
      }
    }

    if (dom.form && !dom.form.contains(target)) return;
    if (target === dom.packageSelect) commitPackage(target.value);
    else if (target === dom.dateInput) commitDate(target.value);
    else if (target === dom.timeSelect) commitTime(target.value);
  }

  function onDocumentKeydown(event) {
    if (!isOpen) return;
    if (event.key !== "Escape" && event.key !== "Esc") return;
    if (isSubmitting) return;
    event.preventDefault();
    closeModal();
  }

  /* --------------------------------------------------------------------- *
   * Focus trap reinforcement.
   * HBS.ui.trapFocus() handles the common case, but it counts every radio in
   * a group as a tab stop (browsers only tab to the checked one) and the form
   * submit button is disabled until the form is valid — so Tab could slip out
   * of the dialog. This supplement computes the real tab order and closes the
   * remaining gaps. It only acts when the shared trap has not already handled
   * the key press, so nothing is ever intercepted twice.
   * --------------------------------------------------------------------- */
  var TABBABLE_SELECTOR = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled]):not([type='hidden'])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  function tabStops(container) {
    var candidates = $$(TABBABLE_SELECTOR, container).filter(function (element) {
      if (element.hasAttribute("inert")) return false;
      if (element.closest("[hidden]")) return false;
      return element.offsetParent !== null || element.getClientRects().length > 0;
    });
    var groups = {};
    candidates.forEach(function (element) {
      if (element.type !== "radio" || !element.name) return;
      if (!groups[element.name]) groups[element.name] = { stops: [], checked: null };
      groups[element.name].stops.push(element);
      if (element.checked) groups[element.name].checked = element;
    });
    return candidates.filter(function (element) {
      if (element.type !== "radio" || !element.name) return true;
      var group = groups[element.name];
      if (!group) return true;
      return element === (group.checked || group.stops[0]);
    });
  }

  function onTrapKeydown(event) {
    if (!isOpen || event.key !== "Tab") return;
    if (event.defaultPrevented) return; // HBS.ui.trapFocus already handled it
    var panel = dom.panel;
    if (!panel) return;
    var stops = tabStops(panel);
    if (!stops.length) {
      event.preventDefault();
      return;
    }
    var first = stops[0];
    var last = stops[stops.length - 1];
    var active = document.activeElement;
    var inside = panel.contains(active);
    if (event.shiftKey) {
      if (active === first || !inside) {
        event.preventDefault();
        focusSafely(last);
      }
    } else if (active === last || !inside) {
      event.preventDefault();
      focusSafely(first);
    }
  }

  function focusSafely(element) {
    if (!element || typeof element.focus !== "function") return;
    try {
      element.focus({ preventScroll: true });
    } catch (err) {
      try {
        element.focus();
      } catch (err2) {
        /* ignore */
      }
    }
  }

  function onOpenBookingEvent(event) {
    var detail = event && event.detail;
    if (detail && typeof detail === "object") {
      var patch = {};
      if (detail.packageId && packageById(detail.packageId)) {
        patch.packageId = detail.packageId;
      }
      if (typeof detail.date === "string") patch.date = detail.date || null;
      if (detail.slotId && slotById(detail.slotId)) patch.slotId = detail.slotId;
      var table = HBS.PROTECTION || HBS.protection;
      if (detail.protection && table && table[detail.protection]) {
        patch.protection = detail.protection;
      }
      if (Object.keys(patch).length) setState(patch);
    }
    var opener = isElement(event && event.target) ? event.target : null;
    if (!opener && isElement(document.activeElement)) {
      opener = document.activeElement; // e.g. the calendar's Continue button
    }
    openModal(opener);
  }

  function init() {
    if (initialized) return;
    initialized = true;

    on(document, "click", onDocumentClick);
    on(document, "change", onDocumentChange);
    on(document, "keydown", onDocumentKeydown);
    on(document, "keydown", onTrapKeydown);
    on(document, "hbs:open-booking", onOpenBookingEvent);
    on(window, "hbs:open-booking", onOpenBookingEvent);

    on(dom.form, "input", onFormInput);
    on(dom.form, "blur", onFormBlur, true);
    on(dom.form, "submit", onSubmit);

    if (typeof HBS.on === "function") {
      try {
        HBS.on("change", syncFromState);
      } catch (err) {
        console.error("[HBS] booking state subscription failed", err);
      }
    }

    if (dom.dateInput) dom.dateInput.min = safeTodayISO();
    showFormView();
    syncFromState();
    resetSubmitButton();
    updateSubmitState();
  }

  /* --------------------------------------------------------------------- *
   * Public API
   * --------------------------------------------------------------------- */
  HBS.booking = {
    open: function () {
      openModal(isElement(document.activeElement) ? document.activeElement : null);
    },
    close: function () {
      closeModal();
    },
  };

  if (typeof HBS.ready === "function") HBS.ready(init);
  else init();
})();
