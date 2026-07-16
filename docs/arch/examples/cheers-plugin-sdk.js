/* cheers-plugin-sdk v1 — protocol 1.
 *
 * Copy-paste this function INLINE into your plugin's <script> — plugins are single
 * self-contained .html files, there is no external script loading in the sandbox.
 * It wraps the workbench render/save postMessage protocol (the normative reference
 * is docs/developer/PLUGIN_DEVELOPMENT.md §5):
 *
 *   var host = cheersPlugin({
 *     onRender: function (file) {
 *       // { path, format, content, version, rendererId } — also re-sent when the
 *       // file changes externally and after a save conflict: always re-draw here.
 *     }
 *   });
 *   host.save(content)          // -> Promise<{version}>; rejects on failure (on a
 *                               //    version conflict a fresh onRender follows — let
 *                               //    the user reapply, don't blind-retry)
 *   host.resource(name, params) // -> Promise<data> for the read-only channel.*
 *                               //    whitelist (channel.info / members / messages …)
 *   host.unsupported(reason)    // -> final verdict: this content can't be rendered
 *
 * cheers:ready is posted for you, after the listener is wired.
 */
function cheersPlugin(opts) {
  var reqId = 0;
  var pendingRes = {}; // reqId -> {resolve, reject}
  var pendingSave = null; // single in-flight save; the host answers in order
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
  };
  parent.postMessage({ type: "cheers:ready" }, "*");
  return api;
}
