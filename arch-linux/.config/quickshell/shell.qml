import QtQuick
import QtQuick.Layouts
import Quickshell
import "components"

ShellRoot {
    // Main Bar
    PanelWindow {
        id: mainBar
        anchors {
            top: true
            left: true
            right: true
        }
        implicitHeight: 36
        
        color: "transparent" // Let the rectangle handle the color for rounded corners if needed

        Rectangle {
            anchors.fill: parent
            color: "#1a1b26" // Tokyo Night Background
            
            // Bottom border
            Rectangle {
                anchors.bottom: parent.bottom
                width: parent.width
                height: 1
                color: "#7aa2f7"
                opacity: 0.3
            }

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