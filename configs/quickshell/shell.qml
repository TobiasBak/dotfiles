import QtQuick
import QtQuick.Layouts
import Quickshell
import "components"

ShellRoot {
    // Clipboard copy indicator
    ClipboardPopup {}

    // Main Bar (one per screen)
    Variants {
        model: Quickshell.screens
        PanelWindow {
            id: mainBar
            property var modelData
            screen: modelData
            property real barScale: barSettingsCtrl.barScale

            anchors {
                top: true
                left: true
                right: true
            }
            margins.top: 8
            implicitHeight: 36 * barScale

            color: "transparent"

            Item {
                anchors.fill: parent

                Item {
                    width: parent.width / mainBar.barScale
                    height: 36
                    scale: mainBar.barScale
                    transformOrigin: Item.TopLeft

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

                            Taskbar {
                                outputName: mainBar.screen.name
                            }
                        }

                        // Absolute Center: Workspaces
                        Workspaces {
                            anchors.centerIn: parent
                            outputName: mainBar.screen.name
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

                            AudioControl {
                                Layout.alignment: Qt.AlignVCenter
                                popupScreen: mainBar.screen
                            }
                            SysTray {
                                Layout.alignment: Qt.AlignVCenter
                                popupScreen: mainBar.screen
                            }
                            BarSettings {
                                id: barSettingsCtrl
                                outputName: mainBar.screen.name
                                popupScreen: mainBar.screen
                                Layout.alignment: Qt.AlignVCenter
                            }
                            Clock {
                                Layout.alignment: Qt.AlignVCenter
                            }
                        }
                    }
                }
            }
        }
    }
}
