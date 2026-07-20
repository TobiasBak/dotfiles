import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

/**
 * Lets Tab accept a visible autocomplete suggestion before falling back to the
 * app-level follow-up action that queues the current message.
 */
export class MultipurposeTabEditor extends CustomEditor {
  private readonly appKeybindings: KeybindingsManager;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    super(tui, theme, keybindings);
    this.appKeybindings = keybindings;
  }

  override handleInput(data: string): void {
    if (this.isShowingAutocomplete() && this.appKeybindings.matches(data, "tui.input.tab")) {
      // CustomEditor handles app actions before Editor autocomplete. Call the
      // base editor directly so a visible completion wins over follow-up.
      Editor.prototype.handleInput.call(this, data);
      return;
    }

    super.handleInput(data);
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    // An arbitrary custom editor cannot safely be retrofitted with
    // CustomEditor's autocomplete internals. Preserve it instead of silently
    // replacing another extension's editor.
    if (ctx.ui.getEditorComponent()) {
      ctx.ui.notify(
        "Multipurpose Tab was not installed because another custom editor is already active.",
        "warning",
      );
      return;
    }

    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new MultipurposeTabEditor(tui, theme, keybindings),
    );
  });
}
