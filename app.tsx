import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { TOP_BOARD_ATTR, TOP_BOARD_CLASS, TOP_BOARD_INSET_VAR } from "./ui/model";
import { TopBoardOverlay } from "./ui/overlay";
import { OmpIcon } from "./ui/provider-icons";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "top-board-layout",
    mount() {
      const style = document.createElement("style");
      style.textContent = `
        html.${TOP_BOARD_CLASS} body {
          padding-top: var(${TOP_BOARD_INSET_VAR});
        }
        html:has([data-sidebar-mobile-backdrop][data-state="open"]) [${TOP_BOARD_ATTR}] {
          visibility: hidden;
        }
      `;
      document.head.appendChild(style);
      return () => {
        style.remove();
        document.documentElement.classList.remove(TOP_BOARD_CLASS);
        document.documentElement.style.removeProperty(TOP_BOARD_INSET_VAR);
      };
    },
  });

  app.slots.experimental_appOverlay({
    id: "top-board",
    component: TopBoardOverlay,
  });

  // Provider icon registrations are app-wide: this also replaces omp's generic glyph in bb's
  // sidebar and pickers, not just on cards.
  app.slots.experimental_providerIcon({ providerKind: "agent", providerId: "acp-omp", icon: OmpIcon });
});
