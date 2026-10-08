import { initPrefs } from "./prefs";
import { registerSection, unregisterSection, analyzeSelected } from "./ui";
import { clearCache } from "./store";
import { ADDON_ID } from "./types";


const MENU_IDS = {
  tools: "paperpilot-tools-analyze",
  item: "paperpilot-item-analyze",
};

function log(msg: string) {
  Zotero.debug("[PaperPilot] " + msg);
}

function addMenuItem(win: any, popupId: string, id: string, label: string, handler: () => void) {
  try {
    const popup = win.document.getElementById(popupId);
    if (!popup || win.document.getElementById(id)) return;
    const mi = win.document.createXULElement("menuitem");
    mi.id = id;
    mi.setAttribute("label", label);
    mi.setAttribute("tooltiptext", "PaperPilot：生成总结并保存为笔记");
    mi.addEventListener("command", handler);
    popup.appendChild(mi);
  } catch (e) {
    log("菜单注册失败: " + e);
  }
}

function removeMenuItems(win: any) {
  Object.values(MENU_IDS).forEach((id) => {
    try {
      const el = win.document.getElementById(id);
      if (el) el.remove();
    } catch (e) {
      /* ignore */
    }
  });
}

const hooks = {
  async onStartup() {
    try {
      await Zotero.initializationPromise;
      initPrefs();
      log("启动，版本 " + __PP_VERSION__);

      // 注册设置面板
      try {
        if (Zotero.PreferencePanes) {
          await Zotero.PreferencePanes.register({
            id: "paperpilot-settings",
            pluginID: ADDON_ID,
            src: "chrome/content/settings.xhtml",
            scripts: ["chrome/content/scripts/settings.js"],
            label: "PaperPilot",
            image: "chrome/skin/icon.svg",
            defaultXUL: false,
          });
        }
      } catch (e) {
        log("设置面板注册失败: " + e);
      }

      // 注册条目面板分区
      try {
        registerSection();
      } catch (e) {
        log("条目面板注册失败: " + e);
      }

      await hooks.onMainWindowLoad({ window: Zotero.getMainWindow() });

    } catch (e) {
      log("启动失败: " + e);
    }
  },

  async onMainWindowLoad({ window: win }: any) {
    if (!win) return;
    try {
      if (win.MozXULElement && typeof win.MozXULElement.insertFTLIfNeeded === "function") {
        win.MozXULElement.insertFTLIfNeeded("paperpilot.ftl");
      }
    } catch (e) {
      log("FTL 加载失败: " + e);
    }
    addMenuItem(win, "menu_ToolsPopup", MENU_IDS.tools, "PaperPilot：生成总结并保存为笔记", () => {
      analyzeSelected();
    });
    addMenuItem(win, "zotero-itemmenu", MENU_IDS.item, "PaperPilot：生成总结并保存为笔记", () => {
      analyzeSelected();
    });
  },

  async onMainWindowUnload({ window: win }: any) {
    if (!win) return;
    removeMenuItems(win);
  },

  async onShutdown() {
    try {
      const win = Zotero.getMainWindow();
      if (win) removeMenuItems(win);
      if (Zotero.ItemPaneManager?.unregisterSection) {
        unregisterSection();
      }
      if (Zotero.PreferencePanes?.unregister) {
        Zotero.PreferencePanes.unregister("paperpilot-settings");
      }
      delete (Zotero as any).PaperPilot;
      log("已卸载");
    } catch (e) {
      log("卸载异常: " + e);
    }
  },
};

(Zotero as any).PaperPilot = {
  id: ADDON_ID,
  version: __PP_VERSION__,
  hooks,
  analyzeSelected,
  clearCache,
  openSettings: () => Zotero.Utilities.Internal.openPreferences("paperpilot-settings"),
};
