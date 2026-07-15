{ ... }:

{
  # These are user-session concerns rather than system-wide WSL settings.
  # Keep them here so a native desktop profile does not inherit wslview.
  home.sessionVariables = {
    BROWSER = "wslview";
    GH_BROWSER = "wslview";
  };
}
