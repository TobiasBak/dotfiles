import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Wayland

Item {
    id: popupButton
    implicitWidth: label.length > 0 ? buttonRow.implicitWidth + 12 : 24
    implicitHeight: 24

    property bool popupVisible: false
    property string icon: ""
    property string label: ""
    property color foregroundColor: "#c0caf5"
    property int popupWidth: 200
    property int popupTopMargin: 52
    property int popupRightMargin: 80
    property int popupPadding: 16
    property var popupScreen: Quickshell.screens[0]

    // Content to show inside the popup - set by parent
    default property alias popupContent: popupContentContainer.data

    // Button appearance
    Rectangle {
        anchors.fill: parent
        color: buttonMouseArea.containsMouse ? "#363b54" : "transparent"
        radius: 4

        RowLayout {
            id: buttonRow
            anchors.centerIn: parent
            spacing: 5

            Text {
                visible: popupButton.icon.length > 0
                text: popupButton.icon
                font.family: "Symbols Nerd Font"
                font.pixelSize: 16
                color: popupButton.foregroundColor
            }

            Text {
                visible: popupButton.label.length > 0
                text: popupButton.label
                font.pixelSize: 12
                font.bold: true
                color: popupButton.foregroundColor
            }
        }

        MouseArea {
            id: buttonMouseArea
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: popupVisible = !popupVisible
        }
    }

    // Combined overlay and popup
    PanelWindow {
        id: popup
        visible: popupVisible

        screen: popupButton.popupScreen
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

        // Popup content container
        Rectangle {
            id: popupContainer
            anchors {
                top: parent.top
                right: parent.right
                topMargin: popupTopMargin
                rightMargin: popupRightMargin
            }
            width: popupWidth
            height: popupContentContainer.childrenRect.height + (popupPadding * 2)
            radius: 10
            color: "#1a1b26"
            border.color: "#363b54"
            border.width: 1

            // Prevent clicks from propagating to overlay
            MouseArea {
                anchors.fill: parent
                onPressed: (mouse) => mouse.accepted = true
            }

            // Container for custom content
            Item {
                id: popupContentContainer
                anchors {
                    left: parent.left
                    right: parent.right
                    top: parent.top
                    margins: popupPadding
                }
                height: childrenRect.height
            }
        }
    }
}
