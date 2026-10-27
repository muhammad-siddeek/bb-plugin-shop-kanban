import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { BOTTOM_BOARD_HEIGHT_VAR, BOTTOM_BOARD_OPEN_CLASS } from "./ui/model";
import { BottomBoardOverlay } from "./ui/overlay";
import { OmpIcon } from "./ui/provider-icons";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "bottom-board-layout",
    mount({ signal }) {
      const style = document.createElement("style");
      style.textContent = `
        html.${BOTTOM_BOARD_OPEN_CLASS} body {
          padding-bottom: var(${BOTTOM_BOARD_HEIGHT_VAR}, max(20rem, 48vh));
        }
      `;
      document.head.appendChild(style);
      const cleanup = () => {
        style.remove();
        document.documentElement.classList.remove(BOTTOM_BOARD_OPEN_CLASS);
        document.documentElement.style.removeProperty(BOTTOM_BOARD_HEIGHT_VAR);
      };
      signal.addEventListener("abort", cleanup, { once: true });
      return cleanup;
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
