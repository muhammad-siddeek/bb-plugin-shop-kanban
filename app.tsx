import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { BOTTOM_BOARD_COLLAPSED_CLASS, BOTTOM_BOARD_HEIGHT_VAR, BOTTOM_BOARD_OPEN_CLASS } from "./ui/model";
import { BottomBoardOverlay } from "./ui/overlay";
import { OmpIcon } from "./ui/provider-icons";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "bottom-board-layout",
    mount() {
      const style = document.createElement("style");
      style.textContent = `
        html.${BOTTOM_BOARD_OPEN_CLASS} body {
          padding-bottom: var(${BOTTOM_BOARD_HEIGHT_VAR}, max(20rem, 48vh));
        }
        /* Phones: the hidden board is a full-width bottom bar (see overlay.tsx); keep it off bb's controls. */
        @media (width < 40rem) {
          html.${BOTTOM_BOARD_COLLAPSED_CLASS} body {
            padding-bottom: calc(2.75rem + env(safe-area-inset-bottom));
          }
        }
      `;
      document.head.appendChild(style);
      return () => {
        style.remove();
        document.documentElement.classList.remove(BOTTOM_BOARD_OPEN_CLASS, BOTTOM_BOARD_COLLAPSED_CLASS);
        document.documentElement.style.removeProperty(BOTTOM_BOARD_HEIGHT_VAR);
      };
    },
  });

  // The board lives only in the bottom overlay; no nav-rail destination is registered.
  app.slots.experimental_appOverlay({
    id: "bottom-board",
    component: BottomBoardOverlay,
  });

  // Provider icon registrations are app-wide: this also replaces omp's generic glyph in bb's
  // sidebar and pickers, not just on cards.
  app.slots.experimental_providerIcon({ providerKind: "agent", providerId: "acp-omp", icon: OmpIcon });
});
