import QtQuick
import QtQuick.Layouts
import QtQuick.Controls
import Quickshell
import Quickshell.Io

RowLayout {
    id: root
    spacing: 8

    property var windows: []

    function updateWindows(newWindows) {
        if (!newWindows) return;
        // Ensure newWindows is an array
        if (Array.isArray(newWindows)) {
            root.windows = newWindows;
        } else if (newWindows.windows) {
            root.windows = newWindows.windows;
        }
    }

    Timer {
        id: retryTimer
        interval: 2000
        onTriggered: {
            if (!initialFetch.running) initialFetch.running = true;
            if (!niriEvents.running) niriEvents.running = true;
        }
    }

    Process {
        id: initialFetch
        command: ["niri", "msg", "--json", "windows"]
        running: true
        stdout: StdioCollector {
            onStreamFinished: {
                try {
                    if (text.trim() !== "") {
                        var parsed = JSON.parse(text);
                        updateWindows(parsed);
                    }
                } catch (e) {
                    console.log("Error parsing initial windows: " + e);
                }
            }
        }
        onExited: (exitCode) => {
            if (exitCode !== 0) {
                if (!retryTimer.running) retryTimer.start();
            }
        }
    }

    Process {
        id: niriEvents
        command: ["niri", "msg", "--json", "event-stream"]
        running: true

        stdout: SplitParser {
            splitMarker: "\n"
            onRead: (data) => {
                if (!data || data.trim() === "") return;
                try {
                    var event = JSON.parse(data);
                    if (event.WindowsChanged) {
                        updateWindows(event.WindowsChanged.windows);
                    } else if (event.WindowFocusChanged || event.WindowOpened || event.WindowClosed) {
                        initialFetch.running = true;
                    }
                } catch (e) {
                    // Ignore partial/invalid JSON
                }
            }
        }
        onExited: (exitCode) => {
            running = false;
            if (!retryTimer.running) retryTimer.start();
        }
    }

    Repeater {
        model: root.windows

        Rectangle {
            width: 32
            height: 32
            radius: 6
            color: modelData.is_focused ? "#363b54" : "transparent"
            border.color: modelData.is_focused ? "#7aa2f7" : "transparent"
            border.width: 1
            
            Image {
                id: iconImage
                anchors.centerIn: parent
                width: 22
                height: 22
                fillMode: Image.PreserveAspectFit
                visible: status === Image.Ready
                
                function getIconSource(appId) {
                    if (!appId) return "image://icon/application-x-executable";
                    var id = appId.toLowerCase();
                    
                    // Specific remappings
                    if (id === "alacritty") return "image://icon/Alacritty";
                    if (id === "code-oss" || id === "code") return "image://icon/com.visualstudio.code.oss";
                    if (id === "chromium") return "image://icon/chromium";
                    if (id === "firefox") return "image://icon/firefox";
                    if (id === "spotify") return "image://icon/spotify-launcher";
                    
                    return "image://icon/" + appId;
                }
                
                source: getIconSource(modelData.app_id)
                
                onStatusChanged: {
                    if (status === Image.Error) {
                        var appId = modelData.app_id || "";
                        var id = appId.toLowerCase();
                        if (id.includes("alacritty") || id.includes("terminal")) source = "image://icon/utilities-terminal";
                        else if (id.includes("code")) source = "image://icon/code";
                        else if (id.includes("browser") || id.includes("chromium") || id.includes("firefox")) source = "image://icon/internet-web-browser";
                        else source = "image://icon/application-x-executable";
                    }
                }
            }

            Text {
                anchors.centerIn: parent
                text: (modelData.app_id ? modelData.app_id.substring(0, 1).toUpperCase() : "?")
                color: "#7aa2f7"
                visible: iconImage.status !== Image.Ready
                font.pixelSize: 14
                font.bold: true
            }

            MouseArea {
                id: mouseArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                    var focusProc = Qt.createQmlObject('import Quickshell.Io; Process {}', root);
                    focusProc.command = ["niri", "msg", "action", "focus-window", "--id", modelData.id.toString()];
                    focusProc.running = true;
                }
            }
            
            ToolTip.visible: mouseArea.containsMouse
            ToolTip.text: modelData.title || modelData.app_id || "Window"
            ToolTip.delay: 500
        }
    }
}
