/* ==========================================================================
   HBS — Availability calendar, day slots & live selection bar
   Owned by: js-calendar. Consumed by: booking.js (via HBS state only).

   Contract (see data.js / ui.js):
   - READ  : HBS.getState(), HBS.availability.forDate(), HBS.getMonthGrid(),
             HBS.range, HBS.formatMonth/formatDateLong, HBS.money, HBS.totals,
             HBS.packageById/slotById, HBS.parseISO/toISO/addDays/todayISO.
   - WRITE : HBS.setState({ date, slotId }) only. Never booking internals.
   - EVENTS: listens to HBS.on('change' | 'packageId' | 'protection' |
             'date' | 'slotId') and dispatches the documented
             `hbs:open-booking` CustomEvent ({ detail: { source: 'calendar' } }).
   - PUBLIC: window.HBS.calendar = { refresh, goToDate }.

   Rendering is idempotent: every visual update is derived from HBS state, so
   changes made inside the booking modal keep this section in sync. All event
   listeners are delegated and bound exactly once; re-renders only replace
   innerHTML of the grid / slot list.
   ========================================================================== */
(function () {
  "use strict";

  const HBS = window.HBS;
  if (!HBS || typeof HBS.getState !== "function") {
    // data.js failed to load — fail soft instead of throwing for the whole page.
    console.warn("[HBS] calendar.js: data/state API missing — calendar disabled.");
    return;
  }

  /* ------------------------------- Helpers -------------------------------- */
  const ui = HBS.ui || {};
  const toast =
    typeof ui.toast === "function"
      ? ui.toast
      : typeof ui.showToast === "function"
      ? ui.showToast
      : function () {};
  const escapeHTML =
    typeof ui.escapeHTML === "function"
      ? ui.escapeHTML
      : function (value) {
          return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
          });
        };

  const monthLabel = (date) =>
    (typeof HBS.formatMonth === "function" && HBS.formatMonth(date)) ||
    new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" }).format(date);

  const dateLong = (iso) =>
    (typeof HBS.formatDateLong === "function" && HBS.formatDateLong(iso)) || iso;

  const money =
    typeof HBS.money === "function"
      ? HBS.money
      : typeof HBS.formatINR === "function"
      ? HBS.formatINR
      : function (n) {
          return "₹" + Number(n || 0).toLocaleString("en-IN");
        };

  const forDate =
    HBS.availability && typeof HBS.availability.forDate === "function"
      ? HBS.availability.forDate.bind(HBS.availability)
      : function () {
          return null;
        };

  const getMonthGrid =
    typeof HBS.getMonthGrid === "function"
      ? HBS.getMonthGrid.bind(HBS)
      : function () {
          return [];
        };

  const fullDateFmt = (function () {
    try {
      return new Intl.DateTimeFormat("en-IN", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      });
    } catch (err) {
      return null;
    }
  })();

  /** "Saturday, 14 March 2026" — used for screen-reader labels only. */
  function fullDateLabel(iso) {
    const parsed = typeof HBS.parseISO === "function" ? HBS.parseISO(iso) : null;
    if (!parsed || !fullDateFmt) return dateLong(iso);
    try {
      return fullDateFmt.format(parsed);
    } catch (err) {
      return dateLong(iso);
    }
  }

  /* ----------------------------- Date utilities --------------------------- */
  const idxOf = (year, month) => year * 12 + month;

  const RANGE = HBS.range || (HBS.availability && HBS.availability.range) || {};
  const todayISO =
    typeof HBS.todayISO === "function" ? HBS.todayISO() : HBS.toISO(new Date());

  // Fall back to a sane window if the data layer ever stops exposing `range`.
  const MIN_IDX =
    Number.isFinite(RANGE.minYear) && Number.isFinite(RANGE.minMonth)
      ? idxOf(RANGE.minYear, RANGE.minMonth)
      : idxOf(new Date().getFullYear(), new Date().getMonth());
  const MAX_IDX =
    Number.isFinite(RANGE.maxYear) && Number.isFinite(RANGE.maxMonth)
      ? idxOf(RANGE.maxYear, RANGE.maxMonth)
      : MIN_IDX;

  function monthInRange(year, month) {
    const index = idxOf(year, month);
    return index >= MIN_IDX && index <= MAX_IDX;
  }

  function clampMonthIndex(index) {
    return Math.min(MAX_IDX, Math.max(MIN_IDX, index));
  }

  function monthFromIndex(index) {
    return { year: Math.floor(index / 12), month: index % 12 };
  }

  function shiftISO(iso, days) {
    const date = HBS.parseISO(iso);
    if (!date) return null;
    return HBS.toISO(HBS.addDays(date, days));
  }

  /** ISO shifted by whole months, day-of-month clamped to month length. */
  function shiftISOByMonth(iso, delta) {
    const date = HBS.parseISO(iso);
    if (!date) return null;
    const total = idxOf(date.getFullYear(), date.getMonth()) + delta;
    if (total < MIN_IDX || total > MAX_IDX) return null;
    const next = monthFromIndex(total);
    const daysInMonth = new Date(next.year, next.month + 1, 0).getDate();
    return HBS.toISO(
      new Date(next.year, next.month, Math.min(date.getDate(), daysInMonth), 12)
    );
  }

  /* --------------------------------- DOM ---------------------------------- */
  const els = {
    grid: document.getElementById("cal-grid"),
    month: document.getElementById("cal-month"),
    prev: document.getElementById("cal-prev"),
    next: document.getElementById("cal-next"),
    slotsList: document.getElementById("slots-list"),
    slotsDate: document.getElementById("slots-date"),
    slotsBadge: document.getElementById("slots-badge"),
    slotsHint: document.getElementById("slots-hint"),
    selPackage: document.getElementById("sel-package"),
    selDate: document.getElementById("sel-date"),
    selTime: document.getElementById("sel-time"),
    selTotal: document.getElementById("sel-total"),
    selectionNote: document.getElementById("selection-note"),
    continueBtn: document.getElementById("continue-btn"),
  };

  // Remember the authored hint copy so the "no date selected" state can restore it.
  const defaultSlotsHint = (els.slotsHint && els.slotsHint.textContent) || "";

  /* ------------------------------ View state ------------------------------ */
  // Month currently on screen (0-based month, like Date).
  let view = (function initialView() {
    const state = HBS.getState();
    if (state.date) {
      const date = HBS.parseISO(state.date);
      if (date && monthInRange(date.getFullYear(), date.getMonth())) {
        return { year: date.getFullYear(), month: date.getMonth() };
      }
    }
    const today = HBS.parseISO(todayISO) || new Date();
    return monthFromIndex(clampMonthIndex(idxOf(today.getFullYear(), today.getMonth())));
  })();

  // Roving-tabindex focus owner for the grid (exactly one day is tabbable).
  let rovingISO = null;
  // Coalesces bursts of state events into a single render pass.
  let syncQueued = false;
  let lastState = HBS.getState();

  /* --------------------------- Status vocabulary -------------------------- */
  const DAY_STATUS_LABEL = {
    available: "Available",
    limited: "Limited availability",
    booked: "Booked",
    past: "Past date",
    out: "Adjacent month",
  };
  const DAY_STATUSES = ["available", "limited", "booked", "past", "out"];
  const BADGE_STATUSES = ["available", "limited", "booked", "past"];

  function isSelectableStatus(status) {
    return status === "available" || status === "limited";
  }

  /* ----------------------------- Grid rendering --------------------------- */
  function inViewMonth(iso) {
    const date = HBS.parseISO(iso);
    if (!date) return false;
    return date.getFullYear() === view.year && date.getMonth() === view.month;
  }

  /**
   * The single day that should own tabindex="0":
   * keyboard focus (roving) → selected date → today → first available day.
   */
  function resolveTabbable(cells) {
    if (rovingISO && inViewMonth(rovingISO)) return rovingISO;
    const state = HBS.getState();
    if (state.date && inViewMonth(state.date)) return state.date;
    if (todayISO && inViewMonth(todayISO)) {
      const todayCell = cells.find((cell) => cell.iso === todayISO);
      if (todayCell) return todayCell.iso;
    }
    const available =
      cells.find((cell) => cell.inMonth && cell.status === "available") ||
      cells.find((cell) => cell.inMonth && cell.status === "limited") ||
      cells.find((cell) => cell.inMonth);
    return available ? available.iso : null;
  }

  function updateMonthChrome() {
    if (els.month) els.month.textContent = monthLabel(new Date(view.year, view.month, 1));

    const currentIndex = idxOf(view.year, view.month);
    if (els.prev) {
      const atMin = currentIndex <= MIN_IDX;
      els.prev.disabled = atMin;
      els.prev.setAttribute("aria-disabled", String(atMin));
    }
    if (els.next) {
      const atMax = currentIndex >= MAX_IDX;
      els.next.disabled = atMax;
      els.next.setAttribute("aria-disabled", String(atMax));
    }
  }

  function dayButtonMarkup(cell, selectedISO, tabbableISO) {
    const classes = ["cal-day", "cal-day--" + cell.status];
    if (cell.isToday) classes.push("is-today");
    if (selectedISO && cell.iso === selectedISO) classes.push("is-selected");

    const unavailable = !isSelectableStatus(cell.status);
    const statusText =
      (cell.isToday ? "Today, " : "") +
      fullDateLabel(cell.iso) +
      " — " +
      (DAY_STATUS_LABEL[cell.status] || "Available");

    const attrs = [
      'type="button"',
      'class="' + classes.join(" ") + '"',
      'data-date="' + cell.iso + '"',
      'role="gridcell"',
      'aria-selected="' + (selectedISO === cell.iso ? "true" : "false") + '"',
      'tabindex="' + (cell.iso === tabbableISO ? "0" : "-1") + '"',
      'aria-label="' + escapeHTML(statusText) + '"',
    ];
    if (cell.isToday) attrs.push('aria-current="date"');
    if (unavailable) attrs.push('aria-disabled="true"');

    return (
      "<button " +
      attrs.join(" ") +
      ">" +
      '<span class="cal-day__num">' +
      cell.day +
      "</span>" +
      '<span class="cal-day__marker" aria-hidden="true"></span>' +
      "</button>"
    );
  }

  function renderGrid() {
    if (!els.grid) return;

    const cells = getMonthGrid(view.year, view.month) || [];
    updateMonthChrome();

    if (!cells.length) {
      els.grid.innerHTML = "";
      return;
    }

    const activeDay = document.activeElement;
    const focusedISO =
      activeDay && els.grid.contains(activeDay) && activeDay.classList.contains("cal-day")
        ? activeDay.getAttribute("data-date")
        : null;

    const state = HBS.getState();
    const selectedISO = state.date;
    const tabbableISO = resolveTabbable(cells);
    els.grid.innerHTML = cells
      .map((cell) => dayButtonMarkup(cell, selectedISO, tabbableISO))
      .join("");

    // Re-rendering replaces the focused node; restore focus to the same day so
    // keyboard interaction is never interrupted.
    if (focusedISO) {
      const next = els.grid.querySelector('.cal-day[data-date="' + focusedISO + '"]');
      if (next && !els.grid.contains(document.activeElement)) {
        next.focus({ preventScroll: true });
      }
    }
  }

  /** Update only the roving tabindex without rebuilding the grid. */
  function applyTabbable() {
    if (!els.grid) return;
    const cells = getMonthGrid(view.year, view.month) || [];
    const target = resolveTabbable(cells);
    const buttons = els.grid.querySelectorAll(".cal-day");
    for (let i = 0; i < buttons.length; i++) {
      const iso = buttons[i].getAttribute("data-date");
      buttons[i].tabIndex = iso === target ? 0 : -1;
    }
  }

  /* ------------------------------- Month nav ------------------------------ */
  function goMonth(delta) {
    const target = idxOf(view.year, view.month) + delta;
    if (target < MIN_IDX || target > MAX_IDX) return;
    rovingISO = null;
    view = monthFromIndex(target);
    renderGrid();
  }

  /* ------------------------- Grid point selection ------------------------- */
  function selectDate(iso) {
    if (!iso) return;
    const status =
      HBS.availability && typeof HBS.availability.dayStatus === "function"
        ? HBS.availability.dayStatus(iso)
        : (function () {
            const date = HBS.parseISO(iso);
            return date && iso < todayISO ? "past" : "available";
          })();

    if (status === "past") {
      toast("Past dates can't be booked.", { type: "info" });
      return;
    }
    if (status === "booked") {
      toast("That date is already booked — please choose another.", { type: "error" });
      return;
    }

    rovingISO = iso;
    // Clearing slotId is part of the contract: a new date always resets time.
    HBS.setState({ date: iso, slotId: null });
  }

  /* --------------------------- Keyboard: grid ----------------------------- */
  function focusEdge(first) {
    if (!els.grid) return;
    const days = els.grid.querySelectorAll(".cal-day:not(.cal-day--out)");
    if (!days.length) return;
    const target = first ? days[0] : days[days.length - 1];
    const iso = target.getAttribute("data-date");
    if (!iso) return;
    rovingISO = iso;
    applyTabbable();
    target.focus({ preventScroll: true });
  }

  /** Navigate the calendar (if needed) and focus the requested ISO day. */
  function focusISO(iso) {
    const date = HBS.parseISO(iso);
    if (!date) return;
    const year = date.getFullYear();
    const month = date.getMonth();
    if (!monthInRange(year, month)) return;

    rovingISO = iso;
    if (year !== view.year || month !== view.month) {
      view = { year: year, month: month };
      renderGrid();
    } else {
      applyTabbable();
    }
    const button = els.grid && els.grid.querySelector('.cal-day[data-date="' + iso + '"]');
    if (button) button.focus({ preventScroll: true });
  }

  function onGridKeyDown(event) {
    const target = event.target;
    const day =
      target && typeof target.closest === "function" ? target.closest(".cal-day") : null;
    if (!day) return;
    const iso = day.getAttribute("data-date");
    if (!iso) return;
    const current = HBS.parseISO(iso);
    if (!current) return;
    const dow = current.getDay();

    let nextISO = null;
    switch (event.key) {
      case "ArrowLeft":
        nextISO = shiftISO(iso, -1);
        break;
      case "ArrowRight":
        nextISO = shiftISO(iso, 1);
        break;
      case "ArrowUp":
        nextISO = shiftISO(iso, -7);
        break;
      case "ArrowDown":
        nextISO = shiftISO(iso, 7);
        break;
      case "Home":
        nextISO = shiftISO(iso, -dow);
        break;
      case "End":
        nextISO = shiftISO(iso, 6 - dow);
        break;
      case "PageUp":
        nextISO = shiftISOByMonth(iso, -1);
        break;
      case "PageDown":
        nextISO = shiftISOByMonth(iso, 1);
        break;
      default:
        return; // Enter / Space activate native buttons → click handler.
    }

    if (!nextISO) {
      // At the edge of the bookable window Home/End still stay inside the month.
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        focusEdge(event.key === "Home");
      }
      return;
    }

    const nextDate = HBS.parseISO(nextISO);
    if (!nextDate || !monthInRange(nextDate.getFullYear(), nextDate.getMonth())) {
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        focusEdge(event.key === "Home");
      }
      return;
    }

    event.preventDefault();
    focusISO(nextISO);
  }

  /* ------------------------------ Slot rendering -------------------------- */
  function slotNote(slot) {
    if (slot.status === "booked") return "Booked";
    if (typeof slot.remaining === "number" && slot.remaining <= 1) {
      return "Only 1 slot remaining";
    }
    if (slot.status === "limited") return "Limited slots remaining";
    return "Available";
  }

  function slotsEmptyMarkup(iconId, title, text) {
    return (
      '<div class="slots-empty">' +
      '<svg class="icon slots-empty__icon" aria-hidden="true"><use href="#' +
      iconId +
      '"/></svg>' +
      '<p class="slots-empty__title">' +
      escapeHTML(title) +
      "</p>" +
      '<p class="slots-empty__text">' +
      escapeHTML(text) +
      "</p>" +
      "</div>"
    );
  }

  function setBadge(status, text) {
    if (!els.slotsBadge) return;
    BADGE_STATUSES.forEach(function (name) {
      els.slotsBadge.classList.toggle("is-" + name, name === status);
      els.slotsBadge.classList.toggle("slots-panel__badge--" + name, name === status);
    });
    if (status) els.slotsBadge.setAttribute("data-status", status);
    else els.slotsBadge.removeAttribute("data-status");

    if (!text) {
      els.slotsBadge.textContent = "";
      els.slotsBadge.hidden = true;
      return;
    }
    els.slotsBadge.textContent = text;
    els.slotsBadge.hidden = false;
  }

  function setHint(text) {
    if (els.slotsHint) els.slotsHint.textContent = text;
  }

  function openSlotCount(availability) {
    if (!availability || !availability.slots) return 0;
    return availability.slots.filter(function (slot) {
      return slot.status !== "booked";
    }).length;
  }

  function renderSlots() {
    const state = HBS.getState();

    /* ---- No date chosen ------------------------------------------------- */
    if (!state.date) {
      if (els.slotsList) {
        els.slotsList.innerHTML = slotsEmptyMarkup(
          "i-cal",
          "No date selected",
          "Select a date to see available times"
        );
      }
      if (els.slotsDate) els.slotsDate.textContent = "Select a date to continue";
      setBadge(null, null);
      setHint(defaultSlotsHint);
      return;
    }

    const availability = forDate(state.date);
    if (!availability) {
      if (els.slotsList) {
        els.slotsList.innerHTML = slotsEmptyMarkup(
          "i-cal",
          "Availability unavailable",
          "Please pick another date"
        );
      }
      if (els.slotsDate) els.slotsDate.textContent = dateLong(state.date);
      setBadge(null, null);
      return;
    }

    if (els.slotsDate) els.slotsDate.textContent = dateLong(state.date);

    const open = openSlotCount(availability);

    /* ---- Badge ---------------------------------------------------------- */
    if (availability.status === "past") {
      setBadge("past", "Past date");
    } else if (open === 0) {
      setBadge("booked", "Fully booked");
    } else {
      setBadge(availability.status, open + (open === 1 ? " slot left" : " slots left"));
    }

    /* ---- Empty states --------------------------------------------------- */
    if (availability.status === "past") {
      if (els.slotsList) {
        els.slotsList.innerHTML = slotsEmptyMarkup(
          "i-clock",
          "This date has passed",
          "Past dates can't be booked."
        );
      }
      setHint("Past dates can't be booked.");
      return;
    }
    if (open === 0) {
      if (els.slotsList) {
        els.slotsList.innerHTML = slotsEmptyMarkup(
          "i-lock",
          "Fully booked",
          "This date is fully booked — try another"
        );
      }
      setHint("Pick another date — this one is fully reserved.");
      return;
    }

    /* ---- Slot buttons ---------------------------------------------------- */
    const activeSlot = document.activeElement;
    const focusedSlotId =
      els.slotsList &&
      activeSlot &&
      els.slotsList.contains(activeSlot) &&
      activeSlot.classList &&
      activeSlot.classList.contains("slot")
        ? activeSlot.getAttribute("data-slot")
        : null;

    const selectedId = state.slotId;
    const slotList = Array.isArray(availability.slots) ? availability.slots : [];
    if (els.slotsList) {
      els.slotsList.innerHTML = slotList
        .map(function (slot) {
          const booked = slot.status === "booked";
          const selected = !booked && slot.id === selectedId;
          const classes = ["slot", "slot--" + slot.status];
          if (selected) classes.push("is-selected");
          const note = slotNote(slot);
          const label = slot.detail + " slot, " + slot.label + " — " + note;
          const attrs = [
            'type="button"',
            'class="' + classes.join(" ") + '"',
            'data-slot="' + escapeHTML(slot.id) + '"',
            'aria-pressed="' + (selected ? "true" : "false") + '"',
            'aria-label="' + escapeHTML(label) + '"',
          ];
          if (booked) attrs.push('disabled aria-disabled="true"');
          return (
            "<button " +
            attrs.join(" ") +
            ">" +
            '<span class="slot__dot" aria-hidden="true"></span>' +
            '<span class="slot__body">' +
            '<span class="slot__label">' +
            escapeHTML(slot.label) +
            "</span>" +
            '<span class="slot__note">' +
            escapeHTML(note) +
            "</span>" +
            "</span>" +
            '<svg class="icon slot__icon" aria-hidden="true"><use href="#i-check"/></svg>' +
            "</button>"
          );
        })
        .join("");

      // Keep keyboard focus on the same slot button across re-renders.
      if (focusedSlotId) {
        const next = els.slotsList.querySelector(
          '.slot[data-slot="' + focusedSlotId + '"]:not([disabled])'
        );
        if (next && !els.slotsList.contains(document.activeElement)) {
          next.focus({ preventScroll: true });
        }
      }
    }

    /* ---- Contextual hint ------------------------------------------------ */
    if (state.slotId) setHint("Time selected — continue to lock it in.");
    else if (availability.status === "limited") {
      setHint("Fewer windows left on this date — book early.");
    } else {
      setHint("Select a time to reserve it. Limited slots are marked.");
    }
  }

  /* --------------------------- Selection summary -------------------------- */
  function evaluateSelection(state) {
    const pkg =
      state.packageId && typeof HBS.packageById === "function"
        ? HBS.packageById(state.packageId)
        : null;
    const slot =
      state.slotId && typeof HBS.slotById === "function" ? HBS.slotById(state.slotId) : null;

    let dateStatus = null;
    let slotValid = false;
    if (state.date) {
      const availability = forDate(state.date);
      dateStatus = availability ? availability.status : null;
      if (availability && slot && Array.isArray(availability.slots)) {
        slotValid = availability.slots.some(function (item) {
          return item.id === slot.id && item.status !== "booked";
        });
      }
    }

    let note;
    if (!pkg) note = "Choose a package above";
    else if (!state.date) note = "Select a date to continue";
    else if (dateStatus === "past") note = "Past dates can't be booked — select a future date.";
    else if (dateStatus === "booked") note = "This date is fully booked — choose another date.";
    else if (!slot) note = "Select a time to continue";
    else if (!slotValid) note = "That time is no longer available — pick another.";
    else note = "You're ready — continue to booking";

    const ready =
      !!pkg &&
      !!state.date &&
      dateStatus !== "past" &&
      dateStatus !== "booked" &&
      slotValid;

    return { package: pkg, slot: slot, note: note, ready: ready };
  }

  function updateSelection() {
    const state = HBS.getState();
    const totals =
      typeof HBS.totals === "function" ? HBS.totals(state) : { total: 0, protectionFee: 0 };
    const evaluation = evaluateSelection(state);

    if (els.selPackage) {
      els.selPackage.textContent = evaluation.package ? evaluation.package.name : "Not selected";
    }
    if (els.selDate) els.selDate.textContent = state.date ? dateLong(state.date) : "—";
    if (els.selTime) {
      els.selTime.textContent = evaluation.slot ? evaluation.slot.label : "—";
    }
    if (els.selTotal) {
      if (evaluation.package) {
        const natural = totals.protectionFee > 0;
        els.selTotal.textContent = money(totals.total) + (natural ? " · Natural" : "");
        if (natural) {
          els.selTotal.setAttribute(
            "title",
            "Includes " + money(totals.protectionFee) + " Natural Experience"
          );
        } else {
          els.selTotal.removeAttribute("title");
        }
      } else {
        els.selTotal.textContent = "—";
        els.selTotal.removeAttribute("title");
      }
    }
    if (els.selectionNote) els.selectionNote.textContent = evaluation.note;
    if (els.continueBtn) {
      els.continueBtn.disabled = !evaluation.ready;
      if (evaluation.ready) els.continueBtn.removeAttribute("aria-disabled");
      else els.continueBtn.setAttribute("aria-disabled", "true");
    }
  }

  /* --------------------------- State synchronisation ---------------------- */
  /** Keep `view` on the month that owns the selected date (clamped to range). */
  function ensureViewForDate(iso) {
    if (!iso) return;
    const date = HBS.parseISO(iso);
    if (!date) return;
    const target = monthFromIndex(
      clampMonthIndex(idxOf(date.getFullYear(), date.getMonth()))
    );
    if (target.year !== view.year || target.month !== view.month) {
      view = target;
      rovingISO = null;
    }
  }

  /** One idempotent render pass derived entirely from HBS state. */
  function syncFromState() {
    const state = HBS.getState();
    const dateChanged = state.date !== lastState.date;
    lastState = state;
    if (dateChanged) ensureViewForDate(state.date);
    renderGrid();
    renderSlots();
    updateSelection();
  }

  function scheduleSync() {
    if (syncQueued) return;
    syncQueued = true;
    const run = function () {
      syncQueued = false;
      syncFromState();
    };
    if (typeof queueMicrotask === "function") queueMicrotask(run);
    else window.setTimeout(run, 0);
  }

  /* -------------------------------- Actions ------------------------------- */
  function onContinueClick() {
    if (!els.continueBtn || els.continueBtn.disabled) return;
    document.dispatchEvent(
      new CustomEvent("hbs:open-booking", {
        detail: { source: "calendar" },
        bubbles: true,
      })
    );
  }

  function bindEvents() {
    /* Calendar navigation (bound once). */
    if (els.prev) {
      els.prev.addEventListener("click", function () {
        goMonth(-1);
      });
    }
    if (els.next) {
      els.next.addEventListener("click", function () {
        goMonth(1);
      });
    }

    /* Day clicks (delegated → survives innerHTML re-render). */
    if (els.grid) {
      els.grid.addEventListener("click", function (event) {
        const target = event.target;
        const day =
          target && typeof target.closest === "function" ? target.closest(".cal-day") : null;
        if (!day || !els.grid.contains(day)) return;
        if (day.classList.contains("cal-day--out")) return; // adjacent month: muted
        selectDate(day.getAttribute("data-date"));
      });
      els.grid.addEventListener("keydown", onGridKeyDown);
    }

    /* Slot clicks + lightweight roving arrow support (delegated, bound once). */
    if (els.slotsList) {
      els.slotsList.addEventListener("click", function (event) {
        const target = event.target;
        const slotEl =
          target && typeof target.closest === "function" ? target.closest(".slot") : null;
        if (!slotEl || slotEl.disabled) return;
        const slotId = slotEl.getAttribute("data-slot");
        if (!slotId) return;

        const state = HBS.getState();
        if (!state.date) return;
        const availability = forDate(state.date);
        const chosen =
          availability &&
          Array.isArray(availability.slots) &&
          availability.slots.find(function (item) {
            return item.id === slotId;
          });
        if (!chosen || chosen.status === "booked") return;

        // Selecting the active slot again clears it (idempotent toggle).
        HBS.setState({ slotId: state.slotId === slotId ? null : slotId });
      });

      els.slotsList.addEventListener("keydown", function (event) {
        const key = event.key;
        if (
          key !== "ArrowDown" &&
          key !== "ArrowUp" &&
          key !== "ArrowLeft" &&
          key !== "ArrowRight" &&
          key !== "Home" &&
          key !== "End"
        ) {
          return;
        }
        const target = event.target;
        const slotEl =
          target && typeof target.closest === "function" ? target.closest(".slot") : null;
        if (!slotEl) return;
        const items = Array.prototype.slice.call(
          els.slotsList.querySelectorAll(".slot:not([disabled])")
        );
        if (!items.length) return;
        const index = items.indexOf(slotEl);
        if (index < 0) return;

        let next = null;
        if (key === "Home") next = items[0];
        else if (key === "End") next = items[items.length - 1];
        else if (key === "ArrowDown" || key === "ArrowRight") {
          next = items[(index + 1) % items.length];
        } else {
          next = items[(index - 1 + items.length) % items.length];
        }
        if (next) {
          event.preventDefault();
          next.focus();
        }
      });
    }

    /* Continue → hand off to the booking module via the documented event. */
    if (els.continueBtn) els.continueBtn.addEventListener("click", onContinueClick);
  }

  /* ------------------------------ Public API ------------------------------ */
  function refresh() {
    if (!monthInRange(view.year, view.month)) {
      view = monthFromIndex(clampMonthIndex(idxOf(view.year, view.month)));
    }
    lastState = HBS.getState();
    renderGrid();
    renderSlots();
    updateSelection();
  }

  /**
   * Navigate the visible month to `iso` and (by default) move focus to that day.
   * Does not mutate HBS state — selection stays owned by the caller.
   * @param {string} iso YYYY-MM-DD
   * @param {{focus?: boolean}} [options]
   * @returns {boolean} true when the month was navigable.
   */
  function goToDate(iso, options) {
    if (!iso) return false;
    const date = HBS.parseISO(iso);
    if (!date || isNaN(date.getTime())) return false;
    const year = date.getFullYear();
    const month = date.getMonth();
    if (!monthInRange(year, month)) return false;

    view = { year: year, month: month };
    rovingISO = iso;
    renderGrid();
    if (!options || options.focus !== false) {
      const button = els.grid && els.grid.querySelector('.cal-day[data-date="' + iso + '"]');
      if (button) button.focus({ preventScroll: true });
    }
    return true;
  }

  /* -------------------------------- Boot ---------------------------------- */
  function init() {
    bindEvents();
    renderGrid();
    renderSlots();
    updateSelection();

    HBS.calendar = { refresh: refresh, goToDate: goToDate };

    // React to any state mutation, including ones triggered inside the modal.
    // `change` fires for every key; the per-key events are subscribed too so
    // custom emits are honoured as well. scheduleSync() coalesces the burst.
    const events = ["change", "packageId", "package", "protection", "date", "slotId", "slot"];
    events.forEach(function (name) {
      if (typeof HBS.on === "function") HBS.on(name, scheduleSync);
    });
  }

  if (typeof HBS.ready === "function") HBS.ready(init);
  else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
