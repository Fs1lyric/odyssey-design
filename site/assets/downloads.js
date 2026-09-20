/* Fills the downloads page from releases.json, which packaging/sync-release.sh
 * rewrites whenever a release is published. The page is readable without this
 * running at all: the table says where to look, and every command is in the
 * markup already. All this adds is the real file list and the honest state of
 * each package channel.
 */

(function () {
  "use strict";

  var tbody = document.getElementById("sums");

  function text(el, s) { el.textContent = s; }

  function human(bytes) {
    if (!bytes && bytes !== 0) return "";
    if (bytes < 1024) return bytes + " B";
    var units = ["KB", "MB", "GB"], i = -1, n = bytes;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return (n < 10 ? n.toFixed(1) : Math.round(n)) + " " + units[i];
  }

  function row(asset) {
    var tr = document.createElement("tr");
    [
      asset.file || "",
      (asset.platform || "") + (asset.arch ? " " + asset.arch : ""),
      human(asset.bytes),
      asset.sha256 || ""
    ].forEach(function (value) {
      var td = document.createElement("td");
      text(td, value);
      tr.appendChild(td);
    });
    return tr;
  }

  function empty(message) {
    var tr = document.createElement("tr");
    var td = document.createElement("td");
    td.colSpan = 4;
    td.style.fontFamily = "var(--sans)";
    td.style.color = "var(--ink-2)";
    text(td, message);
    tr.appendChild(td);
    return tr;
  }

  // A channel that is not published yet says so next to its command, rather
  // than leaving a command that cannot resolve looking like a live one.
  function markChannel(name, channel, repo, tag) {
    var p = document.querySelector('[data-channel="' + name + '"]');
    if (!p || !channel || channel.available) return;

    var badge = document.createElement("span");
    badge.className = "status status--soon";
    text(badge, "Not published yet");

    var note = document.createElement("span");
    text(
      note,
      " The manifest is in the repository and the release workflow builds the " +
      "files, but nothing has been submitted to this registry yet."
    );

    p.appendChild(document.createElement("br"));
    p.appendChild(badge);
    p.appendChild(note);
  }

  fetch("releases.json", { cache: "no-cache" })
    .then(function (r) {
      if (!r.ok) throw new Error("releases.json " + r.status);
      return r.json();
    })
    .then(function (data) {
      document.querySelectorAll("[data-version]").forEach(function (el) {
        text(el, data.version || "");
      });

      var assets = Array.isArray(data.assets) ? data.assets : [];
      if (!tbody) return;
      tbody.innerHTML = "";

      if (!assets.length || data.published === false) {
        tbody.appendChild(
          empty(
            data.published === false
              ? "No release has been published yet. Build the installer yourself with packaging/build-installer.sh, or watch the releases page."
              : "No files listed."
          )
        );
      } else {
        assets.forEach(function (a) { tbody.appendChild(row(a)); });
      }

      var ch = data.channels || {};
      markChannel("winget", ch.winget);
      markChannel("homebrew", ch.homebrew);
      markChannel("aur", ch.aur);
      markChannel("scoop", ch.scoop);
    })
    .catch(function () {
      if (!tbody) return;
      tbody.innerHTML = "";
      tbody.appendChild(
        empty("Could not load the file list. The releases page has every file.")
      );
    });
})();
