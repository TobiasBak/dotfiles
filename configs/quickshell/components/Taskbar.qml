pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Layouts
import QtQuick.Controls
import Quickshell.Io

RowLayout {
    id: root
    spacing: 8

    required property var niriState
    property string outputName: ""
    property var workspaceOutputMap: {
        var map = {}
        for (var i = 0; i < niriState.workspaces.length; i++) {
            var workspace = niriState.workspaces[i]
            map[workspace.id] = workspace.output
        }
        return map
    }
    property var displayItems: buildDisplayItems(niriState.windows, workspaceOutputMap, outputName)

    function buildDisplayItems(windows, outputMap, output) {
        var filteredWindows = windows.filter(window => !output || outputMap[window.workspace_id] === output)
        filteredWindows.sort((a, b) => {
            var workspaceA = a.workspace_id || 0
            var workspaceB = b.workspace_id || 0
            if (workspaceA !== workspaceB) return workspaceA - workspaceB
            if (a.is_focused !== b.is_focused) return a.is_focused ? -1 : 1
            return a.id - b.id
        })

        var items = []
        var lastWorkspaceId = null
        for (var i = 0; i < filteredWindows.length; i++) {
            var window = filteredWindows[i]
            if (lastWorkspaceId !== null && window.workspace_id !== lastWorkspaceId) {
                items.push({ kind: "separator" })
            }
            items.push({ kind: "window", window: window })
            lastWorkspaceId = window.workspace_id
        }
        return items
    }

    Process {
        id: focusProc
    }

    Repeater {
        model: root.displayItems

        Item {
            required property var modelData
            property var itemData: modelData
            property var windowData: itemData.kind === "window" ? itemData.window : null
            width: itemData.kind === "separator" ? 10 : 32
            height: 32

            Rectangle {
                width: 1
                height: 18
                radius: 0
                antialiasing: false
                x: Math.round((parent.width - width) / 2)
                y: Math.round((parent.height - height) / 2)
                color: "#24283b"
                opacity: 0.8
                visible: itemData.kind === "separator"
            }

            Rectangle {
                anchors.centerIn: parent
                width: 32
                height: 32
                radius: 6
                visible: itemData.kind === "window"
                color: windowData && windowData.is_focused ? "#363b54" : "transparent"
                border.color: windowData && windowData.is_focused ? "#7aa2f7" : "transparent"
                border.width: 1

                Image {
                    id: iconImage
                    anchors.centerIn: parent
                    width: 22
                    height: 22
                    fillMode: Image.PreserveAspectFit
                    visible: parent.visible && status === Image.Ready
                    opacity: windowData && windowData.is_focused ? 1.0 : 0.5

                    function getIconSource(appId) {
                        if (!appId) return "image://icon/application-x-executable";
                        var id = appId.toLowerCase();

                        // Specific remappings
                        if (id === "ghostty" || id === "com.mitchellh.ghostty") return "image://icon/com.mitchellh.ghostty";
                        if (id === "code-oss" || id === "code") return "image://icon/vscode";
                        if (id === "chromium" || id === "chromium-browser") return "image://icon/chromium";
                        if (id === "remote-viewer") return "file:///run/current-system/sw/share/icons/Papirus/22x22/apps/virt-viewer.svg";
                        if (id === "firefox") return "image://icon/firefox";
                        if (id === "spotify") return "image://icon/spotify-launcher";
                        if (id === "codex" || id === "codex-app") return "image://icon/codex-app";

                        return "image://icon/" + appId;
                    }

                    source: windowData ? getIconSource(windowData.app_id) : ""

                    onStatusChanged: {
                        if (status === Image.Error) {
                            var appId = windowData && windowData.app_id ? windowData.app_id : "";
                            var id = appId.toLowerCase();
                            if (id.includes("ghostty")) source = "image://icon/com.mitchellh.ghostty";
                            else if (id.includes("terminal")) source = "image://icon/utilities-terminal";
                            else if (id.includes("code")) source = "image://icon/vscode";
                            else if (id.includes("codex")) source = "image://icon/codex-app";
                            else if (id.includes("chromium")) source = "image://icon/chromium";
                            else if (id.includes("firefox")) source = "image://icon/firefox";
                            else if (id.includes("browser")) source = "image://icon/internet-web-browser";
                            else if (id.includes("remote-viewer")) source = "file:///run/current-system/sw/share/icons/Papirus/22x22/apps/virt-viewer.svg";
                            else source = "image://icon/application-x-executable";
                        }
                    }
                }

                Text {
                    anchors.centerIn: parent
                    text: windowData && windowData.app_id ? windowData.app_id.substring(0, 1).toUpperCase() : "?"
                    color: "#7aa2f7"
                    visible: parent.visible && iconImage.status !== Image.Ready
                    opacity: windowData && windowData.is_focused ? 1.0 : 0.5
                    font.pixelSize: 14
                    font.bold: true
                }

                MouseArea {
                    id: mouseArea
                    anchors.fill: parent
                    enabled: parent.visible
                    hoverEnabled: true
                    cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                    onClicked: {
                        focusProc.command = ["niri", "msg", "action", "focus-window", "--id", windowData.id.toString()]
                        focusProc.running = true
                    }
                }

                ToolTip.visible: mouseArea.containsMouse
                ToolTip.text: windowData ? (windowData.title || windowData.app_id || "Window") : ""
                ToolTip.delay: 500
            }
        }
    }
}
