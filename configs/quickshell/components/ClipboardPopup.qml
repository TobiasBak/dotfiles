import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io

Item {
    id: clipboardIndicator

    property bool showPopup: false
    property int popupX: 100
    property int popupY: 50
    property string outputName: ""

    Process {
        id: clipboardWatch
        command: ["wl-paste", "--watch", "echo", "copied"]
        running: true

        stdout: SplitParser {
            splitMarker: "\n"
            onRead: (data) => {
                console.log("Clipboard event: " + data)
                if (data.trim() === "copied") {
                    console.log("Triggering getWindowPos")
                    getWindowPos.running = true
                }
            }
        }
    }

    Process {
        id: getWindowPos
        command: ["/home/tobias/.config/quickshell/scripts/get-window-pos.py"]
        running: false

        stdout: StdioCollector {
            onStreamFinished: {
                console.log("getWindowPos finished, output: " + text)
                try {
                    var parts = text.trim().split("\t")
                    console.log("Parsed parts: " + parts.length + " - " + parts)
                    if (parts.length >= 3) {
                        popupX = parseFloat(parts[0])
                        popupY = parseFloat(parts[1])
                        outputName = parts[2]
                        console.log("Setting popup position: " + popupX + ", " + popupY + " on " + outputName)
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

        screen: Quickshell.screens.find(s => s.name === outputName) ?? Quickshell.screens[0]

        exclusionMode: ExclusionMode.Ignore

        anchors {
            top: true
            left: true
        }

        margins {
            top: popupY
            left: popupX
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
