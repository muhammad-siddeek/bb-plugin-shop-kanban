import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { BOARD_ATTR, BOARD_DOCKED_CLASS, BOARD_INSET_VAR } from "./ui/model";
import { BoardOverlay } from "./ui/overlay";
import { OMP_PROVIDER_ID, OmpIcon } from "./ui/provider-icons";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "bottom-board-layout",
    mount() {
      const style = document.createElement("style");
      // The board covers the screen's bottom edge and pads for its safe area itself, so bb's page drops its own.
      style.textContent = `
        html.${BOARD_DOCKED_CLASS} body {
          padding-bottom: var(${BOARD_INSET_VAR});
          --bb-safe-area-bottom: 0px;
        }
        html:has([data-sidebar-mobile-backdrop][data-state="open"]) [${BOARD_ATTR}] {
          visibility: hidden;
        }
      `;
      document.head.appendChild(style);
      return () => {
        style.remove();
        document.documentElement.classList.remove(BOARD_DOCKED_CLASS);
        document.documentElement.style.removeProperty(BOARD_INSET_VAR);
      };
    },
  });

  app.slots.experimental_appOverlay({
    id: "bottom-board",
    component: BoardOverlay,
  });

  // Provider icon registrations are app-wide: this also replaces omp's generic glyph in bb's
  // sidebar and pickers, not just on cards.
  app.slots.experimental_providerIcon({ providerKind: "agent", providerId: OMP_PROVIDER_ID, icon: OmpIcon });
});
