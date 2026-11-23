/* ==========================================================================
   HBS — Sound design
   • hover any photograph  → the full "Ohh Yes" track, exactly as supplied
   • booking confirmed     → the full meme track, exactly as supplied
   A header toggle (persisted locally) lets guests silence everything; playback
   is always triggered by a real interaction, never on page load.
   ========================================================================== */
(function () {
  "use strict";
  const HBS = (window.HBS = window.HBS || {});
  const STORAGE_KEY = "hbs.sound";

  const CLIPS = {
    // Full, untrimmed client tracks at full volume.
    hover: { src: "assets/audio/ohh-yes.mp3", volume: 1 },
    success: { src: "assets/audio/confirm-meme.mp3", volume: 1 },
  };

  const PHOTO_SELECTOR = ".gallery__item, .portrait, .contact__avatar";
  const HOVER_COOLDOWN = 1500; // ms — prevents machine-gun sound while sweeping

  let enabled = true;
  try {
    enabled = window.localStorage.getItem(STORAGE_KEY) !== "off";
  } catch (err) {
    /* storage unavailable — keep default on */
  }

  const players = {};
  let hoverTimer = 0;
  let lastPlayed = null;
  let lastHoverTarget = null;
  let gestureUnlocked = false;

  function savePreference() {
    try {
      window.localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
    } catch (err) {
      /* ignore */
    }
  }

  function getPlayer(name) {
    const cfg = CLIPS[name];
    if (!cfg) return null;
    if (!players[name]) {
      try {
        const audio = new Audio();
        audio.preload = "auto";
        audio.src = cfg.src;
        audio.volume = cfg.volume;
        players[name] = audio;
      } catch (err) {
        return null;
      }
    }
    return players[name];
  }

  /** Play one of the effects. Safe to call anywhere — never throws. */
  function play(name) {
    if (!enabled) return false;
    if (navigator.connection && navigator.connection.saveData) return false;
    const cfg = CLIPS[name];
    const audio = getPlayer(name);
    if (!cfg || !audio) return false;
    try {
      // Hovering photo after photo must not chop the track — let a playing
      // track finish instead of restarting it on every pointer move.
      if (name === "hover" && !audio.paused && !audio.ended) {
        return true;
      }
      audio.pause();
      audio.currentTime = 0;
      audio.volume = cfg.volume;
      const attempt = audio.play();
      if (attempt && typeof attempt.catch === "function") {
        attempt.catch(function () {
          /* autoplay policy — silently ignore until the next gesture */
        });
      }
      lastPlayed = name;
      return true;
    } catch (err) {
      return false;
    }
  }

  function setEnabled(next) {
    enabled = !!next;
    savePreference();
    if (!enabled) {
      Object.keys(players).forEach(function (key) {
        try {
          players[key].pause();
        } catch (err) {
          /* ignore */
        }
      });
    }
    renderToggle();
    return enabled;
  }

  function isEnabled() {
    return enabled;
  }

  /* ------------------------------- Photo sounds ---------------------------- */
  function isPhoto(node) {
    return node && node.closest ? !!node.closest(PHOTO_SELECTOR) : false;
  }

  function onPointerOver(event) {
    const target = event.target;
    if (!isPhoto(target)) return;
    const host = target.closest(PHOTO_SELECTOR);
    if (host === lastHoverTarget) return;
    // Ignore moving between children of the same figure.
    if (host.contains(event.relatedTarget)) return;
    lastHoverTarget = host;
    const now = Date.now();
    if (now - hoverTimer < HOVER_COOLDOWN) return;
    hoverTimer = now;
    play("hover");
  }

  function onPointerOut(event) {
    if (!lastHoverTarget) return;
    if (lastHoverTarget.contains(event.relatedTarget)) return;
    if (!lastHoverTarget.contains(event.target)) return;
    lastHoverTarget = null;
  }

  /* --------------------------- Booking confirmed --------------------------- */
  function watchSuccess() {
    const success = document.getElementById("success-view");
    if (!success || typeof MutationObserver !== "function") return;
    new MutationObserver(function () {
      if (!success.hidden) play("success");
    }).observe(success, { attributes: true, attributeFilter: ["hidden"] });
  }

  /* ------------------------------ Mute toggle ------------------------------ */
  function renderToggle() {
    const button = document.getElementById("sound-toggle");
    if (!button) return;
    button.setAttribute("aria-pressed", enabled ? "true" : "false");
    button.setAttribute(
      "aria-label",
      enabled ? "Mute sound effects" : "Enable sound effects"
    );
    button.setAttribute("title", enabled ? "Sound on" : "Sound off");
    button.classList.toggle("is-muted", !enabled);
  }

  function initToggle() {
    const button = document.getElementById("sound-toggle");
    if (!button) return;
    button.addEventListener("click", function () {
      const next = setEnabled(!enabled);
      gestureUnlocked = true;
      if (next) play("hover");
      if (HBS.ui && typeof HBS.ui.toast === "function") {
        HBS.ui.toast(
          next ? "Sound on — hover or tap the photos" : "Sound off",
          { type: "info", duration: 2400 }
        );
      }
    });
    renderToggle();
  }

  /* ------------------------------- Bootstrap ------------------------------- */
  function unlockOnGesture() {
    if (gestureUnlocked) return;
    gestureUnlocked = true;
    // Warm up the clips on the first real interaction so hover playback is
    // instant afterwards (and satisfies mobile autoplay policies).
    Object.keys(CLIPS).forEach(function (key) {
      const audio = getPlayer(key);
      if (!audio) return;
      try {
        audio.load();
      } catch (err) {
        /* ignore */
      }
    });
  }

  function init() {
    initToggle();
    watchSuccess();
    document.addEventListener("pointerover", onPointerOver, { passive: true });
    document.addEventListener("pointerout", onPointerOut, { passive: true });
    ["pointerdown", "keydown", "touchstart"].forEach(function (evt) {
      document.addEventListener(evt, unlockOnGesture, {
        once: true,
        passive: true,
      });
    });
  }

  HBS.sound = {
    play: play,
    setEnabled: setEnabled,
    isEnabled: isEnabled,
    get lastPlayed() {
      return lastPlayed;
    },
  };

  if (typeof HBS.ready === "function") HBS.ready(init);
  else init();
})();
