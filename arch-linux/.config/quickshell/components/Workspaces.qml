import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io

Item {
    id: root
    width: pill.width
    height: 30

    property var workspaceData: []
    property int focusedWorkspaceIdx: 1

    // Initial fetch
    Process {
        id: initialFetch
        command: ["niri", "msg", "--json", "workspaces"]
        running: true
        stdout: StdioCollector {
            onStreamFinished: {
                try {
                    var workspaces = JSON.parse(text);
                    root.updateFromWorkspaces(workspaces);
                } catch (e) {}
            }
        }
    }

    function updateFromWorkspaces(workspaces) {
        root.workspaceData = workspaces;
        for (var i = 0; i < workspaces.length; i++) {
            if (workspaces[i].is_focused) {
                root.focusedWorkspaceIdx = workspaces[i].idx;
                break;
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
                    if (event.WorkspacesChanged) {
                        root.updateFromWorkspaces(event.WorkspacesChanged.workspaces);
                    } else if (event.WorkspaceActivated) {
                        // When a workspace is activated, its ID is provided.
                        // We need to map ID back to index or just re-fetch to be safe,
                        // but usually idx is what we want.
                        // To be snappiest, we can just trigger a re-fetch of workspaces.
                        initialFetch.running = true;
                    }
                } catch (e) {}
            }
        }
        onExited: running = true
    }

    Process {
        id: switchProc
    }

    Rectangle {
        id: pill
        height: 28
        width: layout.implicitWidth + 12
        color: "#24283b"
        radius: height / 2
        anchors.centerIn: parent
        border.color: "#414868"
        border.width: 1

        Rectangle {
            id: highlight
            height: 22
            width: 28
            radius: height / 2
            color: "#7aa2f7"
            y: 3
            x: 6 + (root.focusedWorkspaceIdx - 1) * 32
            
            Behavior on x {
                NumberAnimation { duration: 150; easing.type: Easing.OutQuint }
            }
            
            visible: root.focusedWorkspaceIdx >= 1 && root.focusedWorkspaceIdx <= 4
        }

        RowLayout {
            id: layout
            anchors.fill: parent
            anchors.leftMargin: 6
            anchors.rightMargin: 6
            spacing: 4

            Repeater {
                model: [1, 2, 3, 4]

                Item {
                    Layout.preferredWidth: 28
                    Layout.preferredHeight: 28

                    Text {
                        anchors.centerIn: parent
                        text: modelData
                        color: modelData === root.focusedWorkspaceIdx ? "#1a1b26" : "#7aa2f7"
                        font.bold: modelData === root.focusedWorkspaceIdx
                        font.pixelSize: 12
                        
                        Behavior on color {
                            ColorAnimation { duration: 150 }
                        }
                    }

                    MouseArea {
                        anchors.fill: parent
                        cursorShape: Qt.PointingHandCursor
                        onClicked: {
                            switchProc.command = ["niri", "msg", "action", "focus-workspace", modelData.toString()];
                            switchProc.running = true;
                        }
                    }
                }
            }
        }
    }
}