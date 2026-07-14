import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

/**
 * Lets Tab accept a visible autocomplete suggestion before falling back to the
 * app-level follow-up action that queues the current message.
 */
export class MultipurposeTabEditor extends CustomEditor {
  private readonly keybindings: KeybindingsManager;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    super(tui, theme, keybindings);
    this.keybindings = keybindings;
  }

  override handleInput(data: string): void {
    if (this.isShowingAutocomplete() && this.keybindings.matches(data, "tui.input.tab")) {
      // CustomEditor handles app actions before Editor autocomplete. Call the
      // base editor directly so a visible completion wins over follow-up.
      Editor.prototype.handleInput.call(this, data);
      return;
    }

    super.handleInput(data);
  }
}

export default function (_pi: ExtensionAPI) {
  _pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new MultipurposeTabEditor(tui, theme, keybindings),
    );
  });
}
