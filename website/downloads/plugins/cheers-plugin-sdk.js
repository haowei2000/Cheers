/* cheers-plugin-sdk v2 — protocol 1. (v2 adds open/compose/log + uncaught-error
 * forwarding and the one-save-in-flight guard; the wire protocol is unchanged.)
 *
 * Copy-paste this function INLINE into your plugin's <script> — plugins are single
 * self-contained .html files, there is no external script loading in the sandbox.
 * It wraps the workbench render/save postMessage protocol (the normative reference
 * is docs/developer/PLUGIN_DEVELOPMENT.md §5):
 *
 *   var host = cheersPlugin({
 *     onRender: function (file) {
 *       // { path, format, content, version, rendererId } — sent in reply to your
 *       // cheers:ready and re-sent after a conflicted save (the only two triggers,
 *       // §5.2 — external edits do NOT re-render): always re-draw here.
 *     }
 *   });
 *   host.save(content)          // -> Promise<{version}>; rejects on failure (on a
 *                               //    version conflict a fresh onRender follows — let
 *                               //    the user reapply, don't blind-retry). At most ONE
 *                               //    save may be in flight: the host does not correlate
 *                               //    saves (cheers:saved carries no reqId), so calling
 *                               //    save() again before the previous one settles
 *                               //    rejects immediately.
 *   host.resource(name, params) // -> Promise<data> for the read-only channel.*
 *                               //    whitelist (channel.info / members / messages …)
 *   host.unsupported(reason)    // -> final verdict: this content can't be rendered
 *   host.log(msg, level)        // -> a line in the host's dev protocol inspector
 *
 * cheers:ready is posted for you, after the listener is wired.
 *
 * DEBUGGING: the sandbox has an opaque origin, so nothing you console.log and no error
 * you throw reaches the host page — a broken renderer just shows a blank iframe. This
 * SDK forwards uncaught errors and unhandled promise rejections as `cheers:log`, which
 * a session-loaded (⏱) plugin surfaces in the workbench's "Dev" inspector. Use
 * host.log() for your own traces. Hosts that don't implement cheers:log ignore it.
 */
function cheersPlugin(opts) {
  var reqId = 0;
  var pendingRes = {}; // reqId -> {resolve, reject}
  var pendingSave = null; // the ONE allowed in-flight save (hosts do not correlate saves)
  window.addEventListener("message", function (e) {
    var m = e.data;
    if (!m || typeof m !== "object") return;
    if (m.type === "cheers:render") {
      if (opts.onRender) opts.onRender(m);
    } else if (m.type === "cheers:saved") {
      var p = pendingSave;
      pendingSave = null;
      if (p) (m.ok ? p.resolve({ version: m.version }) : p.reject(new Error(m.error || "save failed")));
    } else if (m.type === "cheers:resource:result") {
      var r = pendingRes[m.reqId];
      if (!r) return;
      delete pendingRes[m.reqId];
      (m.ok ? r.resolve(m.data) : r.reject(new Error(m.error || "resource error")));
    }
  });
  var api = {
    save: function (content) {
      return new Promise(function (resolve, reject) {
        if (pendingSave) {
          // cheers:saved carries no correlation id, so overlapping saves could adopt
          // each other's results. Reject loudly instead of queueing silently — await
          // the previous save() before issuing the next one.
          reject(new Error("save already in flight — await the previous save() first"));
          return;
        }
        pendingSave = { resolve: resolve, reject: reject };
        parent.postMessage({ type: "cheers:save", content: content }, "*");
      });
    },
    resource: function (name, params) {
      return new Promise(function (resolve, reject) {
        var id = ++reqId;
        pendingRes[id] = { resolve: resolve, reject: reject };
        parent.postMessage({ type: "cheers:resource", reqId: id, resource: name, params: params || {} }, "*");
      });
    },
    unsupported: function (reason) {
      parent.postMessage({ type: "cheers:unsupported", reason: reason }, "*");
    },
    open: function (uri) {
      // Navigate the USER's view to a `cheers:` locator (workspace file at a line,
      // desk file, attachment). Fire-and-forget; hosts without support ignore it.
      parent.postMessage({ type: "cheers:open", uri: uri }, "*");
    },
    log: function (message, level) {
      // Dev-loop only: a line in the host's protocol inspector. Fire-and-forget.
      parent.postMessage(
        { type: "cheers:log", level: level || "info", message: String(message).slice(0, 2000) },
        "*"
      );
    },
    compose: function (text) {
      // PREFILL the channel composer with a suggested message — never sends; the
      // human reviews and presses send. Fire-and-forget; unsupported hosts ignore it.
      parent.postMessage({ type: "cheers:compose", text: text }, "*");
    },
  };
  // Make silent failures visible: an opaque-origin sandbox swallows these otherwise.
  window.addEventListener("error", function (e) {
    api.log(
      "uncaught: " + (e.message || "error") + " @" + (e.filename || "?") + ":" + (e.lineno || 0),
      "error"
    );
  });
  window.addEventListener("unhandledrejection", function (e) {
    api.log("unhandled rejection: " + ((e.reason && e.reason.message) || e.reason), "error");
  });
  parent.postMessage({ type: "cheers:ready" }, "*");
  return api;
}
