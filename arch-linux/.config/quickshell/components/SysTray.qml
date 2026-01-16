import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Services.SystemTray
import Quickshell.Wayland

Item {
    id: sysTray
    implicitWidth: 24
    implicitHeight: 24

    property bool popupVisible: false

    // Tray icon button
    Rectangle {
        anchors.fill: parent
        color: trayMouseArea.containsMouse ? "#363b54" : "transparent"
        radius: 4

        Text {
            anchors.centerIn: parent
            text: "󰀻"
            font.family: "Symbols Nerd Font"
            font.pixelSize: 16
            color: "#c0caf5"
        }

        MouseArea {
            id: trayMouseArea
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: popupVisible = !popupVisible
        }
    }

    // Combined overlay and popup
    PanelWindow {
        id: trayPopup
        visible: popupVisible

        screen: Quickshell.screens[0]
        exclusionMode: ExclusionMode.Ignore

        WlrLayershell.layer: WlrLayer.Overlay
        WlrLayershell.keyboardFocus: WlrKeyboardFocus.OnDemand

        anchors {
            top: true
            bottom: true
            left: true
            right: true
        }

        color: "transparent"

        // Click outside to close
        MouseArea {
            anchors.fill: parent
            onPressed: popupVisible = false
        }

        // Popup content positioned at top-right
        Rectangle {
            id: popupContent
            anchors {
                top: parent.top
                right: parent.right
                topMargin: 52
                rightMargin: 45
            }
            width: Math.max(trayColumn.width + 24, 150)
            height: trayColumn.height + 24
            radius: 10
            color: "#1a1b26"
            border.color: "#363b54"
            border.width: 1

            // Prevent clicks from propagating to overlay
            MouseArea {
                anchors.fill: parent
                onPressed: (mouse) => mouse.accepted = true
            }

            ColumnLayout {
                id: trayColumn
                anchors {
                    left: parent.left
                    top: parent.top
                    margins: 12
                }
                spacing: 8

                Text {
                    text: "System Tray"
                    font.pixelSize: 12
                    font.bold: true
                    color: "#565f89"
                }

                Repeater {
                    model: SystemTray.items

                    Rectangle {
                        Layout.fillWidth: true
                        width: itemRow.width + 16
                        height: 32
                        radius: 6
                        color: itemMouseArea.containsMouse ? "#363b54" : "transparent"

                        RowLayout {
                            id: itemRow
                            anchors.verticalCenter: parent.verticalCenter
                            anchors.left: parent.left
                            anchors.leftMargin: 8
                            spacing: 10

                            Image {
                                Layout.preferredWidth: 18
                                Layout.preferredHeight: 18
                                fillMode: Image.PreserveAspectFit

                                function getIconSource() {
                                    var id = (modelData.id || "").toLowerCase()
                                    // Override known problematic icons
                                    if (id.includes("spotify")) {
                                        return "image://icon/spotify-launcher"
                                    }
                                    return modelData.icon
                                }

                                source: getIconSource()

                                // Fallback for icons that fail to load
                                onStatusChanged: {
                                    if (status === Image.Error) {
                                        source = "image://icon/application-x-executable"
                                    }
                                }
                            }

                            Text {
                                text: modelData.title || modelData.id || "Unknown"
                                font.pixelSize: 13
                                color: "#c0caf5"
                            }
                        }

                        MouseArea {
                            id: itemMouseArea
                            anchors.fill: parent
                            hoverEnabled: true
                            acceptedButtons: Qt.LeftButton | Qt.RightButton
                            cursorShape: Qt.PointingHandCursor
                            onClicked: (mouse) => {
                                if (mouse.button === Qt.LeftButton) {
                                    modelData.activate();
                                    popupVisible = false
                                } else if (mouse.button === Qt.RightButton) {
                                    modelData.menu().open(this);
                                }
                            }
                        }
                    }
                }

                // Show message if no items
                Text {
                    visible: SystemTray.items.length === 0
                    text: "No tray items"
                    font.pixelSize: 12
                    color: "#565f89"
                    font.italic: true
                }
            }
        }
    }
}
