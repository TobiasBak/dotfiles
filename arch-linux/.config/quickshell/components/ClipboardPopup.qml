import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io

Item {
    id: clipboardIndicator

    property bool showPopup: false
    property int popupX: 100
    property int popupY: 50

    Process {
        id: clipboardWatch
        command: ["wl-paste", "--watch", "echo", "copied"]
        running: true

        stdout: SplitParser {
            splitMarker: "\n"
            onRead: (data) => {
                if (data.trim() === "copied") {
                    getWindowPos.running = true
                }
            }
        }
    }

    Process {
        id: getWindowPos
        command: ["sh", "-c", "niri msg --json focused-window | jq -r '.layout.tile_size[0], .layout.tile_size[1]'"]
        running: false

        stdout: StdioCollector {
            onStreamFinished: {
                try {
                    var lines = text.trim().split("\n")
                    if (lines.length >= 2) {
                        var windowWidth = parseFloat(lines[0])
                        // Position popup at top-right area of screen (focused output)
                        popupX = windowWidth - 150
                    }
                } catch (e) {
                    console.log("Error parsing window pos: " + e)
                }
                showPopup = true
                hideTimer.restart()
            }
        }
    }

    Timer {
        id: hideTimer
        interval: 1000
        onTriggered: showPopup = false
    }

    PanelWindow {
        id: popup
        visible: showPopup

        exclusionMode: ExclusionMode.Ignore

        anchors {
            top: true
            right: true
        }

        margins {
            top: 50
            right: 20
        }

        implicitWidth: container.width
        implicitHeight: container.height

        color: "transparent"

        Rectangle {
            id: container
            width: row.width + 20
            height: 28
            radius: 14
            color: "#e61a1b26"
            border.color: "#7aa2f7"
            border.width: 1

            RowLayout {
                id: row
                anchors.centerIn: parent
                spacing: 6

                Text {
                    text: "󰅎"
                    font.family: "Symbols Nerd Font"
                    font.pixelSize: 14
                    color: "#7aa2f7"
                }

                Text {
                    text: "Copied"
                    font.pixelSize: 12
                    color: "#c0caf5"
                }
            }
        }
    }
}
