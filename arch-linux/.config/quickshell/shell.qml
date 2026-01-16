import QtQuick
import QtQuick.Layouts
import Quickshell
import "components"

ShellRoot {
    // Voice recording indicator (floating overlay)
    VoiceIndicator {}

    // Clipboard copy indicator
    ClipboardPopup {}

    // Main Bar
    PanelWindow {
        id: mainBar
        anchors {
            top: true
            left: true
            right: true
        }
        margins.top: 8
        implicitHeight: 36
        
        color: "transparent" // Let the rectangle handle the color for rounded corners if needed

        Rectangle {
            anchors.fill: parent
            color: "transparent"
            

            // Left Side
            RowLayout {
                anchors {
                    left: parent.left
                    verticalCenter: parent.verticalCenter
                    leftMargin: 12
                }
                spacing: 10

                Taskbar {}
            }

            // Absolute Center: Workspaces
            Workspaces {
                anchors.centerIn: parent
            }

            // Right Side
            RowLayout {
                anchors {
                    right: parent.right
                    top: parent.top
                    bottom: parent.bottom
                    rightMargin: 12
                }
                spacing: 10

                SysTray {
                    Layout.alignment: Qt.AlignVCenter
                }
                Clock {
                    Layout.alignment: Qt.AlignVCenter
                }
            }
        }
    }
}