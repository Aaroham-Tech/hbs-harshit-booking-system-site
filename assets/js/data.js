/* ==========================================================================
   HBS — Data, deterministic availability engine & shared state
   Owned by: Lead. Consumed by: calendar.js, booking.js, main.js.
   No frameworks, no network. Everything below is deliberately deterministic so
   the "booked" calendar looks realistic but stable between page loads.
   ========================================================================== */
(function () {
  "use strict";

  /* ------------------------------- Packages ------------------------------- */
  const PACKAGES = [
    {
      id: "express",
      name: "Express Session",
      duration: "2 Hours",
      unit: "per session",
      price: 2999,
      desc: "Focused and efficient experience.",
    },
    {
      id: "overnight",
      name: "Overnight Experience",
      duration: "1 Night",
      unit: "per night",
      price: 7999,
      desc: "Complete overnight service with full attention.",
    },
    {
      id: "weekend",
      name: "Weekend Package",
      duration: "2 Nights · 3 Days",
      unit: "per weekend",
      price: 14999,
      desc: "Extended premium experience with multiple sessions.",
    },
    {
      id: "premium-week",
      name: "Premium Week",
      duration: "7 Days · 6 Nights",
      unit: "per week",
      price: 39999,
      desc: "Full exclusive booking with complete personal service.",
    },
  ];

  const PROTECTION = {
    standard: { id: "standard", label: "Standard Protection", delta: 0 },
    natural: { id: "natural", label: "Natural Experience", delta: 1500 },
  };

  /* --------------------------------- Slots -------------------------------- */
  const SLOTS = [
    { id: "morning", label: "10:00 AM – 12:00 PM", detail: "Morning" },
    { id: "afternoon", label: "2:00 PM – 4:00 PM", detail: "Afternoon" },
    { id: "evening", label: "6:00 PM – 8:00 PM", detail: "Evening" },
    { id: "night", label: "9:00 PM – 11:00 PM", detail: "Late evening" },
    { id: "overnight", label: "Overnight", detail: "From 10:00 PM", slug: "overnight" },
  ];

  /* ------------------------------ Utilities ------------------------------- */
  const pad = (n) => String(n).padStart(2, "0");
  const DAY = 86400000;

  /** Two-digit ISO date in local time: YYYY-MM-DD */
  function toISO(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  /** Parse an ISO date at local noon (DST-safe, no UTC drift). */
  function parseISO(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d, 12, 0, 0, 0);
  }

  function startOfToday() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  }

  function todayISO() {
    return toISO(startOfToday());
  }

  function addDays(date, n) {
    const d = new Date(date.getTime());
    d.setDate(d.getDate() + n);
    return d;
  }

  /** 32-bit FNV-1a → float in [0,1). Stable, seedable. */
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967296;
  }

  /** Small seeded PRNG (mulberry32) so the booking window is reproducible. */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function isoWeekSeed(date) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() + 4 - (d.getDay() || 7));
    const yearStart = new Date(d.getFullYear(), 0, 1);
    const week = Math.ceil(((d - yearStart) / DAY + 1) / 7);
    return d.getFullYear() * 100 + week;
  }

  const formatINR = (() => {
    const fmt = new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: 0,
    });
    return (n) => fmt.format(n);
  })();

  const dateLongFmt = new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const dateShortFmt = new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  const monthFmt = new Intl.DateTimeFormat("en-IN", {
    month: "long",
    year: "numeric",
  });

  const formatDateLong = (iso) => dateLongFmt.format(parseISO(iso));
  const formatDateShort = (iso) => dateShortFmt.format(parseISO(iso));
  const formatMonth = (d) => monthFmt.format(d);

  function packageById(id) {
    return PACKAGES.find((p) => p.id === id) || null;
  }
  function protectionById(id) {
    return PROTECTION[id] || PROTECTION.standard;
  }
  function slotById(id) {
    return SLOTS.find((s) => s.id === id) || null;
  }

  /* --------------------------- Availability engine ------------------------- */
  const WEEK_SEED = isoWeekSeed(startOfToday());
  const TODAY = todayISO();

  /* Next 30 days get a guaranteed 30–40% booked rate, weekends weighted up. */
  const windowMap = (() => {
    const map = new Map();
    const rand = mulberry32(WEEK_SEED * 2654435761);
    const days = [];
    for (let i = 0; i < 30; i++) {
      const d = addDays(startOfToday(), i);
      const dow = d.getDay();
      days.push({
        iso: toISO(d),
        weekend: dow === 0 || dow === 6,
        r: rand(),
      });
    }
    const targetBooked = Math.round(30 * (0.30 + rand() * 0.07)); // 30–37%
    // Weekends are ~1.7× more likely to have been reserved, not guaranteed.
    const ranked = days
      .map((d) => ({ now: d, score: d.weekend ? d.r * 0.58 : d.r }))
      .sort((a, b) => a.score - b.score);

    const booked = new Set(ranked.slice(0, targetBooked).map((x) => x.now.iso));
    const rest = ranked.slice(targetBooked);
    const targetLimited = Math.min(6, Math.max(3, Math.round(rest.length * 0.2)));
    const limited = new Set(rest.slice(0, targetLimited).map((x) => x.now.iso));

    days.forEach((d) => {
      let status = "available";
      if (booked.has(d.iso)) status = "booked";
      else if (limited.has(d.iso)) status = "limited";
      map.set(d.iso, status);
    });
    return map;
  })();

  /** Status for any ISO date: past | booked | limited | available */
  function dayStatus(iso) {
    if (iso < TODAY) return "past";
    if (windowMap.has(iso)) return windowMap.get(iso);
    const r = hash(`${iso}|${WEEK_SEED}|day`);
    if (r < 0.16) return "booked";
    if (r < 0.3) return "limited";
    return "available";
  }

  const slotCache = new Map();

  /**
   * Determine slots for a date with deterministic statuses and remaining counts.
   * Guarantees: booked day → all booked; available day → at least 3 available;
   * limited day → at least 1 available.
   */
  function slotsFor(iso) {
    if (slotCache.has(iso)) return slotCache.get(iso);
    const status = dayStatus(iso);
    const result = SLOTS.map((slot, index) => {
      const r = hash(`${iso}|${slot.id}|${WEEK_SEED}`);
      let slotStatus = "available";
      let remaining = 3 + Math.floor(r * 4);
      if (status === "booked") {
        slotStatus = "booked";
        remaining = 0;
      } else if (status === "limited") {
        if (r < 0.46) {
          slotStatus = "booked";
          remaining = 0;
        } else if (r < 0.66) {
          slotStatus = "limited";
          remaining = 1 + Math.floor(r * 20) % 2;
        }
      } else {
        if (r < 0.1) {
          slotStatus = "booked";
          remaining = 0;
        } else if (r < 0.3) {
          slotStatus = "limited";
          remaining = 1 + Math.floor(r * 20) % 2;
        }
      }
      return { ...slot, status: slotStatus, remaining, order: index };
    });

    if (status !== "booked") {
      const minimum = status === "limited" ? 1 : 3;
      let available = result.filter((s) => s.status === "available").length;
      // Promote the best "limited" slots to available until the minimum is met.
      for (let i = 0; i < result.length && available < minimum; i++) {
        if (result[i].status === "limited") {
          result[i].status = "available";
          result[i].remaining = Math.max(2, result[i].remaining);
          available++;
        }
      }
      // Last resort: open booked slots as limited.
      for (let i = 0; i < result.length && available < minimum; i++) {
        if (result[i].status === "booked") {
          result[i].status = "limited";
          result[i].remaining = 1;
          available++;
        }
      }
    }

    if (status === "booked") result.forEach((s) => (s.status = "booked"));
    slotCache.set(iso, result);
    return result;
  }

  /** Public per-date payload. */
  function availabilityFor(iso) {
    if (!iso) return null;
    return { iso, status: dayStatus(iso), slots: slotsFor(iso) };
  }

  const RANGE_MONTHS_AHEAD = 3;
  const base = startOfToday();
  const range = {
    minYear: base.getFullYear(),
    minMonth: base.getMonth(),
    maxYear: base.getFullYear(),
    maxMonth: base.getMonth(),
  };
  const maxDate = new Date(base.getFullYear(), base.getMonth() + RANGE_MONTHS_AHEAD, 1, 12);
  range.maxYear = maxDate.getFullYear();
  range.maxMonth = maxDate.getMonth();

  /** 6×7 calendar matrix starting on Sunday. */
  function monthGrid(year, month) {
    const first = new Date(year, month, 1, 12);
    const start = addDays(first, -first.getDay());
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      const iso = toISO(d);
      const inMonth = d.getMonth() === month;
      const isPast = iso < TODAY;
      cells.push({
        iso,
        day: d.getDate(),
        dow: d.getDay(),
        inMonth,
        isToday: iso === TODAY,
        isPast,
        status: !inMonth ? "out" : isPast ? "past" : dayStatus(iso),
      });
    }
    return cells;
  }

  function isMonthInRange(year, month) {
    if (year < range.minYear || year > range.maxYear) return false;
    if (year === range.minYear && month < range.minMonth) return false;
    if (year === range.maxYear && month > range.maxMonth) return false;
    return true;
  }

  /* ------------------------------ Shared state ----------------------------- */
  const state = {
    packageId: null, // no package pre-selected — the user chooses deliberately
    protection: "standard",
    date: null, // ISO string
    slotId: null,
  };

  const listeners = new Map(); // event -> Set<fn>
  const ALLOWED_KEYS = ["packageId", "protection", "date", "slotId"];

  function subscribe(event, fn) {
    if (typeof fn !== "function") return () => {};
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => {
      const set = listeners.get(event);
      if (set) set.delete(fn);
    };
  }

  function emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    set.forEach((fn) => {
      try {
        fn(payload, getState());
      } catch (err) {
        console.error(`[HBS] listener error for "${event}"`, err);
      }
    });
  }

  function getState() {
    return { ...state };
  }

  function setState(patch) {
    const changed = {};
    let didChange = false;
    Object.keys(patch || {}).forEach((key) => {
      if (!ALLOWED_KEYS.includes(key)) return;
      if (state[key] !== patch[key]) {
        state[key] = patch[key];
        changed[key] = patch[key];
        didChange = true;
      }
    });
    if (!didChange) return getState();
    emit("change", changed);
    Object.keys(changed).forEach((key) => emit(key, changed[key]));
    return getState();
  }

  function resetState() {
    setState({ packageId: null, protection: "standard", date: null, slotId: null });
  }

  /* -------------------------------- Totals -------------------------------- */
  function totals(current) {
    const s = current || state;
    const pkg = packageById(s.packageId);
    const prot = protectionById(s.protection);
    const subtotal = pkg ? pkg.price : 0;
    const protectionFee = prot.delta;
    return {
      subtotal,
      protectionFee,
      total: subtotal + protectionFee,
      package: pkg,
      protection: prot,
    };
  }

  /* ------------------------------- Exports -------------------------------- */
  const HBS = {
    version: "1.0.0",
    PACKAGES,
    PROTECTION,
    SLOTS,
    packages: PACKAGES,
    protection: PROTECTION,
    slots: SLOTS,
    range,
    todayISO,
    toISO,
    parseISO,
    addDays,
    formatINR,
    formatDateLong,
    formatDateShort,
    formatMonth,
    formatMonthLabel: formatMonth,
    money: formatINR,
    packageById,
    protectionById,
    slotById,
    availability: {
      forDate: availabilityFor,
      slotsFor,
      dayStatus,
      monthGrid,
      isMonthInRange,
      range,
      todayISO,
    },
    getDay: availabilityFor,
    getMonthGrid: monthGrid,
    getState,
    setState,
    set: setState,
    resetState,
    totals,
    subscribe,
    on: subscribe,
    emit,
    hash,
  };

  window.HBS = HBS;

  /** Run a callback once the DOM is parsed (scripts are deferred, so usually now). */
  HBS.ready = function ready(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else {
      fn();
    }
  };
})();
