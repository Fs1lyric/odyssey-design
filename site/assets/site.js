/* Odyssey Design, the site.
 *
 * Four small things: the theme toggle, the install tabs, copy buttons, and a
 * reveal-on-arrival pass. No scroll listeners anywhere; arrival is detected
 * with IntersectionObserver, and the reveal is skipped outright when the
 * visitor has asked for reduced motion.
 */

(function () {
  "use strict";

  var root = document.documentElement;

  // ------------------------------------------------------------ theme ---
  // Three states, matching the application: explicit light, explicit dark,
  // and the system setting, which is the absence of the attribute. The
  // button reports where a press would take you, not where you are.

  var themeBtn = document.getElementById("theme");

  function prefersDark() {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function isDark() {
    var set = root.dataset.theme;
    return set ? set === "dark" : prefersDark();
  }

  function paintThemeButton() {
    if (!themeBtn) return;
    var dark = isDark();
    themeBtn.innerHTML =
      '<i class="ph ph-' + (dark ? "sun" : "moon") + '" aria-hidden="true"></i>';
    themeBtn.setAttribute(
      "aria-label",
      dark ? "Switch to the light theme" : "Switch to the dark theme"
    );
  }

  if (themeBtn) {
    themeBtn.addEventListener("click", function () {
      var next = isDark() ? "light" : "dark";
      root.dataset.theme = next;
      try {
        localStorage.setItem("odyssey-site-theme", next);
      } catch (e) {
        /* Private windows and blocked site data both land here. The choice
           simply does not survive a reload, which is fine. */
      }
      paintThemeButton();
    });

    // Follow the system while no explicit choice has been made.
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    var onChange = function () {
      if (!root.dataset.theme) paintThemeButton();
    };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);

    paintThemeButton();
  }

  // ------------------------------------------------------------- tabs ---

  var tablist = document.querySelector('[role="tablist"]');

  if (tablist) {
    var tabs = Array.prototype.slice.call(
      tablist.querySelectorAll('[role="tab"]')
    );

    function select(tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute("aria-selected", on ? "true" : "false");
        var panel = document.getElementById(t.getAttribute("aria-controls"));
        if (panel) panel.hidden = !on;
      });
      if (focus) tab.focus();
    }

    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        select(tab, false);
      });
    });

    // Left and right move between tabs, home and end jump to the ends. This
    // is the pattern screen-reader users expect from a tablist.
    tablist.addEventListener("keydown", function (e) {
      var i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      var next = null;
      if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
      else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === "Home") next = tabs[0];
      else if (e.key === "End") next = tabs[tabs.length - 1];
      if (!next) return;
      e.preventDefault();
      select(next, true);
    });

    // Open on the tab that matches the visitor's machine, so the common case
    // needs no clicking. Linux stays the default because it is the tested
    // platform and the first tab already.
    var ua = navigator.userAgent;
    var guess = null;
    if (/Windows/i.test(ua)) guess = "tab-windows";
    else if (/Mac OS X|Macintosh/i.test(ua)) guess = "tab-macos";
    else if (/Linux/i.test(ua) && !/Android/i.test(ua)) guess = "tab-linux";

    if (guess) {
      var el = document.getElementById(guess);
      if (el) select(el, false);
    }
  }

  // ------------------------------------------------------------- copy ---

  document.querySelectorAll(".cmd__copy").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var code = btn.parentNode.querySelector("code");
      if (!code) return;

      var done = function (ok) {
        btn.innerHTML =
          '<i class="ph ph-' + (ok ? "check" : "copy") + '" aria-hidden="true"></i>';
        if (ok) {
          btn.dataset.copied = "";
          setTimeout(function () {
            btn.innerHTML = '<i class="ph ph-copy" aria-hidden="true"></i>';
            delete btn.dataset.copied;
          }, 1600);
        }
      };

      // navigator.clipboard is absent over plain http and in some embedded
      // webviews, so the selection fallback is not optional.
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(code.textContent).then(
          function () { done(true); },
          function () { done(false); }
        );
        return;
      }

      var sel = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(code);
      sel.removeAllRanges();
      sel.addRange(range);
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      sel.removeAllRanges();
      done(ok);
    });
  });

  // ----------------------------------------------------------- reveal ---

  var reveals = document.querySelectorAll(".reveal");

  if (
    !window.IntersectionObserver ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    reveals.forEach(function (el) { el.classList.add("is-in"); });
    return;
  }

  var io = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-in");
        io.unobserve(entry.target);
      });
    },
    { rootMargin: "0px 0px -10% 0px", threshold: 0 }
  );

  reveals.forEach(function (el) { io.observe(el); });
})();
