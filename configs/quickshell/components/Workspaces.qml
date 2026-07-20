pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Layouts
import Quickshell.Io

Item {
    id: root
    width: pill.width
    height: 30

    required property var niriState
    property string outputName: ""
    property var outputWorkspaces: niriState.workspaces.filter(workspace => workspace.output === outputName)
    property int focusedWorkspaceIdx: {
        for (var i = 0; i < outputWorkspaces.length; i++) {
            if (outputWorkspaces[i].is_active) return outputWorkspaces[i].idx
        }
        return 0
    }

    function workspaceId(index) {
        for (var i = 0; i < outputWorkspaces.length; i++) {
            if (outputWorkspaces[i].idx === index) return outputWorkspaces[i].id
        }
        return undefined
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
            height: 22
            width: 28
            radius: height / 2
            color: "#7aa2f7"
            y: 3
            x: 6 + (root.focusedWorkspaceIdx - 1) * 32
            visible: root.focusedWorkspaceIdx >= 1 && root.focusedWorkspaceIdx <= 4

            Behavior on x {
                NumberAnimation { duration: 150; easing.type: Easing.OutQuint }
            }
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
                    required property int modelData
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
                            var id = root.workspaceId(modelData)
                            switchProc.command = id !== undefined
                                ? ["niri", "msg", "action", "focus-workspace", "--id", id.toString()]
                                : ["niri", "msg", "action", "focus-workspace", modelData.toString()]
                            switchProc.running = true
                        }
                    }
                }
            }
        }
    }
}
