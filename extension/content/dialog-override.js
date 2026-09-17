// MAIN world script (see manifest.json). Runs before the page's own scripts,
// so window.confirm/alert are replaced before the site ever calls the native ones.
// MAIN world code has no access to chrome.* APIs, so it talks to
// content/automate.js (isolated world) via a CustomEvent on window.

(function () {
  const EVENT_NAME = "dtis-automation-dialog";

  window.confirm = function (message) {
    window.dispatchEvent(
      new CustomEvent(EVENT_NAME, { detail: { type: "confirm", message } })
    );
    return true;
  };

  window.alert = function (message) {
    window.dispatchEvent(
      new CustomEvent(EVENT_NAME, { detail: { type: "alert", message } })
    );
  };
})();
