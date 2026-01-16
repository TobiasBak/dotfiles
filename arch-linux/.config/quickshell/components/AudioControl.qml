import QtQuick
import QtQuick.Layouts
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import Quickshell.Wayland

Item {
    id: audioControl
    implicitWidth: 24
    implicitHeight: 24

    property real outputVolume: 0.0
    property real inputVolume: 0.0
    property bool outputMuted: false
    property bool inputMuted: false
    property bool popupVisible: false

    // Get output volume
    Process {
        id: getOutputVolume
        command: ["wpctl", "get-volume", "@DEFAULT_AUDIO_SINK@"]
        running: true
        stdout: StdioCollector {
            onStreamFinished: {
                var match = text.match(/Volume:\s*([\d.]+)(\s*\[MUTED\])?/)
                if (match) {
                    outputVolume = parseFloat(match[1])
                    outputMuted = match[2] !== undefined
                }
            }
        }
    }

    // Get input volume
    Process {
        id: getInputVolume
        command: ["wpctl", "get-volume", "@DEFAULT_AUDIO_SOURCE@"]
        running: true
        stdout: StdioCollector {
            onStreamFinished: {
                var match = text.match(/Volume:\s*([\d.]+)(\s*\[MUTED\])?/)
                if (match) {
                    inputVolume = parseFloat(match[1])
                    inputMuted = match[2] !== undefined
                }
            }
        }
    }

    // Refresh volumes periodically
    Timer {
        interval: 1000
        running: true
        repeat: true
        onTriggered: {
            getOutputVolume.running = true
            getInputVolume.running = true
        }
    }

    // Speaker icon
    Rectangle {
        anchors.fill: parent
        color: mouseArea.containsMouse ? "#363b54" : "transparent"
        radius: 4

        Text {
            anchors.centerIn: parent
            text: outputMuted ? "󰖁" : (outputVolume > 0.5 ? "󰕾" : (outputVolume > 0 ? "󰖀" : "󰕿"))
            font.family: "Symbols Nerd Font"
            font.pixelSize: 16
            color: "#c0caf5"
        }

        MouseArea {
            id: mouseArea
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: popupVisible = !popupVisible
        }
    }

    // Combined overlay and popup
    PanelWindow {
        id: volumePopup
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
                rightMargin: 80
            }
            width: 280
            height: column.height + 32
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
                id: column
                anchors {
                    left: parent.left
                    right: parent.right
                    top: parent.top
                    margins: 16
                }
                spacing: 16

                // Output volume
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 6

                    RowLayout {
                        spacing: 10
                        Text {
                            text: "󰕾"
                            font.family: "Symbols Nerd Font"
                            font.pixelSize: 18
                            color: "#7aa2f7"
                        }
                        Text {
                            text: "Output"
                            font.pixelSize: 14
                            color: "#c0caf5"
                        }
                        Item { Layout.fillWidth: true }
                        Text {
                            text: Math.round(outputVolume * 100) + "%"
                            font.pixelSize: 13
                            color: "#565f89"
                        }
                    }

                    // Custom slider using MouseArea
                    Item {
                        id: outputSliderItem
                        Layout.fillWidth: true
                        height: 24

                        property real displayValue: outputVolume

                        Rectangle {
                            id: outputTrack
                            anchors.verticalCenter: parent.verticalCenter
                            width: parent.width
                            height: 6
                            radius: 3
                            color: "#363b54"

                            Rectangle {
                                width: Math.min(outputSliderItem.displayValue / 1.5, 1.0) * parent.width
                                height: parent.height
                                color: "#7aa2f7"
                                radius: 3
                            }
                        }

                        Rectangle {
                            id: outputHandle
                            x: Math.min(outputSliderItem.displayValue / 1.5, 1.0) * (parent.width - width)
                            anchors.verticalCenter: parent.verticalCenter
                            width: 18
                            height: 18
                            radius: 9
                            color: outputMouseArea.pressed ? "#89b4fa" : "#7aa2f7"
                        }

                        MouseArea {
                            id: outputMouseArea
                            anchors.fill: parent
                            cursorShape: Qt.PointingHandCursor
                            onPressed: (mouse) => updateOutputVolume(mouse.x)
                            onPositionChanged: (mouse) => {
                                if (pressed) updateOutputVolume(mouse.x)
                            }
                            onReleased: outputSliderItem.displayValue = Qt.binding(() => outputVolume)
                            function updateOutputVolume(mouseX) {
                                var newVol = Math.max(0, Math.min(1.5, (mouseX / width) * 1.5))
                                outputSliderItem.displayValue = newVol
                                var proc = Qt.createQmlObject('import Quickshell.Io; Process {}', audioControl)
                                proc.command = ["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", newVol.toFixed(2)]
                                proc.running = true
                            }
                        }
                    }
                }

                // Input volume
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 6

                    RowLayout {
                        spacing: 10
                        Text {
                            text: "󰍬"
                            font.family: "Symbols Nerd Font"
                            font.pixelSize: 18
                            color: "#f7768e"
                        }
                        Text {
                            text: "Microphone"
                            font.pixelSize: 14
                            color: "#c0caf5"
                        }
                        Item { Layout.fillWidth: true }
                        Text {
                            text: Math.round(inputVolume * 100) + "%"
                            font.pixelSize: 13
                            color: "#565f89"
                        }
                    }

                    // Custom slider using MouseArea
                    Item {
                        id: inputSliderItem
                        Layout.fillWidth: true
                        height: 24

                        property real displayValue: inputVolume

                        Rectangle {
                            id: inputTrack
                            anchors.verticalCenter: parent.verticalCenter
                            width: parent.width
                            height: 6
                            radius: 3
                            color: "#363b54"

                            Rectangle {
                                width: Math.min(inputSliderItem.displayValue / 1.5, 1.0) * parent.width
                                height: parent.height
                                color: "#f7768e"
                                radius: 3
                            }
                        }

                        Rectangle {
                            id: inputHandle
                            x: Math.min(inputSliderItem.displayValue / 1.5, 1.0) * (parent.width - width)
                            anchors.verticalCenter: parent.verticalCenter
                            width: 18
                            height: 18
                            radius: 9
                            color: inputMouseArea.pressed ? "#ffa0b4" : "#f7768e"
                        }

                        MouseArea {
                            id: inputMouseArea
                            anchors.fill: parent
                            cursorShape: Qt.PointingHandCursor
                            onPressed: (mouse) => updateInputVolume(mouse.x)
                            onPositionChanged: (mouse) => {
                                if (pressed) updateInputVolume(mouse.x)
                            }
                            onReleased: inputSliderItem.displayValue = Qt.binding(() => inputVolume)
                            function updateInputVolume(mouseX) {
                                var newVol = Math.max(0, Math.min(1.5, (mouseX / width) * 1.5))
                                inputSliderItem.displayValue = newVol
                                var proc = Qt.createQmlObject('import Quickshell.Io; Process {}', audioControl)
                                proc.command = ["wpctl", "set-volume", "@DEFAULT_AUDIO_SOURCE@", newVol.toFixed(2)]
                                proc.running = true
                            }
                        }
                    }
                }
            }
        }
    }
}
