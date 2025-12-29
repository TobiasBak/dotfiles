import QtQuick
import QtQuick.Layouts
import QtQuick.Controls
import Quickshell
import Quickshell.Io

RowLayout {
    id: root
    spacing: 8

    property var windows: []

    // Initial fetch
    Process {
        id: initialFetch
        command: ["niri", "msg", "--json", "windows"]
        running: true
        stdout: StdioCollector {
            onStreamFinished: {
                try {
                    root.windows = JSON.parse(text);
                } catch (e) {}
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
                try {
                    var event = JSON.parse(data);
                    if (event.WindowsChanged) {
                        root.windows = event.WindowsChanged.windows;
                    }
                } catch (e) {}
            }
        }
        onExited: running = true
    }

    Repeater {
        model: root.windows

        Rectangle {
            width: 30
            height: 30
            radius: 4
            color: modelData.is_focused ? "#363b54" : "transparent"
            
            Image {
                id: iconImage
                anchors.centerIn: parent
                width: 22
                height: 22
                fillMode: Image.PreserveAspectFit
                
                function getIconSource(appId) {
                    var id = appId.toLowerCase();
                    
                    // Try exact app_id first
                    var source = "image://icon/" + appId;
                    
                    // Specific remappings
                    if (id === "alacritty") return "image://icon/Alacritty";
                    if (id === "code-oss") return "image://icon/com.visualstudio.code.oss";
                    if (id === "chromium") return "image://icon/chromium";
                    
                    return source;
                }
                
                source: getIconSource(modelData.app_id)
                
                onStatusChanged: {
                    if (status === Image.Error) {
                        var id = modelData.app_id.toLowerCase();
                        if (id.includes("alacritty")) source = "image://icon/utilities-terminal";
                        else if (id.includes("code")) source = "image://icon/code";
                        else source = "image://icon/application-x-executable";
                    }
                }
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
            ToolTip.text: modelData.title
            ToolTip.delay: 500
        }
    }
}
