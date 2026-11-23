/* ==========================================================================
   HBS — Page chrome interactions: header state, mobile menu, scroll progress,
   scroll spy, reveal orchestration, floating CTA, footer year.
   Owned by: Lead.
   ========================================================================== */
(function () {
  "use strict";
  const HBS = window.HBS || {};
  const ui = HBS.ui || {};
  const prefersReduced = () =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  HBS.ready(function () {
    const header = document.getElementById("site-header");
    const progressBar = document.getElementById("scroll-progress-bar");
    const toggle = document.getElementById("nav-toggle");
    const menu = document.getElementById("mobile-menu");
    const mobileCta = document.getElementById("mobile-cta");
    const navLinks = Array.from(document.querySelectorAll(".nav__link"));
    const sections = ["home", "expertise", "gallery", "packages", "availability", "contact"]
      .map((id) => document.getElementById(id))
      .filter(Boolean);

    /* ------------------------------ Header ------------------------------- */
    const onScroll = () => {
      const y = window.scrollY || window.pageYOffset;
      if (header) header.classList.toggle("is-scrolled", y > 16);

      if (progressBar) {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        const pct = max > 0 ? Math.min(100, (y / max) * 100) : 0;
        progressBar.style.width = `${pct.toFixed(2)}%`;
      }

      if (mobileCta) {
        const hero = document.getElementById("home");
        const heroCutoff = hero ? hero.offsetHeight * 0.55 : 480;
        const nearFooter =
          y + window.innerHeight > document.documentElement.scrollHeight - 240;
        const modalOpen = document.body.classList.contains("is-locked");
        mobileCta.classList.toggle(
          "is-visible",
          y > heroCutoff && !nearFooter && !modalOpen
        );
      }

      // Scroll spy
      const probe = 140;
      let current = sections[0];
      for (const section of sections) {
        if (section.getBoundingClientRect().top <= probe) current = section;
      }
      if (current) {
        navLinks.forEach((link) => {
          const match = link.getAttribute("href") === `#${current.id}`;
          if (match) link.setAttribute("aria-current", "true");
          else link.removeAttribute("aria-current");
        });
      }
    };

    let ticking = false;
    const requestScroll = () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(() => {
        onScroll();
        ticking = false;
      });
    };
    window.addEventListener("scroll", requestScroll, { passive: true });
    window.addEventListener("resize", requestScroll, { passive: true });
    onScroll();

    /* --------------------------- Mobile menu ----------------------------- */
    let menuOpen = false;

    function setMenu(open) {
      if (!toggle || !menu) return;
      if (open === menuOpen) return;
      menuOpen = open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");

      if (open) {
        menu.hidden = false;
        window.requestAnimationFrame(() => {
          menu.classList.add("is-open");
          const firstLink = menu.querySelector("a[href], button");
          if (firstLink) firstLink.focus({ preventScroll: true });
        });
        ui.lockScroll && ui.lockScroll();
      } else {
        menu.classList.remove("is-open");
        if (menu.contains(document.activeElement) && toggle) toggle.focus({ preventScroll: true });
        ui.unlockScroll && ui.unlockScroll();
        const hide = () => {
          if (!menuOpen) menu.hidden = true;
        };
        if (prefersReduced()) hide();
        else window.setTimeout(hide, 260);
      }
    }

    function menuFocusables() {
      if (!menu) return [];
      return Array.from(menu.querySelectorAll('a[href], button:not([disabled])')).filter(
        (el) => el.offsetParent !== null
      );
    }

    if (toggle) {
      toggle.addEventListener("click", () => setMenu(!menuOpen));
    }

    if (menu) {
      menu.addEventListener("click", (event) => {
        if (event.target.closest("a")) setMenu(false);
      });
    }

    // Keep keyboard focus inside the open (scroll-locked) menu. Tab cycles
    // through the hamburger + menu links; focus escaping the header closes it.
    document.addEventListener("keydown", (event) => {
      if (!menuOpen || event.key !== "Tab" || !menu || !toggle) return;
      const stops = [toggle, ...menuFocusables()];
      if (!stops.length) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !menu.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus();
      }
    });

    document.addEventListener("focusin", (event) => {
      if (!menuOpen || !menu) return;
      const target = event.target;
      if (target instanceof Node && target.closest(".site-header")) return;
      setMenu(false);
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && menuOpen) {
        setMenu(false);
        toggle && toggle.focus();
      }
    });

    document.addEventListener("click", (event) => {
      if (!menuOpen) return;
      if (event.target.closest(".site-header")) return;
      setMenu(false);
    });

    window.matchMedia("(min-width: 1025px)").addEventListener("change", (event) => {
      if (event.matches && menuOpen) setMenu(false);
    });

    /* --------------------------- Scroll reveals -------------------------- */
    const reveals = Array.from(document.querySelectorAll("[data-reveal]"));
    const groups = new Map();
    reveals.forEach((el) => {
      const parent = el.parentElement;
      if (!parent) return;
      const list = groups.get(parent) || [];
      list.push(el);
      groups.set(parent, list);
    });
    groups.forEach((list) => {
      list.forEach((el, index) => {
        el.style.setProperty("--reveal-delay", `${Math.min(index, 6) * 70}ms`);
      });
    });

    if ("IntersectionObserver" in window && !prefersReduced()) {
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          });
        },
        { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
      );
      reveals.forEach((el) => observer.observe(el));
    } else {
      reveals.forEach((el) => el.classList.add("is-visible"));
    }

    /* ------------------------------ Footer year -------------------------- */
    const year = document.getElementById("footer-year");
    if (year) year.textContent = String(new Date().getFullYear());

    /* ------------------------- First-paint hygiene ----------------------- */
    // Remove the boot class once the page has settled so transition-based
    // reveals behave consistently.
    document.documentElement.classList.remove("is-booting");
  });
})();
