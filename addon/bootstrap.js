/* PaperPilot lifecycle */
function install() {}
function uninstall() {}
async function startup({rootURI}) {
  await Zotero.initializationPromise;
  Services.scriptloader.loadSubScript(rootURI + "chrome/content/scripts/index.js", this);
  Zotero.PaperPilot.rootURI = rootURI;
  await Zotero.PaperPilot.hooks.onStartup();
}
async function shutdown() { await Zotero.PaperPilot?.hooks.onShutdown(); }
async function onMainWindowLoad({window}) { await Zotero.PaperPilot?.hooks.onMainWindowLoad({window}); }
async function onMainWindowUnload({window}) { await Zotero.PaperPilot?.hooks.onMainWindowUnload({window}); }
