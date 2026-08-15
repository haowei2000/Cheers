(function () {
  "use strict";

  var catalog = window.CHEERS_EXTENSION_CATALOG;
  var root = document.getElementById("extensionCatalog");
  var search = document.getElementById("extensionSearch");
  var filter = document.getElementById("extensionFilter");
  var status = document.getElementById("extensionStatus");
  if (!root || !search || !filter || !status) return;

  var language = document.documentElement.lang === "zh-CN" ? "zh-CN" : "en";
  var copy = language === "zh-CN" ? {
    unavailable: "扩展目录暂时不可用，请稍后重试。",
    empty: "没有符合当前搜索条件的扩展。",
    count: function (visible, total) { return "显示 " + visible + " / " + total + " 个扩展"; },
    included: "Cheers 内置",
    official: "官方精选",
    version: "版本",
    scene: "场景",
    renderer: "Renderer",
    automation: "定时任务模板",
    noPermissions: "无代码权限",
    globalCapable: "可全局安装",
    macOnly: "仅此 Mac",
    add: "添加到 Mac",
    download: "下载扩展包",
    permissions: "权限",
    categories: { productivity: "效率", research: "研究", engineering: "工程", operations: "运营" }
  } : {
    unavailable: "The extension catalog is temporarily unavailable. Try again later.",
    empty: "No extensions match the current search.",
    count: function (visible, total) { return "Showing " + visible + " of " + total + " extensions"; },
    included: "Included with Cheers",
    official: "Official selection",
    version: "Version",
    scene: "Scene",
    renderer: "Renderer",
    automation: "Automation template",
    noPermissions: "No code permissions",
    globalCapable: "Global capable",
    macOnly: "This Mac",
    add: "Add to Cheers for Mac",
    download: "Download package",
    permissions: "Permissions",
    categories: { productivity: "Productivity", research: "Research", engineering: "Engineering", operations: "Operations" }
  };

  function element(name, className, text) {
    var node = document.createElement(name);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function capabilityTags(entry) {
    var category = copy.categories[entry.category] || entry.category;
    if (entry.kind === "builtin") return [category].concat(entry.contributes.map(function (value) {
      return value === "scene" ? copy.scene : value;
    }));
    var values = [category];
    if (entry.contributes.scenes) values.push(entry.contributes.scenes + " " + copy.scene);
    if (entry.contributes.renderers) values.push(entry.contributes.renderers + " " + copy.renderer);
    if (entry.contributes.automations) values.push(entry.contributes.automations + " " + copy.automation);
    var permissions = Object.keys(entry.permissions || {});
    values.push(permissions.length ? copy.permissions + ": " + permissions.join(", ") : copy.noPermissions);
    values.push(entry.globalCapable ? copy.globalCapable : copy.macOnly);
    return values;
  }

  function card(entry) {
    var article = element("article", "extension-entry");
    var head = element("div", "extension-entry-head");
    var titleBlock = element("div");
    var title = element("h2", "", entry.title[language]);
    var mark = element("div", "extension-entry-mark", entry.title[language].slice(0, 1).toUpperCase());
    mark.setAttribute("aria-hidden", "true");
    var metaText = entry.kind === "builtin"
      ? copy.included + " · " + entry.publisher
      : copy.official + " · " + copy.version + " " + entry.version + " · " + entry.publisher;
    titleBlock.append(title, element("div", "entry-meta", metaText));
    head.append(mark, titleBlock);
    article.append(head, element("p", "entry-description", entry.description[language]));

    var tags = element("div", "entry-tags");
    capabilityTags(entry).forEach(function (value) { tags.append(element("span", "entry-tag", value)); });
    article.append(tags);

    if (entry.kind === "package") {
      var actions = element("div", "entry-actions");
      var install = element("a", "", copy.add);
      install.href = entry.installUrl;
      install.setAttribute("aria-label", copy.add + ": " + entry.title[language]);
      var download = element("a", "", copy.download);
      download.href = entry.downloadPath;
      download.download = entry.id + "-" + entry.version + ".cheers-extension";
      download.setAttribute("aria-label", copy.download + ": " + entry.title[language]);
      actions.append(install, download);
      article.append(actions);
    }
    return article;
  }

  function render() {
    if (!catalog || catalog.schemaVersion !== 1 || !Array.isArray(catalog.entries)) {
      root.replaceChildren(element("p", "catalog-empty", copy.unavailable));
      status.textContent = "";
      return;
    }
    var query = search.value.trim().toLocaleLowerCase(language);
    var kind = filter.value;
    var entries = catalog.entries.filter(function (entry) {
      if (kind !== "all" && entry.kind !== kind) return false;
      var haystack = [entry.id, entry.category, entry.publisher, entry.title[language], entry.description[language]].join(" ").toLocaleLowerCase(language);
      return !query || haystack.includes(query);
    });
    root.replaceChildren();
    if (!entries.length) root.append(element("p", "catalog-empty", copy.empty));
    else entries.forEach(function (entry) { root.append(card(entry)); });
    status.textContent = copy.count(entries.length, catalog.entries.length);
  }

  search.addEventListener("input", render);
  filter.addEventListener("change", render);
  render();
}());
