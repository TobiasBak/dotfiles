import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Services.SystemTray

PopupButton {
    id: sysTray

    icon: "󰀻"
    popupWidth: Math.max(trayColumn.width + 32, 150)
    popupRightMargin: 45
    popupPadding: 12

    ColumnLayout {
        id: trayColumn
        width: parent ? parent.width : 120
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
